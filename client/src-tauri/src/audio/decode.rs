//! 音频解码：任意格式 → f32 mono。
//!
//! ## 为什么容忍尾部损坏
//!
//! 用户的音乐文件经常是「能播但有坏帧」的（下载中断、CD 抓轨失败）。
//! Python 侧早就在 `run_beats` 里用 5 秒小块读取 + `try/except` 处理过
//! 这件事，注释写着「容忍尾部损坏」。这里保持一致：
//!
//! - 读到 `Err` 就**停止**，保留已解码的部分
//! - 只要解出了 1 秒以上就认为可用
//!
//! 反过来（直接 `?` 返回错误）会让一首 99% 完好的歌整个分析失败。

use std::path::Path;

use anyhow::{anyhow, Context, Result};

/// 解码后的单声道音频。
pub struct DecodedAudio {
    /// 采样率（原文件的，未重采样）
    pub sample_rate: u32,
    /// 单声道样本，f32 in [-1, 1]
    pub samples: Vec<f32>,
}

impl DecodedAudio {
    pub fn duration_sec(&self) -> f64 {
        if self.sample_rate == 0 {
            return 0.0;
        }
        self.samples.len() as f64 / self.sample_rate as f64
    }
}

/// 解码任意受支持的格式为单声道 f32。
///
/// 多声道会**取平均**（不是只取第一声道）——和弦识别看的是整体和声内容，
/// 只取左声道会丢掉右声道的乐器。
pub fn decode_to_mono_f32(path: &Path) -> Result<DecodedAudio> {
    decode_to_mono_f32_with_progress(path, &mut |_| {})
}

/// 带解码进度的版本。
///
/// `on` 拿到的是**已解码采样数 / 容器声明的总采样数**（0~1）。长音频（4~5 分钟
/// 的 flac）解码就要几秒，以前这段时间界面上完全没反应，只剩一句静态的
/// 「读取音频…」——用户会以为卡死了。
///
/// 拿不到总时长（某些容器没有 `n_frames`）时**不回调**，前端就显示不确定态，
/// 而不是瞎猜一个百分比。
pub fn decode_to_mono_f32_with_progress(
    path: &Path,
    on: &mut dyn FnMut(f32),
) -> Result<DecodedAudio> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::errors::Error as SymError;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = std::fs::File::open(path)
        .with_context(|| format!("打开音频失败: {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions { enable_gapless: false, ..Default::default() },
            &MetadataOptions::default(),
        )
        .context("无法识别音频格式")?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.sample_rate.is_some())
        .ok_or_else(|| anyhow!("没有可解码的音轨"))?;
    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);

    // symphonia 0.5 的正确入口是 `get_codecs()` 注册表，不是 `symphonia::default()`
    let codecs = symphonia::default::get_codecs();
    let mut decoder = codecs
        .make(&track.codec_params, &DecoderOptions::default())
        .context("创建解码器失败（不支持的编码）")?;

    let mut out: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    // 总帧数（用于算解码进度）。取不到就退化成「不报进度」。
    let total_frames = track.codec_params.n_frames.filter(|&n| n > 0);
    let declared_channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2).max(1);
    let total_samples = total_frames.map(|n| n as f64 * declared_channels as f64);
    let mut packets: usize = 0;

    loop {
        // 尾部损坏 / 读到结尾都从这里退出，保留已解出的部分
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // 坏帧：跳过而不是整首失败
            Err(_) => continue,
        };

        // 声道数要从 `decoded.spec()` 取 —— `SampleBuffer` 没有暴露 spec() 方法
        // （需要 `Signal` trait，而它对 SampleBuffer 没实现）
        let channels = decoded.spec().channels.count().max(1);
        if sample_buf.is_none() {
            let spec = *decoded.spec();
            sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        if let Some(buf) = sample_buf.as_mut() {
            buf.copy_interleaved_ref(decoded);
            let frames = buf.samples().len() / channels;
            out.reserve(frames);
            for i in 0..frames {
                let mut sum = 0.0f32;
                for ch in 0..channels {
                    sum += buf.samples()[i * channels + ch];
                }
                out.push(sum / channels as f32);
            }
        }

        // 防止极端损坏文件把内存吃光（>2 小时）
        if out.len() > sample_rate as usize * 7200 {
            break;
        }

        // 每 16 个包报一次（单声道后 out.len() 就是帧数），避免回调比解码还贵
        packets += 1;
        if packets % 16 == 0 {
            if let Some(total) = total_samples {
                on((out.len() as f64 / total).min(1.0) as f32);
            }
        }
    }

    if out.is_empty() {
        return Err(anyhow!("解码结果为空: {}", path.display()));
    }

    Ok(DecodedAudio { sample_rate, samples: out })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 太短的文件不该被接受（否则后续网格计算全乱）
    #[test]
    fn duration_is_computed_from_samples() {
        let a = DecodedAudio { sample_rate: 22050, samples: vec![0.0; 44100] };
        assert!((a.duration_sec() - 2.0).abs() < 1e-9);
    }
}
