//! 音准估计 —— `librosa.estimate_tuning` 的 Rust 移植。
//!
//! # 为什么需要它
//!
//! `analyze_song.py` 调 `hybrid_cqt(..., tuning=None)`，librosa 收到 `None` 会
//! **自己估一个全局音准偏差**，并用它微调 `fmin`：
//!
//! ```text
//! fmin = F#0 · 2^(tuning / 36)
//! ```
//!
//! 实测两首歌的 tuning 是 `+0.07` 和 `-0.17`（单位 = 1/36 octave，即
//! +2.3 音分 / −5.7 音分）。看着很小，但**实测会改变 5% 的帧的 chord 判定**
//! （同一个 12 秒片段，tuning=0 vs −0.17 的逐帧 argmax 一致率只有 95.2%）。
//! 所以不能简单地固定成 0。
//!
//! # 算法（三段）
//!
//! 1. **`piptrack`**：STFT(2048) 幅度谱 → 每帧找局部极大（且超过该帧峰值的 10%）
//!    → 抛物线插值求精确频率 → 筛出 150~4000 Hz
//! 2. **中位数过滤**：只保留 `magnitude >= median(所有峰值幅度的)` 的样本
//!    （丢掉弱峰，它们更容易被噪声带偏）
//! 3. **`pitch_tuning`**：把每个频率换算成「离最近半音（这里是 1/36 octave）的
//!    残差」，做 0.01 宽的直方图，取最高柱
//!
//! # 输出为什么是「左边界」而不是柱中心
//!
//! `np.histogram` 返回的是 `(counts, bin_edges)`，而 librosa 取的是
//! `edges[argmax(counts)]` —— 也就是**左边界**。这不是笔误，但必须照抄：
//! 否则结果会系统性地偏 +0.005。

use crate::audio::stft::{Stft, Window};

/// 参考音高 A0（Hz）。librosa 的 `hz_to_octs` 用它做基准。
const A0_HZ: f64 = 27.5;

/// 估计全局音准偏差，单位是「1/bins_per_octave 个 octave」。
pub fn estimate_tuning(y: &[f32], sr: f32, bins_per_octave: u32) -> f32 {
    let samples = piptrack(y, sr);
    if samples.is_empty() {
        return 0.0;
    }

    // threshold = median(所有峰的幅度)
    let mut mags: Vec<f32> = samples.iter().map(|s| s.mag).collect();
    mags.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = if mags.len() % 2 == 1 {
        mags[mags.len() / 2]
    } else {
        (mags[mags.len() / 2 - 1] + mags[mags.len() / 2]) * 0.5
    };

    let freqs: Vec<f64> = samples
        .iter()
        .filter(|s| s.mag >= median && s.freq > 0.0)
        .map(|s| s.freq as f64)
        .collect();
    pitch_tuning(&freqs, 0.01, bins_per_octave)
}

/// 一个被检出的音高样本。
struct PitchSample {
    freq: f32,
    mag: f32,
}

/// 移植 `piptrack`：返回每帧每个局部极大处的 (频率, 幅度)。
fn piptrack(y: &[f32], sr: f32) -> Vec<PitchSample> {
    const N_FFT: usize = 2048;
    const HOP: usize = 512;
    const FMIN: f64 = 150.0;
    const FMAX: f64 = 4000.0;
    const THRESHOLD: f32 = 0.1;

    let stft = Stft::new(N_FFT, HOP, Window::Hann);
    let frames = stft.frame_count(y.len());
    let spec = stft.stft(y);
    let n_bins = stft.n_bins();

    let mut out = Vec::new();

    // 逐帧处理，避免把整张幅度谱都存下来
    let mut mag = vec![0.0f32; n_bins];
    for f in 0..frames {
        let base = f * n_bins;
        for (k, m) in mag.iter_mut().enumerate() {
            *m = spec[base + k].norm();
        }

        // ref_value = 0.1 * max(该帧)
        let frame_max = mag.iter().cloned().fold(0.0f32, f32::max);
        let ref_value = THRESHOLD * frame_max;

        // x = S * (S > ref_value)：低于阈值的清零，这样 localmax 不会在里面选峰
        // （librosa 就是这个语义：乘一个布尔掩码）
        let x: Vec<f32> = mag
            .iter()
            .map(|&v| if v > ref_value { v } else { 0.0 })
            .collect();

        // avg = gradient(S) 沿频率轴（中心差分；边界单侧差分）
        let avg = gradient(&mag);

        for k in 0..n_bins {
            let freq_hz = k as f64 * sr as f64 / N_FFT as f64;
            if freq_hz < FMIN || freq_hz >= FMAX {
                continue;
            }
            // localmax: x[k] > x[k-1] && x[k] >= x[k+1]（边界按 0 处理）
            let prev = if k > 0 { x[k - 1] } else { 0.0 };
            let next = if k + 1 < n_bins { x[k + 1] } else { 0.0 };
            if !(x[k] > prev && x[k] >= next) {
                continue;
            }

            let shift = parabolic_shift(&mag, k);
            let freq = (k as f64 + shift as f64) * sr as f64 / N_FFT as f64;
            let m = mag[k] + 0.5 * avg[k] * shift;
            out.push(PitchSample {
                freq: freq as f32,
                mag: m,
            });
        }
    }
    out
}

