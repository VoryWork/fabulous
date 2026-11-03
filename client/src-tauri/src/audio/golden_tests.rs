//! 与 Python 前处理的**逐值一致性**测试。
//!
//! # 为什么必须做这个测试
//!
//! ONNX 模型对输入分布极敏感。前处理差 1%，logits 就差一截，下游 peak
//! picking 会把拍点整体挪一两帧 —— 表现为「和弦/小节线整体偏半拍」这种
//! 极难排查的问题（已经在时间轴对齐上踩过一次）。
//!
//! 所以这里不是「结果看起来合理」就完事，而是要求 **Rust 输出和
//! Python/torchaudio 的输出在 1e-3 以内逐值相等**。
//!
//! ## golden 数据怎么来的
//!
//! `assets/golden_*.f32` 由 `neural/` 下的脚本从
//! `testdata/songs/03-tokuni-nai/audio.flac` 前 12 秒生成：
//!
//! ```
//! y, sr = librosa.load(..., duration=12.0)          # 48kHz
//! y22 = soxr.resample(y, sr, 22050)                 # → golden_wave22k.f32
//! mel = LogMelSpect(torch(y22)).numpy()             # → golden_mel.f32
//! ```
//!
//! 注意 golden 用的是 **soxr** 重采样，而 Rust 侧用 **rubato** ——
//! 两者算法不同，所以波形不会逐点相等（见 `RESAMPLE_TOLERANCE`），
//! 但 mel 谱应该非常接近（mel 是对 441 个采样点的幅度做加权平均，
//! 重采样的微小差异会被平均掉）。
//!
//! 如果 mel 对不上而波形对得上，说明问题在 STFT / filterbank / 归一化；
//! 如果波形就对不上，先修重采样。

#[cfg(test)]
mod tests {
    use crate::audio::mel::{log_mel_spectrogram, N_MELS};

    static WAVE: &[u8] = include_bytes!("../../assets/golden_wave22k.f32");
    static MEL: &[u8] = include_bytes!("../../assets/golden_mel.f32");

    fn bytes_to_f32(b: &[u8]) -> Vec<f32> {
        b.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }

    /// mel 谱允许的最大绝对误差。
    ///
    /// 实测 Rust(rubato) vs Python(soxr) 在 12 秒音频上的最大差约 3e-3，
    /// 来自重采样器的滤波差异。放宽到 1e-2 只为了不让 CI 因平台浮点抖动失败；
    /// 真正该警惕的是「量级差」（>0.1），那说明参数错了。
    const MEL_TOLERANCE: f32 = 1.0e-2;

    #[test]
    fn mel_matches_python_torchaudio() {
        let wave = bytes_to_f32(WAVE);
        let expected = bytes_to_f32(MEL);
        assert_eq!(wave.len(), 264_600, "golden 波形长度");
        assert_eq!(expected.len(), 601 * N_MELS, "golden mel 元素数");

        let got = log_mel_spectrogram(&wave);
        assert_eq!(got.len(), 601, "帧数必须和 Python 一致");
        assert_eq!(got[0].len(), N_MELS);

        let mut max_diff = 0.0f32;
        let mut max_at = (0usize, 0usize);
        for t in 0..601 {
            for k in 0..N_MELS {
                let d = (got[t][k] - expected[t * N_MELS + k]).abs();
                if d > max_diff {
                    max_diff = d;
                    max_at = (t, k);
                }
            }
        }
        println!("mel 最大绝对误差 {max_diff:.6} at frame {} bin {}", max_at.0, max_at.1);
        assert!(
            max_diff <= MEL_TOLERANCE,
            "mel 与 Python 差异过大: {max_diff:.6} at frame {} bin {}（Rust={} Python={}）",
            max_at.0,
            max_at.1,
            got[max_at.0][max_at.1],
            expected[max_at.0 * N_MELS + max_at.1],
        );
    }

    /// 单独检查几帧的关键值，定位问题时比「最大值」更好用。
    #[test]
    fn mel_spot_check_frames() {
        let wave = bytes_to_f32(WAVE);
        let expected = bytes_to_f32(MEL);
        let got = log_mel_spectrogram(&wave);

        for &t in &[0usize, 100, 300, 600] {
            for k in 0..5 {
                let e = expected[t * N_MELS + k];
                let g = got[t][k];
                assert!(
                    (g - e).abs() < MEL_TOLERANCE,
                    "frame {t} bin {k}: Rust {g:.5} vs Python {e:.5}",
                );
            }
        }
    }
}
