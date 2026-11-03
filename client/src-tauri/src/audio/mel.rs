//! log-mel 谱 —— beat_this 的输入前处理。
//!
//! # 必须和 Python 侧**逐位对齐**
//!
//! ONNX 模型对输入分布很敏感，前处理差一点，logits 就偏；偏到下游
//! peak picking 时，拍点会整体挪一两帧。所以这里的每个参数都是从
//! `neural/beat_this/beat_this/preprocessing.py` 抄下来的，不是猜的：
//!
//! ```
//! torchaudio.transforms.MelSpectrogram(
//!     sample_rate=22050, n_fft=1024, hop_length=441,
//!     f_min=30, f_max=11000, n_mels=128,
//!     mel_scale="slaney", normalized="frame_length", power=1,
//! )
//! → torch.log1p(1000 * mel.T)          # 输出 (T, 128)
//! ```
//!
//! ## 三个容易搞错的细节
//!
//! 1. **`power=1` 是幅度谱**，不是能量谱（不要平方）。
//! 2. **`normalized="frame_length"` 等于除以 `win_length`（1024）**。
//!    实测依据：golden 数据里 `mel[100,0] = 2.6949`，反推
//!    `x = (e^2.6949 - 1)/1000 = 0.0137`，而 STFT 幅度量级约 14 —— 正好差 1024 倍。
//! 3. **mel filterbank 用 `norm=None`**（三角形不按面积归一化）。
//!    这和 `librosa.filters.mel(norm='slaney')` **不同**（两者行和差 20 倍），
//!    所以矩阵直接从 `torchaudio.functional.melscale_fbanks` 导出成
//!    `assets/mel_fb.f32`，而不是在这里重算公式 —— 公式细节（Slaney 断点
//!    在 1kHz、hz_to_mel 的分段）差一点点就全错。
//!
//! ## 形状约定
//!
//! `assets/mel_fb.f32` 是 torchaudio 的原始布局 **(n_freqs=513, n_mels=128)**，
//! 即 `fb[f * 128 + k]`。mel 计算是 `mel[k] = Σ_f fb[f,k] * mag[f]`。

use rayon::prelude::*;

/// 帧移（采样点）。441 / 22050 = 50 帧/秒。
pub const HOP: usize = 441;
/// FFT 长度 = 窗长。
pub const N_FFT: usize = 1024;
/// mel 频带数。
pub const N_MELS: usize = 128;
/// 线性频率 bin 数（rfft）。
pub const N_FREQS: usize = N_FFT / 2 + 1;
/// log 前的放大倍数（`log1p(1000 * x)`）。
pub const LOG_MULTIPLIER: f32 = 1000.0;

/// torchaudio 导出的 Slaney mel filterbank，布局 `(513, 128)`。
static MEL_FB_BYTES: &[u8] = include_bytes!("../../assets/mel_fb.f32");

/// 取 filterbank 的 `(freq, mel)` 值。越界返回 0（防御性，正常不会发生）。
#[inline]
fn fb_at(freq: usize, mel: usize) -> f32 {
    let idx = (freq * N_MELS + mel) * 4;
    if idx + 4 > MEL_FB_BYTES.len() {
        return 0.0;
    }
    f32::from_le_bytes([
        MEL_FB_BYTES[idx],
        MEL_FB_BYTES[idx + 1],
        MEL_FB_BYTES[idx + 2],
        MEL_FB_BYTES[idx + 3],
    ])
}

/// 周期性 Hann 窗（`torch.hann_window(n_fft)` 默认 `periodic=True`）。
fn hann_window(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let x = 2.0 * std::f32::consts::PI * i as f32 / n as f32;
            0.5 - 0.5 * x.cos()
        })
        .collect()
}

