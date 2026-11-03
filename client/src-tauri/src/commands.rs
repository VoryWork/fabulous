//! Tauri 命令：导入、分析、重连、读取。
//!
//! ## 自动分析流程
//!
//! ```text
//! 用户点「添加音乐」
//!   → pick_audio()        选文件（返回路径，不复制）
//!   → import_audio(path)  读指纹 + 建 DB 记录（status=pending）
//!   → analyze_song(id)    启动分析（异步，进度用 emit 推到前端）
//!   → save_analysis       写 SQLite + songs/<id>/analysis.json
//! ```
//!
//! ## 路径失效重连
//!
//! ```text
//! 启动时 scan_missing()
//!   → 前端发现 status = missing_audio
//!   → 弹 dialog 让用户选新文件
//!   → evaluate_reconnect(id, newPath)   时长差 < 0.5s 才接受
//!   → 接受后 update_audio_path
//! ```

use crate::analyzer::{AnalysisProgress, Analyzer};
use crate::audio_fingerprint::{evaluate_reconnect, fingerprint, AudioFingerprint, ReconnectVerdict};
use crate::db::{AnalysisStatus, Db, SongRecord};
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// 取数据库锁（简化调用处的样板代码）
fn db<'a>(state: &'a State<'_, AppState>) -> std::sync::MutexGuard<'a, Db> {
    state.db.lock().expect("数据库锁被污染")
}

/// 从 Arc<Mutex<Db>> 取锁（给 spawn_blocking 里用）
fn db_of(arc: &Arc<Mutex<Db>>) -> std::sync::MutexGuard<'_, Db> {
    arc.lock().expect("数据库锁被污染")
}

/// 应用状态
pub struct AppState {
    /// rusqlite::Connection 是 Send 但不是 Sync，必须包 Mutex 才能放进 State。
    /// 外面再包 Arc 是为了 clone 进 `spawn_blocking`（需要 'static）。
    pub db: Arc<Mutex<Db>>,
    pub analyzer: Arc<Option<Box<dyn Analyzer>>>,
    /// 正在分析中的歌曲 id（防止重复启动）
    pub running: Arc<Mutex<Vec<String>>>,
}

/// 前端用的歌单条目（扁平，便于列表渲染）
#[derive(Debug, Clone, Serialize)]
pub struct SongListItem {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub audio_path: String,
    pub duration_sec: f64,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
    /// 音频路径是否还有效
    pub audio_alive: bool,
}

fn to_list_item(s: &SongRecord) -> SongListItem {
    SongListItem {
        id: s.id.clone(),
        title: s.title.clone(),
        artist: s.artist.clone(),
        audio_path: s.audio_path.clone(),
        duration_sec: s.fingerprint.duration_sec,
        status: format!("{:?}", s.status).to_lowercase(),
        error: s.error.clone(),
        created_at: s.created_at.clone(),
        audio_alive: std::path::Path::new(&s.audio_path).is_file(),
    }
}

// ---------------------------------------------------------------- 导入

/// 导入一首歌（只记路径 + 指纹，不复制文件）
///
/// 返回歌曲 id。导入后不会自动分析 —— 由前端决定是否立刻调用 `analyze_song`。
#[tauri::command]
pub fn import_audio(state: State<'_, AppState>, path: String) -> Result<SongListItem, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("文件不存在: {path}"));
    }

    // 读指纹（时长/采样率/头尾哈希）
    let fp = fingerprint(&p).map_err(|e| format!("无法读取音频信息: {e}"))?;

    // 标题/艺术家：从文件名拆 "Artist - Title"
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名")
        .to_string();
    let (artist, title) = match stem.split_once(" - ") {
        Some((a, t)) => (a.trim().to_string(), t.trim().to_string()),
        None => (String::new(), stem),
    };

    // 去重：同一路径已导入则直接返回
    if let Ok(songs) = db(&state).list_songs() {
        if let Some(existing) = songs.iter().find(|s| {
            crate::audio_fingerprint::normalize_path(std::path::Path::new(&s.audio_path))
                == crate::audio_fingerprint::normalize_path(&p)
        }) {
            return Ok(to_list_item(existing));
        }
    }

    let id = format!("song-{}", uuid_like());
    let now = chrono::Local::now().to_rfc3339();

    let rec = SongRecord {
        id: id.clone(),
        title,
        artist,
        audio_path: p.to_string_lossy().to_string(),
        fingerprint: fp,
        status: AnalysisStatus::Pending,
        analyzed_at: None,
        error: None,
        created_at: now,
    };

    db(&state).insert_song(&rec)
        .map_err(|e| format!("写入数据库失败: {e}"))?;

    Ok(to_list_item(&rec))
}