/// USB 中心差分（`np.gradient`）：中间用 `(x[k+1]-x[k-1])/2`，两端用单侧差分。
fn gradient(x: &[f32]) -> Vec<f32> {
    let n = x.len();
    let mut g = vec![0.0f32; n];
    if n == 1 {
        return g;
    }
    g[0] = x[1] - x[0];
    g[n - 1] = x[n - 1] - x[n - 2];
    for k in 1..n - 1 {
        g[k] = (x[k + 1] - x[k - 1]) / 2.0;
    }
    g
}

/// 抛物线插值的顶点偏移（`_parabolic_interpolation` 沿频率轴）。
///
/// 对三点 `(a, b, c)`，若 `-a + 2b - c > 0`（凹），顶点偏移 = `0.5(a-c)/(a-2b+c)`。
/// 边界点偏移恒为 0。
fn parabolic_shift(x: &[f32], k: usize) -> f32 {
    if k == 0 || k + 1 >= x.len() {
        return 0.0;
    }
    let a = x[k - 1];
    let b = x[k];
    let c = x[k + 1];
    let denom = a - 2.0 * b + c;
    let concave = -a + 2.0 * b - c > 0.0;
    if concave && denom.abs() > 1e-12 {
        0.5 * (a - c) / denom
    } else {
        0.0
    }
}

