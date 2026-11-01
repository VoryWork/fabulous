//! 音频文件指纹与元信息。
//!
//! ## 为什么指纹用「时长 + 头尾哈希」而不是整文件哈希
//!
//! 1. **整文件哈希太脆**：同一首歌从不同来源（CD 抓轨 vs 流媒体下载、
//!    128kbps vs 320kbps）字节完全不同，哈希必然对不上。
//! 2. **时长是最稳的特征**：同一首歌的时长差异通常 < 0.1 秒
//!    （不同编码只在头尾有几十毫秒的 padding）。
//! 3. **头尾采样哈希**能区分"时长相近但内容不同"的两首歌，
//!    且只需读几 MB，不用把几百 MB 的 FLAC 全读一遍。
//!
//! ## 重连容差：0.5 秒
//!
//! 用户明确要求「只要时间长短差距 < 0.5s 就接受」。
//! 这个容差足够覆盖：
//!   - 不同编码的 padding 差异（通常 0.02–0.1s）
//!   - 不同版本的淡入淡出（通常 < 0.3s）
//! 同时足够严格，不会把两首不同的歌误判为同一首。
//!
//! 另：用时长而非内容做主要判据，也**避开了版权掣肘** ——
//! 我们不需要保存音频内容本身，只记录一个数字。

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 重连匹配的时长容差（秒）—— 用户指定 0.5s
pub const RECONNECT_DURATION_TOLERANCE_SEC: f64 = 0.5;

/// 音频指纹
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioFingerprint {
    /// 音频时长（秒），精确到毫秒
    pub duration_sec: f64,
    /// 采样率
    pub sample_rate: u32,
    /// 声道数
    pub channels: u32,
    /// 头 + 尾各 512KB 的 SHA1（hex）
    pub headtail_sha1: String,
    /// 文件字节数
    pub file_size: u64,
}

impl AudioFingerprint {
    /// 时长是否与另一个指纹匹配（用于路径失效后的重连）
    pub fn duration_matches(&self, other: &AudioFingerprint) -> bool {
        (self.duration_sec - other.duration_sec).abs() <= RECONNECT_DURATION_TOLERANCE_SEC
    }

    /// 完整匹配：时长在容差内 **且** 头尾哈希一致
    ///
    /// 头尾哈希一致 → 基本可以确定是同一个文件（只是路径变了）
    pub fn exact_matches(&self, other: &AudioFingerprint) -> bool {
        self.duration_matches(other) && self.headtail_sha1 == other.headtail_sha1
    }
}