/// 导入 `.fbsong` 工程文件。
///
/// ## 为什么需要它
///
/// `.fbsong` 是「拿到这份文件就能完整还原一首歌」的工程格式（分析结果 +
/// 用户编辑层）。但这个文件**不含音频**（音频是几十 MB 的 flac，不适合
/// 塞进 JSON）。所以导入后：
///
///   - 谱面、和弦、结构、歌词、手改的调性 —— 全部可用
///   - 音频缺失 → 状态标记为 `missing_audio`，列表里显示「音频失效」，
///     点它会弹现有的「重新指定音频」对话框，选一次就能正常播放
///
/// 这条路复用已有的 missing_audio → reconnect 流程，不另造一套。
#[tauri::command]
pub fn import_fbsong(state: State<'_, AppState>, path: String) -> Result<SongListItem, String> {
    let rec = import_fbsong_into(&db(&state), std::path::Path::new(&path))?;
    Ok(to_list_item(&rec))
}

/// `import_fbsong` 的实体（不依赖 Tauri State，便于单测）。
fn import_fbsong_into(db: &Db, path: &std::path::Path) -> Result<SongRecord, String> {
    /// 工程文件比歌词大得多（含完整 analysis），但仍然不该无限读
    const MAX_BYTES: u64 = 64 * 1024 * 1024;

    let p = path.to_path_buf();
    let meta = std::fs::metadata(&p).map_err(|e| format!("无法读取文件信息: {e}"))?;
    if !meta.is_file() {
        return Err("这不是一个文件".into());
    }
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "文件太大（{:.1} MB），不像是 .fbsong 工程文件",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }

    let text = std::fs::read_to_string(&p).map_err(|e| format!("读取失败: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("不是合法的 JSON: {e}"))?;

    if v.get("format").and_then(|f| f.as_str()) != Some("fbsong") {
        return Err("这不是 .fbsong 工程文件（缺少 format 标记）".into());
    }
    let analysis = v
        .get("analysis")
        .ok_or_else(|| "工程文件里没有 analysis 内容".to_string())?;
    if analysis.get("song").is_none() {
        return Err("工程文件里的 analysis 缺少 song 字段".into());
    }

    let song_obj = analysis.get("song");
    let get_str = |k: &str| {
        song_obj
            .and_then(|s| s.get(k))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };
    let title = {
        let t = get_str("title");
        if t.is_empty() { "未命名（工程导入）".to_string() } else { t }
    };
    let artist = get_str("artist");
    let duration = song_obj
        .and_then(|s| s.get("durationSec"))
        .and_then(|d| d.as_f64())
        .unwrap_or(0.0);

    let id = format!("song-{}", uuid_like());
    let now = chrono::Local::now().to_rfc3339();

    let rec = SongRecord {
        id: id.clone(),
        title,
        artist,
        // 工程文件不含音频：留空 → scan_missing_audio 会把它标成 missing_audio，
        // 用户可以走已有的「重新指定音频」流程补上
        audio_path: String::new(),
        fingerprint: AudioFingerprint {
            duration_sec: duration,
            sample_rate: 0,
            channels: 0,
            headtail_sha1: String::new(),
            file_size: 0,
        },
        status: AnalysisStatus::MissingAudio,
        analyzed_at: Some(now.clone()),
        error: None,
        created_at: now,
    };

    {
        db.insert_song(&rec)
            .map_err(|e| format!("写入数据库失败: {e}"))?;
        // 存 analysis 子对象（不是整个 bundle）—— 前端 load_analysis 期望的
        // 就是 analysis.json 的格式，多包一层会让解析全错
        db.save_analysis(&id, &analysis.to_string())
            .map_err(|e| format!("写入分析结果失败: {e}"))?;
        if let Some(edits) = v.get("edits") {
            if !edits.is_null() {
                db.save_edits(&id, &edits.to_string())
                    .map_err(|e| format!("写入编辑层失败: {e}"))?;
            }
        }
        // save_analysis 会把状态置成 done，这里改回 missing_audio
        let _ = db.set_status(&id, AnalysisStatus::MissingAudio, None);
    }

    Ok(rec)
}

// ---------------------------------------------------------------- 分析

/// 分析一首歌（**异步命令**）
///
/// ## 为什么必须 async
///
/// Tauri 的**同步命令在主线程执行** —— 一次分析要 30 秒（含 demucs 源分离），
/// 期间整个窗口会无响应（按钮点不动、拖不动、连关闭都可能卡）。
///
/// 改成 `async fn` + `spawn_blocking` 后：
///   - 命令本身立刻返回 Future，主线程不被占用
///   - 真正的 CPU/GPU 工作跑在 tokio 的 blocking 线程池里
///   - 进度通过 `analysis:progress` 事件推送，UI 全程可交互
///
/// 注意 `State<'_, AppState>` 的生命周期绑在命令上，不能直接 move 进
/// `spawn_blocking`，所以要先把里面的 `Arc` clone 出来。
#[tauri::command]
pub async fn analyze_song(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    // 先做同步的前置检查（快，不阻塞）
    let song = db(&state)
        .get_song(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("找不到歌曲 {id}"))?;

    // 防重复启动
    {
        let mut running = state.running.lock().map_err(|e| e.to_string())?;
        if running.contains(&id) {
            return Err("这首歌正在分析中".into());
        }
        running.push(id.clone());
    }

    // clone 出 'static 的句柄
    let db_arc = state.db.clone();
    let analyzer_arc = state.analyzer.clone();
    let running_arc = state.running.clone();
    let app2 = app.clone();
    let id2 = id.clone();

    // spawn_blocking 需要 'static，所以 clone 一份给闭包
    let db_for_task = db_arc.clone();
    let analyzer_for_task = analyzer_arc.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        run_analysis_blocking(&app2, &db_for_task, &analyzer_for_task, &song)
    });

    // 任务本身 panic 也要落状态：否则前端只显示「失败」，
    // 而 DB 里 status 还是 done、error 是 NULL —— 无从排查。
    // （`?` 会直接返回，跳过下面的 set_status 分支）
    let result = match handle.await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("分析任务异常: {e}");
            if let Ok(guard) = db_arc.lock() {
                let _ = guard.set_status(&id2, AnalysisStatus::Failed, Some(&msg));
            }
            if let Ok(mut running) = running_arc.lock() {
                running.retain(|x| x != &id2);
            }
            app.emit(
                "analysis:failed",
                serde_json::json!({ "id": id, "error": msg }),
            )
            .ok();
            return Err(msg);
        }
    };

    // 清理 running 标记
    if let Ok(mut running) = running_arc.lock() {
        running.retain(|x| x != &id2);
    }

    match result {
        Ok(()) => {
            app.emit("analysis:done", serde_json::json!({ "id": id }))
                .ok();
            Ok(())
        }
        Err(e) => {
            let msg = format!("{e}");
            if let Ok(guard) = db_arc.lock() {
                let _ = guard.set_status(&id2, AnalysisStatus::Failed, Some(&msg));
            }
            app.emit(
                "analysis:failed",
                serde_json::json!({ "id": id, "error": msg }),
            )
            .ok();
            Err(msg)
        }
    }
}

