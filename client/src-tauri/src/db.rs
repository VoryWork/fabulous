//! SQLite 数据层。
//!
//! ## 存储策略（与用户确认）
//!
//! - **音频只存原路径 + 指纹**，不复制文件
//! - 路径失效时由前端弹 dialog 让用户重新指定
//! - 匹配容差：**时长差 < 0.5s**（见 `audio_fingerprint`)
//!
//! ## 为什么分析结果同时存 SQLite 和 JSON 文件
//!
//! - **SQLite 是权威**：查询快、有事务、校对状态和用户修改不可重算
//! - **JSON 副本可移植**：用户能备份、能分享、能用 git 管理
//!
//! 两者的关系：
//!   - `analysis_json` 字段存**模型原始输出**（可重算，留作复盘对比）
//!   - SQLite 里的校对状态与用户编辑是**权威数据**（不可重算）
//!
//! 导入 JSON 时：以 JSON 为"模型原始结果"重建，但**保留** SQLite 里的用户校对。

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::audio_fingerprint::AudioFingerprint;

/// 库结构版本，用于将来迁移
const SCHEMA_VERSION: i32 = 1;

/// 一首歌的记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SongRecord {
    pub id: String,
    /// 显示用标题
    pub title: String,
    pub artist: String,
    /// 音频文件当前路径（可能失效）
    pub audio_path: String,
    /// 音频指纹（JSON）
    pub fingerprint: AudioFingerprint,
    /// 分析状态
    pub status: AnalysisStatus,
    /// 最近一次分析时间（ISO8601）
    pub analyzed_at: Option<String>,
    /// 分析失败原因
    pub error: Option<String>,
    /// 创建时间
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisStatus {
    /// 刚导入，还没分析
    Pending,
    /// 分析中
    Running,
    /// 分析完成
    Done,
    /// 分析失败
    Failed,
    /// 音频路径失效，等待用户重新指定
    MissingAudio,
}

impl AnalysisStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::MissingAudio => "missing_audio",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "missing_audio" => Self::MissingAudio,
            _ => Self::Pending,
        }
    }
}

/// 数据库句柄
pub struct Db {
    conn: Connection,
    /// 分析结果 JSON 的存放根目录（`<dataDir>/songs/<id>/`）
    songs_dir: PathBuf,
}