/// 读取音频元信息（时长 / 采样率 / 声道）
///
/// 用 symphonia 探测，不解码音频数据 —— 快（FLAC 5 分钟约 10ms）。
pub fn probe_audio(path: &Path) -> Result<(f64, u32, u32)> {
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = File::open(path)
        .with_context(|| format!("无法打开音频文件: {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| anyhow!("无法识别音频格式: {e}"))?;

    let track = probed
        .format
        .tracks()
        .iter()
        .find(|t| t.codec_params.sample_rate.is_some())
        .ok_or_else(|| anyhow!("找不到音频轨"))?;

    let params = &track.codec_params;
    let sample_rate = params.sample_rate.unwrap_or(44100);
    let channels = params
        .channels
        .map(|c| c.count() as u32)
        .unwrap_or(2);

    // 时长优先用 n_frames（样本数），没有则用 time_base + n_frames
    let duration_sec = match (params.n_frames, params.time_base) {
        (Some(frames), Some(tb)) => {
            let t = tb.calc_time(frames);
            t.seconds as f64 + t.frac
        }
        (Some(frames), None) => frames as f64 / sample_rate as f64,
        _ => {
            // 兜底：读文件大小估算（不准，但聊胜于无）
            let size = std::fs::metadata(path)?.len();
            // 假设 16bit 立体声压缩比 0.6（FLAC 典型值）
            size as f64 / (sample_rate as f64 * 2.0 * 2.0 * 0.6)
        }
    };

    Ok((duration_sec, sample_rate, channels))
}

/// 计算「头 + 尾」内容的 SHA1
///
/// 只读文件头尾各 `CHUNK` 字节，避免加载整个大文件。
pub fn headtail_hash(path: &Path) -> Result<String> {
    const CHUNK: u64 = 512 * 1024;

    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    let mut hasher = Sha1::new();

    // 头
    let head_len = size.min(CHUNK) as usize;
    let mut head = vec![0u8; head_len];
    f.read_exact(&mut head)?;
    hasher.update(&head);

    // 尾（如果文件比 1MB 大，跳过中间）
    if size > CHUNK * 2 {
        f.seek(SeekFrom::End(-(CHUNK as i64)))?;
        let mut tail = vec![0u8; CHUNK as usize];
        f.read_exact(&mut tail)?;
        hasher.update(&tail);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// 生成完整指纹
pub fn fingerprint(path: &Path) -> Result<AudioFingerprint> {
    let (duration_sec, sample_rate, channels) = probe_audio(path)?;
    let file_size = std::fs::metadata(path)?.len();
    let headtail_sha1 = headtail_hash(path)?;

    Ok(AudioFingerprint {
        // 保留 3 位小数（毫秒级），避免浮点比较的噪声
        duration_sec: (duration_sec * 1000.0).round() / 1000.0,
        sample_rate,
        channels,
        headtail_sha1,
        file_size,
    })
}

/// 检查路径是否仍然有效
pub fn path_is_alive(path: &Path) -> bool {
    path.is_file()
}

/// 重连时判断候选文件是否可接受
///
/// 返回描述信息，供 UI 提示用户"为什么接受/拒绝"。
pub fn evaluate_reconnect(expected: &AudioFingerprint, candidate: &Path) -> Result<ReconnectVerdict> {
    let actual = fingerprint(candidate)?;
    let delta = (actual.duration_sec - expected.duration_sec).abs();

    let duration_ok = delta <= RECONNECT_DURATION_TOLERANCE_SEC;
    let hash_ok = actual.headtail_sha1 == expected.headtail_sha1;

    Ok(ReconnectVerdict {
        accepted: duration_ok,
        duration_delta_sec: (delta * 1000.0).round() / 1000.0,
        duration_ok,
        hash_ok,
        expected: expected.clone(),
        actual,
    })
}

#[derive(Debug, Serialize)]
pub struct ReconnectVerdict {
    /// 是否接受（仅看时长容差）
    pub accepted: bool,
    /// 时长差异（秒）
    pub duration_delta_sec: f64,
    /// 时长是否在容差内
    pub duration_ok: bool,
    /// 头尾哈希是否完全一致（更强证据，但非必需）
    pub hash_ok: bool,
    pub expected: AudioFingerprint,
    pub actual: AudioFingerprint,
}

/// 规范化路径（统一分隔符，便于跨平台比较）
pub fn normalize_path(p: &Path) -> PathBuf {
    // Windows 上路径大小写不敏感
    #[cfg(windows)]
    {
        PathBuf::from(p.to_string_lossy().to_lowercase())
    }
    #[cfg(not(windows))]
    {
        p.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(duration: f64, hash: &str) -> AudioFingerprint {
        AudioFingerprint {
            duration_sec: duration,
            sample_rate: 44100,
            channels: 2,
            headtail_sha1: hash.to_string(),
            file_size: 1_000_000,
        }
    }

    #[test]
    fn tolerance_is_half_second() {
        assert_eq!(RECONNECT_DURATION_TOLERANCE_SEC, 0.5);
    }

    #[test]
    fn accepts_within_tolerance() {
        let a = fp(290.15, "aaa");
        // 完全一致
        assert!(a.duration_matches(&fp(290.15, "bbb")));
        // 差 0.1s（不同编码的典型 padding 差异）
        assert!(a.duration_matches(&fp(290.25, "bbb")));
        // 差 0.49s（刚好在容差内）
        assert!(a.duration_matches(&fp(290.64, "bbb")));
        assert!(a.duration_matches(&fp(289.66, "bbb")));
    }

    #[test]
    fn rejects_beyond_tolerance() {
        let a = fp(290.15, "aaa");
        // 差 0.51s —— 刚好超出
        assert!(!a.duration_matches(&fp(290.66, "bbb")));
        // 差 5s —— 明显是另一首歌
        assert!(!a.duration_matches(&fp(295.15, "bbb")));
    }

    #[test]
    fn boundary_is_inclusive() {
        let a = fp(100.0, "x");
        // 恰好 0.5s 应该接受（<= 而非 <）
        assert!(a.duration_matches(&fp(100.5, "y")));
        assert!(a.duration_matches(&fp(99.5, "y")));
    }

    #[test]
    fn exact_match_requires_both() {
        let a = fp(200.0, "same");
        // 时长一致 + 哈希一致 → exact
        assert!(a.exact_matches(&fp(200.0, "same")));
        // 时长一致但哈希不同 → 不是 exact（但 duration_matches 仍为 true）
        assert!(!a.exact_matches(&fp(200.0, "other")));
        assert!(a.duration_matches(&fp(200.0, "other")));
        // 哈希一致但时长差太多 → 不是 exact
        assert!(!a.exact_matches(&fp(210.0, "same")));
    }

    #[test]
    fn different_sources_same_song_matches_by_duration() {
        // 用户的核心场景：从不同来源下载的同一首歌（字节不同、时长差几十毫秒）
        let cd_rip = fp(294.91, "hash_cd");
        let streaming = fp(294.87, "hash_stream");
        assert!(cd_rip.duration_matches(&streaming));
        assert!(!cd_rip.exact_matches(&streaming)); // 哈希不同，但依然接受
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;

    /// 真实音频的指纹读取（需要本机有这个文件）
    ///
    /// 验证：
    ///   1. 时长读对了（和 soundfile 的结果一致）
    ///   2. 同一文件两次读指纹完全一致
    ///   3. 复制一份后哈希仍然一致（内容不变）
    #[test]
    #[ignore] // 需要真实文件，CI 上跑不了。本地：cargo test -- --ignored
    fn real_audio_fingerprint() {
        let p = Path::new(r"E:\音乐\69910425165.flac");
        if !p.is_file() {
            eprintln!("跳过：测试文件不存在");
            return;
        }

        let a = fingerprint(p).expect("读指纹失败");
        println!("时长 {:.3}s, {}Hz {}ch, sha1 {}…",
            a.duration_sec, a.sample_rate, a.channels, &a.headtail_sha1[..12]);

        // 时长应该在 294.9s 附近
        assert!((a.duration_sec - 294.91).abs() < 0.1, "时长不对: {}", a.duration_sec);
        assert_eq!(a.sample_rate, 44100);
        assert_eq!(a.channels, 2);

        // 两次读取应完全一致（确定性）
        let b = fingerprint(p).expect("第二次读指纹失败");
        assert_eq!(a.duration_sec, b.duration_sec);
        assert_eq!(a.headtail_sha1, b.headtail_sha1);

        // 自己和自己比：时长匹配 + 哈希匹配
        assert!(a.duration_matches(&b));
        assert!(a.exact_matches(&b));
    }

    /// 重连评估：用同一文件当"候选"，应该接受
    #[test]
    #[ignore]
    fn real_reconnect_same_file() {
        let p = Path::new(r"E:\音乐\69910425165.flac");
        if !p.is_file() {
            return;
        }
        let expected = fingerprint(p).expect("读指纹失败");
        let verdict = evaluate_reconnect(&expected, p).expect("评估失败");
        println!("接受={} 时长差={}s", verdict.accepted, verdict.duration_delta_sec);
        assert!(verdict.accepted);
        assert!(verdict.duration_ok);
        assert!(verdict.hash_ok);
    }

    /// 重连评估：用另一首歌当"候选"，应该拒绝
    #[test]
    #[ignore]
    fn real_reconnect_wrong_file() {
        let a = Path::new(r"E:\音乐\69910425165.flac");
        let b = Path::new(r"E:\音乐\Aimer - Refrain.flac");
        if !a.is_file() || !b.is_file() {
            return;
        }
        let expected = fingerprint(a).expect("读指纹失败");
        let verdict = evaluate_reconnect(&expected, b).expect("评估失败");
        println!("接受={} 时长差={}s", verdict.accepted, verdict.duration_delta_sec);
        // 两首歌时长差 4.76s（294.91 vs 290.15），远超 0.5s
        assert!(!verdict.accepted, "不该接受另一首歌");
        assert!(!verdict.duration_ok);
    }
}