/// 实际的分析执行（同步，跑在 blocking 线程）
fn run_analysis_blocking(
    app: &AppHandle,
    db_arc: &Arc<Mutex<Db>>,
    analyzer_arc: &Arc<Option<Box<dyn Analyzer>>>,
    song: &SongRecord,
) -> Result<()> {
    let audio = PathBuf::from(&song.audio_path);
    if !audio.is_file() {
        db_of(db_arc).set_status(&song.id, AnalysisStatus::MissingAudio, None)?;
        return Err(anyhow!("音频文件已失效: {}", song.audio_path));
    }

    let analyzer = analyzer_arc
        .as_ref()
        .as_ref()
        .ok_or_else(|| anyhow!("未配置分析引擎（生产版应提供 ONNX 引擎）"))?;

    db_of(db_arc).set_status(&song.id, AnalysisStatus::Running, None)?;

    let song_id = song.id.clone();
    let app2 = app.clone();

    let mut on_progress = |p: AnalysisProgress| {
        // 阶段性结果走独立事件名：前端可以就地更新谱面，
        // 不用去翻「这条进度到底带没带数据」。
        if let Some(json) = p.partial_json {
            app2.emit(
                "analysis:partial",
                serde_json::json!({
                    "id": song_id,
                    "stage": p.stage,
                    "json": json,
                }),
            )
            .ok();
            return;
        }
        app2.emit(
            "analysis:progress",
            serde_json::json!({
                "id": song_id,
                "stage": p.stage,
                "pct": p.pct,
                "message": p.message,
            }),
        )
        .ok();
    };

    let out = analyzer.analyze(&audio, &mut on_progress)?;

    db_of(db_arc).save_analysis(&song.id, &out.json)?;
    Ok(())
}