/// 移植 `pitch_tuning`：把频率的残差做直方图，返回最高柱的**左边界**。
fn pitch_tuning(freqs: &[f64], resolution: f64, bins_per_octave: u32) -> f32 {
    if freqs.is_empty() {
        return 0.0;
    }

    // residual = mod(bpo * log2(f/27.5), 1)，>= 0.5 的减 1
    let mut residual: Vec<f64> = freqs
        .iter()
        .filter(|&&f| f > 0.0)
        .map(|&f| {
            let octs = (f / A0_HZ).log2();
            let mut r = (bins_per_octave as f64 * octs).rem_euclid(1.0);
            if r >= 0.5 {
                r -= 1.0;
            }
            r
        })
        .collect();
    if residual.is_empty() {
        return 0.0;
    }
    // np.histogram 要求输入在 [lo, hi] 内；超出范围的值不会落进任何柱，
    // 这里先裁掉（residual 理论上在 (-0.5, 0.5]，裁一下只是防御）
    for r in residual.iter_mut() {
        *r = r.clamp(-0.5, 0.5);
    }

    // bins = linspace(-0.5, 0.5, ceil(1/resolution)+1)，即 102 个边界 = 101 个柱
    let n_bins = (1.0 / resolution).ceil() as usize; // 100
    let edges: Vec<f64> = (0..=n_bins)
        .map(|i| -0.5 + i as f64 * resolution)
        .collect();

    // 注意最后一个是闭区间（np.histogram 的行为）
    let mut counts = vec![0usize; n_bins];
    for r in &residual {
        let mut placed = false;
        for i in 0..n_bins {
            let (lo, hi) = (edges[i], edges[i + 1]);
            let in_bin = if i + 1 == n_bins {
                *r >= lo && *r <= hi
            } else {
                *r >= lo && *r < hi
            };
            if in_bin {
                counts[i] += 1;
                placed = true;
                break;
            }
        }
        let _ = placed;
    }

    let best = counts
        .iter()
        .enumerate()
        .max_by_key(|(_, c)| *c)
        .map(|(i, _)| i)
        .unwrap_or(0);
    // librosa 取 edges[argmax] = 左边界
    edges[best] as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gradient_matches_central_difference() {
        let x = [0.0f32, 1.0, 4.0, 9.0];
        let g = gradient(&x);
        assert!((g[0] - 1.0).abs() < 1e-6); // 单侧
        assert!((g[1] - 2.0).abs() < 1e-6); // (4-0)/2
        assert!((g[2] - 4.0).abs() < 1e-6); // (9-1)/2
        assert!((g[3] - 5.0).abs() < 1e-6); // 单侧
    }

    #[test]
    fn parabolic_shift_is_zero_at_edges() {
        let x = [1.0f32, 3.0, 2.0];
        assert_eq!(parabolic_shift(&x, 0), 0.0);
        assert_eq!(parabolic_shift(&x, 2), 0.0);
    }

    #[test]
    fn parabolic_shift_points_to_peak_side() {
        // 中点比右侧高 → 顶点应在中心左侧（偏移为负）
        let x = [1.0f32, 3.0, 2.0];
        // 右侧 (c=2) 比左侧 (a=1) 高 → 顶点偏向**右**侧 → 偏移为正
        assert!(parabolic_shift(&x, 1) > 0.0, "得到 {}", parabolic_shift(&x, 1));
        // 对称 → 偏移 0
        let y = [1.0f32, 3.0, 1.0];
        assert!(parabolic_shift(&y, 1).abs() < 1e-6);
    }

    #[test]
    fn in_tune_signal_gives_zero_tuning() {
        // A440 的正弦（标准音准）→ 残差应接近 0
        let y: Vec<f32> = (0..22050 * 2)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / 22050.0).sin() * 0.5)
            .collect();
        let t = estimate_tuning(&y, 22050.0, 36);
        // 容差 0.05：440 Hz 落在 bin 40.87 上（非整数），FFT 泄漏 + 抛物线插值
        // 让结果有几厘的法线偏差。直方图分辨率本来就是 0.01。
        assert!(t.abs() < 0.05, "标准音高应给出 ~0 的 tuning，得到 {t}");
    }

    #[test]
    fn detuned_signal_gives_detectable_offset() {
        // 把 440 Hz 故意调高 30 音分 = 30/100 个半音 = 30/100/12 个 octave
        // 换算到 36 bpo：30 音分 = 0.3 个半音 = 0.3/12*36 = 0.9 个 bin
        // residual 的模 1 语义会把它折回 -0.1
        let f = 440.0f32 * 2.0f32.powf(30.0 / 1200.0);
        let y: Vec<f32> = (0..22050 * 2)
            .map(|i| (std::f32::consts::TAU * f * i as f32 / 22050.0).sin() * 0.5)
            .collect();
        let t = estimate_tuning(&y, 22050.0, 36);
        // 0.9 → 0.9-1 = -0.1
        assert!((t - (-0.1)).abs() < 0.06, "期望约 -0.1，得到 {t}");
    }

    #[test]
    fn silence_gives_zero() {
        let y = vec![0.0f32; 22050];
        assert_eq!(estimate_tuning(&y, 22050.0, 36), 0.0);
    }

    /// 与 librosa 逐值对齐：同一段 12 秒音频，Python 给出 0.02。
    #[test]
    fn matches_librosa_on_real_audio() {
        fn read_f32(b: &[u8]) -> Vec<f32> {
            b.chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect()
        }
        let y = read_f32(include_bytes!("../../assets/golden_wave22k.f32"));
        let t = estimate_tuning(&y, 22050.0, 36);
        println!("tuning: rust {t} vs librosa 0.02");
        // 直方图分辨率是 0.01，差一格以内就算对齐
        assert!((t - 0.02).abs() <= 0.011, "rust {t} vs librosa 0.02");
    }
}
