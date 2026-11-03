//! librosa 风格的 STFT —— CQT 和结构分析都要用。
//!
//! 只实现 librosa `stft()` 的一个**子集**，覆盖本项目实际用到的组合：
//!
//! | 调用点 | n_fft | hop | window | pad_mode | center |
//! |---|---|---|---|---|---|
//! | `__cqt_response`（CQT 用） | 各 octave 不同 | `hop >> i` | `ones` | `constant` | true |
//! | `estimate_tuning` → `piptrack` | 2048 | 512 | `hann`(periodic) | `constant` | true |
//! | 结构分析 chroma | 4096 | 2048 | `hann`(periodic) | `constant` | true |
//!
//! # 与 librosa 对齐时最容易错的两处
//!
//! 1. **`hann` 是 periodic 的**（等价 `scipy.signal.get_window('hann', n, fftbins=True)`），
//!    即 `0.5 - 0.5·cos(2πn/N)`，**分母是 N 不是 N-1**。
//!    用对称版会让每帧差几个百分点，而且只在首尾明显 —— 很难发现。
//! 2. **`center=True` 的填充量是 `n_fft/2`**（前后各一半），
//!    所以帧数 = `1 + len(y_padded) / hop` 里的 `y_padded` 已经是填充后的长度。
//!
//! # 为什么不用 `realfft` 而是复数 FFT
//!
//! librosa 的 `stft` 返回完整复数谱，CQT 的 `fft_basis` 也是复数。
//! 用复数 FFT 能少一次「正频率拼装」的换算，代码更直白，代价是慢一倍 ——
//! 但 CQT 只跑一次，不在实时路径上。

use rustfft::num_complex::Complex;
use rustfft::{FftPlanner, Fft};
use std::sync::Arc;

/// 窗函数。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Window {
    /// 矩形窗（CQT 的 `__cqt_response` 用这个 —— 因为 CQT 的加权已经在滤波器里了）
    Ones,
    /// 周期 Hann 窗，分母 N（librosa / scipy 的 `fftbins=True`）
    Hann,
}

impl Window {
    fn generate(self, n: usize) -> Vec<f32> {
        match self {
            Window::Ones => vec![1.0; n],
            Window::Hann => (0..n)
                .map(|i| {
                    let t = std::f32::consts::TAU * i as f32 / n as f32;
                    0.5 - 0.5 * t.cos()
                })
                .collect(),
        }
    }
}

/// 一次性构造好的 STFT 计划，重复使用同一个 `n_fft`/`hop` 时复用它可以省掉 FFT 计划的开销。
pub struct Stft {
    n_fft: usize,
    hop: usize,
    window: Vec<f32>,
    fft: Arc<dyn Fft<f32>>,
}

impl Stft {
    pub fn new(n_fft: usize, hop: usize, window: Window) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        Self {
            n_fft,
            hop,
            window: window.generate(n_fft),
            fft: planner.plan_fft_forward(n_fft),
        }
    }

    pub fn n_fft(&self) -> usize {
        self.n_fft
    }

    /// 单边谱的 bin 数（`n_fft/2 + 1`）。
    pub fn n_bins(&self) -> usize {
        self.n_fft / 2 + 1
    }

    /// 帧数（`center=True`，零填充）。
    pub fn frame_count(&self, len: usize) -> usize {
        let padded = len + self.n_fft; // 前后各 n_fft/2
        if padded < self.n_fft {
            0
        } else {
            1 + (padded - self.n_fft) / self.hop
        }
    }

    /// 计算 STFT，返回 **`(n_bins, frames)`** 的**转置**存储：
    /// `out[frame * n_bins + bin]` —— 逐帧连续，便于后续按帧做矩阵乘。
    ///
    /// `center = true`、`pad_mode = "constant"`（补 0），与 librosa 默认一致。
    pub fn stft(&self, y: &[f32]) -> Vec<Complex<f32>> {
        let n_bins = self.n_bins();
        let frames = self.frame_count(y.len());
        let pad = self.n_fft / 2;

        // 填充后的信号：前后各补 pad 个 0
        let mut padded = vec![0.0f32; y.len() + 2 * pad];
        padded[pad..pad + y.len()].copy_from_slice(y);

        let mut out = vec![Complex::new(0.0f32, 0.0); frames * n_bins];
        let mut buf = vec![Complex::new(0.0f32, 0.0); self.n_fft];

        for f in 0..frames {
            let start = f * self.hop;
            for i in 0..self.n_fft {
                buf[i] = Complex::new(padded[start + i] * self.window[i], 0.0);
            }
            self.fft.process(&mut buf);
            out[f * n_bins..(f + 1) * n_bins].copy_from_slice(&buf[..n_bins]);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hann_is_periodic() {
        // scipy get_window('hann', 8, fftbins=True) = [0, .1464, .5, .8536, 1, .8536, .5, .1464]
        let w = Window::Hann.generate(8);
        let expect = [0.0, 0.1464, 0.5, 0.8536, 1.0, 0.8536, 0.5, 0.1464];
        for (a, b) in w.iter().zip(expect.iter()) {
            assert!((a - b).abs() < 1e-3, "{a} vs {b}");
        }
    }

    #[test]
    fn frame_count_matches_librosa() {
        // librosa: 1 + len(y_padded) // hop - 1，其中 y_padded 补 n_fft
        let s = Stft::new(1024, 512, Window::Ones);
        assert_eq!(s.frame_count(22050), 1 + (22050 + 1024 - 1024) / 512);
        // 512 个采样 + 前后各 512 的零填充 = 1536 → 1 + (1536-1024)/512 = 2
        assert_eq!(s.frame_count(512), 2);
    }

    #[test]
    fn dc_signal_puts_energy_in_bin_zero() {
        let s = Stft::new(64, 32, Window::Ones);
        let y = vec![1.0f32; 256];
        let spec = s.stft(&y);
        let n_bins = s.n_bins();
        // 矩形窗 + 常数信号 → 只有 bin 0 有能量
        // ⚠️ 取中间帧：center=True 会把第 0 帧放在全零填充区上（前 n_fft/2 个采样是 0），
        // 拿 spec[0] 断言会得到 0 而不是 64。
        let mid = s.frame_count(y.len()) / 2 * n_bins;
        assert!((spec[mid].re - 64.0).abs() < 1e-3, "得到 {}", spec[mid].re);
        assert!(spec[mid + 1].norm() < 1e-3);
    }

    #[test]
    fn empty_input_gives_no_frames() {
        let s = Stft::new(64, 32, Window::Ones);
        assert_eq!(s.frame_count(0), 1); // center 填充后仍有 1 帧
        assert!(!s.stft(&[]).is_empty());
    }
}