// ---------------------------------------------------------------- 读取

#[tauri::command]
pub fn list_songs(state: State<'_, AppState>) -> Result<Vec<SongListItem>, String> {
    let songs = db(&state).list_songs().map_err(|e| e.to_string())?;
    Ok(songs.iter().map(to_list_item).collect())
}

/// 读某首歌的分析结果（JSON 字符串，前端直接 parse）
#[tauri::command]
pub fn load_analysis(state: State<'_, AppState>, id: String) -> Result<Option<String>, String> {
    db(&state).load_analysis(&id).map_err(|e| e.to_string())
}

/// 保存用户编辑层（调性覆盖 / 额外级数轨）。
///
/// 和 `raw_json` 分开存：那是模型产物，重新分析会整个覆盖；
/// 这里是用户的判断，必须活得比分析结果长。
#[tauri::command]
pub fn save_edits(state: State<'_, AppState>, id: String, edits: String) -> Result<(), String> {
    db(&state).save_edits(&id, &edits).map_err(|e| e.to_string())
}

/// 读用户编辑层。没有时返回 None（前端用默认值）。
#[tauri::command]
pub fn load_edits(state: State<'_, AppState>, id: String) -> Result<Option<String>, String> {
    db(&state).load_edits(&id).map_err(|e| e.to_string())
}