impl Db {
    /// 打开（或创建）数据库
    ///
    /// `data_dir` 是应用数据目录，数据库和每首歌的分析结果都放在这里。
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)
            .with_context(|| format!("无法创建数据目录: {}", data_dir.display()))?;

        let db_path = data_dir.join("musicanaz.db");
        let conn = Connection::open(&db_path)
            .with_context(|| format!("无法打开数据库: {}", db_path.display()))?;

        // WAL 模式：读不阻塞写（前端查列表时后端可以写分析结果）
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        let songs_dir = data_dir.join("songs");
        std::fs::create_dir_all(&songs_dir)?;

        let db = Self { conn, songs_dir };
        db.migrate()?;
        Ok(db)
    }

    /// 建表 / 迁移
    fn migrate(&self) -> Result<()> {
        let current: i32 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);

        if current < 1 {
            self.conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS songs (
                    id           TEXT PRIMARY KEY,
                    title        TEXT NOT NULL,
                    artist       TEXT NOT NULL DEFAULT '',
                    audio_path   TEXT NOT NULL,
                    -- 指纹（JSON）：时长/采样率/声道/头尾哈希/文件大小
                    fingerprint  TEXT NOT NULL,
                    status       TEXT NOT NULL DEFAULT 'pending',
                    analyzed_at  TEXT,
                    error        TEXT,
                    created_at   TEXT NOT NULL
                );

                -- 分析结果（模型原始输出）。与 songs 一对一，单独表是为了
                -- 列表查询时不把几十 KB 的 JSON 一起读出来。
                CREATE TABLE IF NOT EXISTS analyses (
                    song_id       TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
                    -- 模型原始输出（完整 JSON，不与用户修改混合）
                    raw_json      TEXT NOT NULL,
                    -- 用户校对后的覆盖层（只存差异）
                    edits_json    TEXT,
                    updated_at    TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_songs_status ON songs(status);

                PRAGMA user_version = 1;
                "#,
            )?;
        }

        let _ = SCHEMA_VERSION;
        Ok(())
    }

    /// 插入一首歌
    pub fn insert_song(&self, song: &SongRecord) -> Result<()> {
        let fp = serde_json::to_string(&song.fingerprint)?;
        self.conn.execute(
            "INSERT INTO songs (id, title, artist, audio_path, fingerprint, status, analyzed_at, error, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                song.id,
                song.title,
                song.artist,
                song.audio_path,
                fp,
                song.status.as_str(),
                song.analyzed_at,
                song.error,
                song.created_at,
            ],
        )?;
        Ok(())
    }

    /// 列出所有歌
    pub fn list_songs(&self) -> Result<Vec<SongRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, artist, audio_path, fingerprint, status, analyzed_at, error, created_at
             FROM songs ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                let fp: String = r.get(4)?;
                Ok(SongRecord {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    artist: r.get(2)?,
                    audio_path: r.get(3)?,
                    fingerprint: serde_json::from_str(&fp).unwrap_or(AudioFingerprint {
                        duration_sec: 0.0,
                        sample_rate: 0,
                        channels: 0,
                        headtail_sha1: String::new(),
                        file_size: 0,
                    }),
                    status: AnalysisStatus::from_str(&r.get::<_, String>(5)?),
                    analyzed_at: r.get(6)?,
                    error: r.get(7)?,
                    created_at: r.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 取单首歌
    pub fn get_song(&self, id: &str) -> Result<Option<SongRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, artist, audio_path, fingerprint, status, analyzed_at, error, created_at
             FROM songs WHERE id = ?1",
        )?;
        let row = stmt
            .query_row([id], |r| {
                let fp: String = r.get(4)?;
                Ok(SongRecord {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    artist: r.get(2)?,
                    audio_path: r.get(3)?,
                    fingerprint: serde_json::from_str(&fp).unwrap_or(AudioFingerprint {
                        duration_sec: 0.0,
                        sample_rate: 0,
                        channels: 0,
                        headtail_sha1: String::new(),
                        file_size: 0,
                    }),
                    status: AnalysisStatus::from_str(&r.get::<_, String>(5)?),
                    analyzed_at: r.get(6)?,
                    error: r.get(7)?,
                    created_at: r.get(8)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    /// 更新音频路径（重连成功后）
    pub fn update_audio_path(
        &self,
        id: &str,
        path: &str,
        fingerprint: &AudioFingerprint,
    ) -> Result<()> {
        let fp = serde_json::to_string(fingerprint)?;
        self.conn.execute(
            "UPDATE songs SET audio_path = ?1, fingerprint = ?2, status = 'done', error = NULL
             WHERE id = ?3",
            params![path, fp, id],
        )?;
        Ok(())
    }

    /// 更新状态
    pub fn set_status(&self, id: &str, status: AnalysisStatus, error: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE songs SET status = ?1, error = ?2 WHERE id = ?3",
            params![status.as_str(), error, id],
        )?;
        Ok(())
    }

    /// 保存分析结果
    ///
    /// 同时写 SQLite 和分析结果 JSON 文件（可移植副本）。
    pub fn save_analysis(&self, id: &str, raw_json: &str) -> Result<()> {
        let now = chrono::Local::now().to_rfc3339();

        self.conn.execute(
            "INSERT INTO analyses (song_id, raw_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(song_id) DO UPDATE SET raw_json = ?2, updated_at = ?3",
            params![id, raw_json, now],
        )?;

        self.conn.execute(
            "UPDATE songs SET status = 'done', analyzed_at = ?1, error = NULL WHERE id = ?2",
            params![now, id],
        )?;

        // 可移植副本
        let dir = self.songs_dir.join(id);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("analysis.json"), raw_json)?;

        Ok(())
    }

    /// 读分析结果（优先读 SQLite，缺失时回退到 JSON 文件）
    pub fn load_analysis(&self, id: &str) -> Result<Option<String>> {
        let from_db: Option<String> = self
            .conn
            .query_row("SELECT raw_json FROM analyses WHERE song_id = ?1", [id], |r| r.get(0))
            .optional()?;

        if from_db.is_some() {
            return Ok(from_db);
        }

        // 回退：JSON 文件（数据库被重建过的情况下还能恢复）
        let file = self.songs_dir.join(id).join("analysis.json");
        if file.is_file() {
            return Ok(Some(std::fs::read_to_string(file)?));
        }
        Ok(None)
    }

    /// 保存用户编辑层（调性覆盖、额外级数轨等）。
    ///
    /// ## 为什么不塞进 `raw_json`
    ///
    /// `raw_json` 是**模型原始输出**，重新分析时会整份覆盖。用户的判断
    /// （「这首歌是 F# 小调」「再加一条 A 大调对照轨」）放进去就等于
    /// 每分析一次清一次，而且数据来源也说不清。
    ///
    /// 所以单独存 `edits_json`：结构上就是"覆盖在模型结果之上的一层"，
    /// 分析重跑不影响它，用户清空它也不影响分析结果。
    ///
    /// ## 可移植副本
    ///
    /// 同时写一份 `songs/<id>/edits.json`，和 analysis.json 并列 ——
    /// 删掉数据库重建时还能恢复，也让"一首歌的所有信息"都在同一个目录里。
    pub fn save_edits(&self, id: &str, edits_json: &str) -> Result<()> {
        // ## 内容没变就直接返回（省磁盘写入）
        //
        // 一次写入要落两处（SQLite 页 + edits.json 文件），每次都是整份快照。
        // 前端已经做了「拖动中不报 + 1.2s 防抖 + 内容去重」三道闸，
        // 这里再兜一层：**任何**漏网的重复调用都不会产生实际写入。
        //
        // 这也让「切歌/隐藏时强制刷盘」变便宜 —— 那种调用大多数时候是空转。
        let existing: Option<Option<String>> = self
            .conn
            .query_row(
                "SELECT edits_json FROM analyses WHERE song_id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(Some(prev)) = &existing {
            if prev == edits_json {
                return Ok(());
            }
        }

        let now = chrono::Local::now().to_rfc3339();

        // 这一行的 deleted 状态一并清掉：用户改过东西说明还要用它，
        // 不能因为之前被标记为"已删除"就把编辑层压下去
        self.conn.execute(
            "UPDATE analyses SET edits_json = ?1, updated_at = ?2 WHERE song_id = ?3",
            params![edits_json, now, id],
        )?;

        let dir = self.songs_dir.join(id);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("edits.json"), edits_json)?;
        Ok(())
    }

    /// 读用户编辑层（优先 SQLite，缺失时回退到 JSON 文件）
    pub fn load_edits(&self, id: &str) -> Result<Option<String>> {
        let from_db: Option<Option<String>> = self
            .conn
            .query_row(
                "SELECT edits_json FROM analyses WHERE song_id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;

        if let Some(Some(v)) = from_db {
            if !v.is_empty() {
                return Ok(Some(v));
            }
        }

        let file = self.songs_dir.join(id).join("edits.json");
        if file.is_file() {
            return Ok(Some(std::fs::read_to_string(file)?));
        }
        Ok(None)
    }

    /// 删除一首歌（连带分析结果）
    pub fn delete_song(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM songs WHERE id = ?1", [id])?;
        let dir = self.songs_dir.join(id);
        if dir.exists() {
            let _ = std::fs::remove_dir_all(dir);
        }
        Ok(())
    }

    /// 检查所有歌的音频路径，标记失效的
    ///
    /// 启动时调用，让前端能提示用户"有 N 首歌的音频找不到"。
    pub fn scan_missing_audio(&self) -> Result<Vec<String>> {
        let songs = self.list_songs()?;
        let mut missing = Vec::new();
        for s in &songs {
            if !crate::audio_fingerprint::path_is_alive(Path::new(&s.audio_path)) {
                self.set_status(&s.id, AnalysisStatus::MissingAudio, None)?;
                missing.push(s.id.clone());
            }
        }
        Ok(missing)
    }
}