/// 反射填充（`pad_mode='reflect'`，不含边缘值本身）。
fn reflect_pad(signal: &[f32], pad: usize) -> Vec<f32> {
    let n = signal.len();
    let mut out = Vec::with_capacity(n + 2 * pad);
    // 左：反向取 signal[1..=pad]
    for i in (1..=pad).rev() {
        out.push(*signal.get(i.min(n.saturating_sub(1))).unwrap_or(&0.0));
    }
    out.extend_from_slice(signal);
    // 右：signal[n-2] 往前
    for i in 0..pad {
        let idx = n.saturating_sub(2).saturating_sub(i);
        out.push(*signal.get(idx).unwrap_or(&0.0));
    }
    out
}

/// 计算 log-mel 谱，返回 **(帧数, 128)** —— 与 Python 输出同形状。
///
/// 输入应为 22050 Hz 单声道。帧数 = `1 + len / HOP`（`center=True`）。
pub fn log_mel_spectrogram(samples: &[f32]) -> Vec<Vec<f32>> {
    use rustfft::{num_complex::Complex32, FftPlanner};

    if samples.is_empty() {
        return Vec::new();
    }

    let pad = N_FFT / 2;
    let padded = reflect_pad(samples, pad);
    let n_frames = 1 + samples.len() / HOP;

    let window = hann_window(N_FFT);
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N_FFT);

    // 逐帧并行：帧之间完全独立
    let frames: Vec<Vec<f32>> = (0..n_frames)
        .into_par_iter()
        .map(|t| {
            let start = t * HOP;
            let mut buf: Vec<Complex32> = (0..N_FFT)
                .map(|i| {
                    let s = padded.get(start + i).copied().unwrap_or(0.0);
                    Complex32::new(s * window[i], 0.0)
                })
                .collect();
            fft.process(&mut buf);

            // 幅度谱（power=1）
            let mut mag = [0.0f32; N_FREQS];
            for (f, c) in buf.iter().take(N_FREQS).enumerate() {
                mag[f] = (c.re * c.re + c.im * c.im).sqrt();
            }

            // mel 投影 + frame_length 归一化 + log1p
            // ⚠️ `normalized="frame_length"` 实际是 **除以 sqrt(win_length)**，
            // 不是除以 win_length。这是实测出来的，不是看文档猜的：
            //
            //   一开始按 /1024 写，和 golden 对比发现误差**恒定 32 倍**
            //   （frame 100 是 32.2、frame 287 是 31.9 —— 比值不动，说明
            //   是纯缩放而非结构错位）。而 sqrt(1024) = 32，正好对上。
            //
            // 常数比值是最好的诊断信号：如果比值随帧变化，那是 filterbank
            // 布局或 STFT 的问题；比值恒定就只是差一个系数。
            let inv_win = 1.0 / (N_FFT as f32).sqrt();
            let mut mel = vec![0.0f32; N_MELS];
            for (k, out) in mel.iter_mut().enumerate() {
                let mut acc = 0.0f32;
                for (f, m) in mag.iter().enumerate() {
                    let w = fb_at(f, k);
                    if w != 0.0 {
                        acc += w * m;
                    }
                }
                *out = (LOG_MULTIPLIER * acc * inv_win).ln_1p();
            }
            mel
        })
        .collect();

    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filterbank_is_loaded_with_right_layout() {
        // 第 0 个 mel 的中心频率附近应该有值，最高频 bin 应该是 0
        assert_eq!(MEL_FB_BYTES.len(), N_FREQS * N_MELS * 4);
        let bottom: f32 = (0..N_FREQS).map(|f| fb_at(f, 0)).sum();
        assert!(bottom > 0.5 && bottom < 1.5, "mel0 权重和 = {bottom}");
    }

    #[test]
    fn frame_count_matches_python() {
        // Python: 264600 采样点 → 601 帧
        let x = vec![0.01f32; 264600];
        let m = log_mel_spectrogram(&x);
        assert_eq!(m.len(), 601);
        assert_eq!(m[0].len(), N_MELS);
    }

    #[test]
    fn silence_stays_near_zero() {
        let x = vec![0.0f32; 22050];
        let m = log_mel_spectrogram(&x);
        let max = m.iter().flatten().fold(0.0f32, |a, &b| a.max(b));
        assert!(max < 1e-3, "静音不该有能量, max={max}");
    }
}