/// 取某首歌的音频**绝对路径**（前端用 `convertFileSrc` 转成可播放 URL）。
///
/// ## 为什么不直接返回 URL
///
/// WebView 里 `file:///E:/音乐/xx.flac` 会被拦（跨协议），必须走 Tauri 的
/// asset 协议。转 URL 的事交给前端的 `convertFileSrc` —— 它知道当前平台
/// 该用 `asset://localhost/...` 还是 `http://asset.localhost/...`，
/// 在 Rust 里手拼容易拼错（尤其是 Windows 盘符和中文路径的编码）。
///
/// ## 为什么放在 Rust 侧做
///
/// 前端手里只有 `id`。曲库列表里虽然也带 `audio_path`，但那一份可能是旧的
/// （重连换过路径）。统一由后端按 id 取**当前**路径，保证「切歌 → 加载音频」
/// 用的永远是数据库里的真值。
///
/// 返回 `None` 表示这首歌没有可用音频（文件已移动/删除），前端应回退静音模式。
#[tauri::command]
pub fn song_audio_path(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    let path = db(&state)
        .get_song(&id)
        .map_err(|e| e.to_string())?
        .map(|s| s.audio_path)
        .ok_or_else(|| format!("找不到歌曲 {id}"))?;

    // 文件不在了就别给前端一个必然失败的 URL
    if !std::path::Path::new(&path).is_file() {
        return Ok(None);
    }
    Ok(Some(path))
}
#[tauri::command]
pub fn delete_song(state: State<'_, AppState>, id: String) -> Result<(), String> {
    db(&state).delete_song(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- 路径失效与重连

/// 启动时扫描：哪些歌的音频找不到了
#[tauri::command]
pub fn scan_missing_audio(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    db(&state).scan_missing_audio().map_err(|e| e.to_string())
}

/// 取某首歌的指纹（重连 dialog 里显示"原文件时长"用）
#[tauri::command]
pub fn get_fingerprint(state: State<'_, AppState>, id: String) -> Result<AudioFingerprint, String> {
    db(&state).get_song(&id)
        .map_err(|e| e.to_string())?
        .map(|s| s.fingerprint)
        .ok_or_else(|| format!("找不到歌曲 {id}"))
}

/// 评估候选文件能否作为某首歌的新音频
///
/// **只判时长容差（0.5s）**，见 `audio_fingerprint` 的说明。
/// 返回详细对比，供前端 dialog 展示。
#[tauri::command]
pub fn evaluate_reconnect_candidate(
    state: State<'_, AppState>,
    id: String,
    candidate_path: String,
) -> Result<ReconnectVerdict, String> {
    let song = db(&state).get_song(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("找不到歌曲 {id}"))?;

    evaluate_reconnect(&song.fingerprint, std::path::Path::new(&candidate_path))
        .map_err(|e| format!("无法读取候选文件: {e}"))
}

/// 确认重连：把音频路径改到新文件
#[tauri::command]
pub fn confirm_reconnect(
    state: State<'_, AppState>,
    id: String,
    candidate_path: String,
) -> Result<(), String> {
    let song = db(&state).get_song(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("找不到歌曲 {id}"))?;

    let verdict = evaluate_reconnect(&song.fingerprint, std::path::Path::new(&candidate_path))
        .map_err(|e| format!("无法读取候选文件: {e}"))?;

    if !verdict.accepted {
        return Err(format!(
            "时长差 {:.2}s 超过 0.5s 容差，拒绝重连",
            verdict.duration_delta_sec
        ));
    }

    db(&state).update_audio_path(&id, &candidate_path, &verdict.actual)
        .map_err(|e| e.to_string())
}

/// 把纯文本写到用户指定的路径（导出用）。
///
/// ## 为什么不装 `plugin-fs`
///
/// 导出只需要「写一个文件」这一件事，为它引入整个 fs 插件（外加一套
/// scope 配置）不划算。路径由前端 `dialog.save()` 拿到 —— 那是用户
/// **亲手选的**位置，不需要再做目录白名单。
///
/// ## 必须建父目录
///
/// 用户可能选一个还没建的子目录（Windows 的保存对话框允许这样做），
/// 直接 `fs::write` 会报「找不到路径」。
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if let Some(dir) = p.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("无法创建目录: {e}"))?;
        }
    }
    std::fs::write(&p, content).map_err(|e| format!("写入失败: {e}"))
}

/// 读一个纯文本文件（歌词导入）。
///
/// 路径来自前端的 `dialog.open()`（用户亲手选的），所以不做目录白名单校验。
///
/// 两道保险：
///   - 超过 `MAX_TEXT_BYTES` 直接拒绝：用户可能误选了一个视频/模型文件，
///     整个读进内存会直接把界面卡死
///   - 非 UTF-8 的按 lossy 解码：老歌词文件常见 GBK，宁可出现几个乱码字符，
///     也不要甩给用户一句「读取失败」
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;

    let p = std::path::PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("无法读取文件信息: {e}"))?;
    if !meta.is_file() {
        return Err("这不是一个文件".into());
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "文件太大（{:.1} MB），不像是歌词文件",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("读取失败: {e}"))?;

    // UTF-8 优先；不是 UTF-8 时用有损解码，让用户仍能看到内容
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    Ok(text)
}

// ---------------------------------------------------------------- 内部工具

/// 生成一个短随机 id（不引 uuid crate，减少依赖）
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一份最小的合法 .fbsong（analysis 只放导入路径真正读的几个字段）
    fn write_sample(dir: &std::path::Path) -> std::path::PathBuf {
        let bundle = serde_json::json!({
            "format": "fbsong",
            "version": 1,
            "exportedAt": "2026-01-01T00:00:00Z",
            "analysis": {
                "song": { "title": "导入测试曲", "artist": "某歌手", "durationSec": 233.5 },
                "downbeatsSec": [0.0, 2.0, 4.0],
                "beatsSec": [0.0, 0.5, 1.0, 1.5],
                "chords": { "submission": [
                    { "start": 0.0, "end": 2.0, "chord": "G:maj" }
                ] },
                "meta": { "beatsPerBar": 4, "meter": { "numerator": 4, "denominator": 4 } }
            },
            "edits": {
                "lyricTracks": [{
                    "id": "lyr-1",
                    "name": "歌词",
                    "clips": [{ "id": "ly-0", "startTick": 0, "endTick": 3840, "text": "第一句" }]
                }]
            }
        });
        let path = dir.join("sample.fbsong");
        std::fs::write(&path, serde_json::to_string_pretty(&bundle).unwrap()).unwrap();
        path
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "musicanaz-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn fbsong_import_restores_analysis_and_edits() {
        let dir = temp_dir("fbsong");
        let file = write_sample(&dir);
        let db = Db::open(&dir).unwrap();

        let rec = import_fbsong_into(&db, &file).expect("导入应成功");

        // 标题 / 时长来自 analysis.song
        assert_eq!(rec.title, "导入测试曲");
        assert_eq!(rec.artist, "某歌手");
        assert!((rec.fingerprint.duration_sec - 233.5).abs() < 1e-6);
        // 工程文件不含音频 → 必须标 missing_audio，前端才能提示「音频失效」
        assert_eq!(rec.status, AnalysisStatus::MissingAudio);
        assert!(rec.audio_path.is_empty());

        // 分析结果落库：**存的必须是 analysis 子对象**（多包一层 layer 前端就解析不了）
        let raw = db.load_analysis(&rec.id).unwrap().expect("分析结果应已写入");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(v.get("song").is_some());
        assert!(v.get("format").is_none(), "不应该把整个 bundle 塞进去");
        assert_eq!(v["downbeatsSec"].as_array().unwrap().len(), 3);

        // 编辑层（歌词）也要一起回来
        let edits = db.load_edits(&rec.id).unwrap().expect("编辑层应已写入");
        assert!(edits.contains("lyricTracks"));
        assert!(edits.contains("第一句"));

        // 可移植副本
        assert!(dir.join("songs").join(&rec.id).join("analysis.json").is_file());
        assert!(dir.join("songs").join(&rec.id).join("edits.json").is_file());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_fbsong_json() {
        let dir = temp_dir("fbsong-bad");
        let file = dir.join("x.json");
        std::fs::write(&file, r#"{"format":"something-else","analysis":{}}"#).unwrap();
        let db = Db::open(&dir).unwrap();

        let err = import_fbsong_into(&db, &file).unwrap_err();
        assert!(err.contains("fbsong"), "错误信息应指明这不是工程文件: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_malformed_json() {
        let dir = temp_dir("fbsong-broken");
        let file = dir.join("broken.fbsong");
        std::fs::write(&file, "{ not json").unwrap();
        let db = Db::open(&dir).unwrap();

        let err = import_fbsong_into(&db, &file).unwrap_err();
        assert!(err.contains("JSON"), "应提示 JSON 解析失败: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
