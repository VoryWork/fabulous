//! 常量 Q 变换 —— `librosa.hybrid_cqt` 的 Rust 移植（lv-chordia 的输入）。
//!
//! # 为什么不能偷懒用普通 CQT
//!
//! 实测过：用 `librosa.cqt`（单速率）替代 `hybrid_cqt`，CQT 本身相对误差只有
//! 0.7%，但**高频段 252~288 bin 误差 36%**，最终 ChordNet 的逐帧 argmax
//! 一致率只有 **16~33%** —— 完全不能用。所以必须忠实复刻。
//!
//! # hybrid_cqt 的真实结构
//!
//! 它**不是**简单的 multirate，而是两段拼起来的：
//!
//! ```text
//! 288 bins（F#0 起，36 bins/octave，共 8 个 octave）
//!   ├─ 低频 238 bins → vqt（真正的 multirate：7 级，每级 2x 下采样）
//!   └─ 高频  50 bins → pseudo_cqt（用单次 STFT 近似，因为高频窗短）
//! ```
//!
//! 分界判据是 librosa 的 `pseudo_filters`：
//! `2^ceil(log2(length_k)) < 2 * hop_length`，即滤波器长度小于两个 hop 时
//! 直接用 STFT 的 bin 近似。**与 tuning 无关**（tuning 只是把全部频率平移，
//! 相对带宽不变），所以分界恒为 50/238。
//!
//! # 各级的 hop 递减
//!
//! | 级 i（0=最高 octave） | my_sr | my_hop |
//! |---|---|---|
//! | 0 | 22050 | 512 |
//! | 1 | 11025 | 256 |
//! | … | … | … |
//! | 6（最低，只有 22 bin） | 344.5 | 8 |
//!
//! 每级的帧数不同（hop 越小帧越多），最后统一裁到**最少**的那一级
//! （= 第 0 级，hop=512）。
//!
//! # ⚠️ 两级堆叠都是「倒序放置」而不是相加
//!
//! - `vqt` 内部：第 0 级是**最高** octave → 放在输出**末尾**；最后一级（最低）放开头。
//! - `hybrid_cqt`：pseudo（高频）放末尾，vqt（低频）放开头。
//!
//! 写成相加就完全错了（不同频段是不同的 bin，不可能相加）。
//!
//! # `scale=True` 的最后一步
//!
//! 复数响应最后要除以 `sqrt(lengths)`（每 bin 的滤波器长度），这一步在
//! `abs()` 之前做。
//!
//! # 与 Python 的已知数值差
//!
//! 各级的 2x 下采样：librosa 用 `soxr_hq`，这里用 rubato。两者都是高质量
//! 带限重采样，但不是逐位相同 —— 误差在 1e-4 量级。这是本项目唯一接受
//! 「近似」的地方（和 log-mel 的重采样同理）。

use rustfft::num_complex::Complex;

// resample_mono 在这里不用（见 vqt 内的注释）
use crate::audio::stft::{Stft, Window};

/// lv-chordia 训练时用的采样率。
pub const SR: f32 = 22050.0;
/// 相邻帧的采样点数。
pub const HOP: usize = 512;
/// CQT 的 bin 数。
pub const N_BINS: usize = 288;
/// 每 octave 的 bin 数（36 = 每音三分）。
pub const BPO: usize = 36;
/// 最低频：F#0 ≈ 23.1247 Hz。
pub const FMIN_HZ: f32 = 23.124651;

/// `hybrid_cqt` 的结果：`(帧数, 288)`，**按帧存储**。
///
/// Python 侧是 `(288, frames)` 然后 `.T`，这里直接给转置后的形态，
/// 与 chord 模型 `(1, seq, 288)` 的布局一致。
pub struct Cqt {
    pub frames: usize,
    pub data: Vec<f32>, // frames * N_BINS，行主序
}

impl Cqt {
    pub fn frame(&self, i: usize) -> &[f32] {
        &self.data[i * N_BINS..(i + 1) * N_BINS]
    }
}

/// `librosa.cqt` 的**幅度谱**（全 vqt，没有 pseudo 段），任意 bin 数 / 最低频。
///
/// 与 [`hybrid_cqt`] 的区别只在频段怎么算：`hybrid_cqt` 高频走 `pseudo_cqt`（省时间），
/// 而 `librosa.cqt` 的低频段一直 vqt 到底 —— 原来 `hybrid_cqt` 也是纯 vqt。
///
/// chroma 需要这个：`librosa.feature.chroma_cqt` 默认 `cqt_mode='full'`，
/// 从 C1 起 7 个 octave × 36 = 252 bin，全部走 vqt。
///
/// 返回 `(帧数, frames * n_bins)`，行主序（每帧一行）。
pub fn full_cqt_mag(y: &[f32], n_bins: usize, fmin_hz: f64) -> (usize, Vec<f32>) {
    let freqs = interval_frequencies(n_bins, fmin_hz, BPO);
    let alpha = relative_bandwidth(&freqs);
    let (lengths, _cutoff) = wavelet_lengths(&freqs, SR as f64, alpha);
    let parts = vqt(y, &freqs, &lengths);
    let frames = parts.len();
    let mut out = vec![0.0f32; frames * n_bins];
    for (f, row) in parts.iter().enumerate() {
        for (k, v) in row.iter().enumerate() {
            out[f * n_bins + k] = v.norm();
        }
    }
    (frames, out)
}

/// 计算 `hybrid_cqt` 的**幅度谱**（= Python 的 `np.abs(hybrid_cqt(...)).T`）。
///
/// `tuning` 是 `estimate_tuning` 的结果（单位：1/BPO octave），传 0.0 表示不校正。
pub fn hybrid_cqt(y: &[f32], tuning: f32) -> Cqt {
    let fmin = FMIN_HZ as f64 * 2.0f64.powf(tuning as f64 / BPO as f64);
    let freqs = interval_frequencies(N_BINS, fmin, BPO);
    let alpha = relative_bandwidth(&freqs);
    let (lengths, _cutoff) = wavelet_lengths(&freqs, SR as f64, alpha);

    // 哪些 bin 用 pseudo（高频），哪些用真正的 CQT（低频）
    let n_pseudo = lengths
        .iter()
        .filter(|&&l| 2.0f64.powf(l.log2().ceil()) < 2.0 * HOP as f64)
        .count();
    let n_full = N_BINS - n_pseudo;

    // ⚠️ 顺序必须是 [pseudo, vqt] —— 和 librosa 的 append 顺序一致。
    // 因为下面的倒序放置会把**先追加的**放到末尾，而 pseudo 是高频段
    // （bin 238~287）。写反了整条谱就会平移 50 个 bin（正弦峰值偏 50）。
    let mut parts: Vec<Vec<Vec<Complex<f32>>>> = Vec::new();
    if n_pseudo > 0 {
        parts.push(pseudo_cqt(y, &freqs[n_full..], &lengths[n_full..]));
    }
    if n_full > 0 {
        parts.push(vqt(y, &freqs[..n_full], &lengths[..n_full]));
    }

    // __trim_stack：裁到最短帧数，倒序放置（最后追加的 pseudo 在末尾）
    let frames = parts.iter().map(|p| p.len()).min().unwrap_or(0);
    let mut out = vec![0.0f32; frames * N_BINS];
    let mut end = N_BINS;
    for part in parts.iter() {
        if frames == 0 || part.is_empty() {
            continue;
        }
        let nb = part[0].len();
        let start = end.saturating_sub(nb);
        let take = nb.min(end - start);
        for f in 0..frames {
            for k in 0..take {
                // pseudo 与 vqt 返回的都是复数 → 统一取幅度
                out[f * N_BINS + start + k] = part[f][k].norm();
            }
        }
        end = start;
    }

    Cqt { frames, data: out }
}

/// `freqs[k] = fmin * 2^(k/bpo)` —— librosa 的 `interval_frequencies`（intervals='equal'）。
fn interval_frequencies(n_bins: usize, fmin: f64, bpo: usize) -> Vec<f64> {
    (0..n_bins)
        .map(|k| fmin * 2.0f64.powf(k as f64 / bpo as f64))
        .collect()
}

/// librosa 的 `filters._relative_bandwidth`。
///
/// 对等间距的 CQT，除首尾外 `bpo` 恒等于 `BPO`，所以 `alpha` 几乎处处相同；
/// 首尾用单侧差分。这个首尾修正不能省 —— 最低频的 `alpha` 差一点，
/// 滤波器长度就差出几百个采样点。
fn relative_bandwidth(freqs: &[f64]) -> Vec<f64> {
    let n = freqs.len();
    if n == 0 {
        return Vec::new();
    }
    let logf: Vec<f64> = freqs.iter().map(|f| f.log2()).collect();
    let mut bpo = vec![0.0f64; n];
    if n == 1 {
        bpo[0] = BPO as f64;
    } else {
        bpo[0] = 1.0 / (logf[1] - logf[0]);
        bpo[n - 1] = 1.0 / (logf[n - 1] - logf[n - 2]);
        for k in 1..n - 1 {
            bpo[k] = 2.0 / (logf[k + 1] - logf[k - 1]);
        }
    }
    bpo.iter()
        .map(|b| {
            let q = 2.0f64.powf(2.0 / b);
            (q - 1.0) / (q + 1.0)
        })
        .collect()
}

/// librosa 的 `filters.wavelet_lengths`（`gamma = 0`）：`lengths = Q * sr / freqs`，
/// 其中 `Q = filter_scale / alpha`（`filter_scale = 1`）。
fn wavelet_lengths(freqs: &[f64], sr: f64, alpha: Vec<f64>) -> (Vec<f64>, f64) {
    let mut lengths = Vec::with_capacity(freqs.len());
    let mut cutoff = 0.0f64;
    for (f, &a) in freqs.iter().zip(&alpha) {
        let q = 1.0 / a;
        lengths.push(q * sr / f);
        // window_bandwidth('hann') = 1.5（ENBW 实测值）
        let c = f * (1.0 + 0.5 * 1.5 / q);
        if c > cutoff {
            cutoff = c;
        }
    }
    (lengths, cutoff)
}

/// 精确 2 倍降采样：低通 FIR + 抽取。输出长度 = `input.len() / 2`。
///
/// # 为什么不用 `resample_mono`
///
/// rubato 的 `SincFixedIn` 是**流式**设计：每处理一个 chunk 都带 `sinc_len/2`
/// 个采样的启动延迟，而调用方只能拿到「固定长度的输出块」。多 chunk 拼接时
/// 每个接缝都会丢一点，7 级串联后总长度少 2%（实测 517 帧 → 505 帧）。
///
/// CQT 里只需要「长度精确减半」这一个性质，用零延迟的线性相位 FIR 就够了。
/// 质量上比 soxr_hq 略低，但误差远小于 CQT 本身对相位的敏感度
/// （CQT 最后取幅度谱）。
fn downsample_2x(input: &[f32]) -> Vec<f32> {
    const TAPS: usize = 256;
    const FC: f64 = 0.25; // 相对采样率的截止频率（= 新 Nyquist）

    // 窗函数法设计低通：h[n] = 2fc·sinc(2fc(n-M/2))·blackman(n)
    let m = TAPS as f64;
    let mut h = vec![0.0f64; TAPS];
    let mut sum = 0.0f64;
    for (n, hv) in h.iter_mut().enumerate() {
        let t = n as f64 - m / 2.0;
        let x = 2.0 * FC * t;
        let sinc = if x.abs() < 1e-12 {
            1.0
        } else {
            (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
        };
        let w = 0.42 - 0.5 * (std::f64::consts::TAU * n as f64 / m).cos()
            + 0.08 * (2.0 * std::f64::consts::TAU * n as f64 / m).cos();
        *hv = 2.0 * FC * sinc * w;
        sum += *hv;
    }
    // 归一化到 DC 增益 1
    if sum.abs() > 1e-12 {
        for hv in h.iter_mut() {
            *hv /= sum;
        }
    }

    let out_len = input.len() / 2;
    let mut out = vec![0.0f32; out_len];
    let half = TAPS / 2;
    for i in 0..out_len {
        let center = (2 * i) as i64;
        let mut acc = 0.0f64;
        for (k, &hk) in h.iter().enumerate() {
            let idx = center + k as i64 - half as i64;
            if idx >= 0 && (idx as usize) < input.len() {
                acc += hk * input[idx as usize] as f64;
            }
        }
        // 这里的增益是 **2** 而不是 sqrt(2)，两个 sqrt(2) 叠在一起：
        //
        // 1. librosa 的 `resample(..., scale=True)` 做 `y /= sqrt(ratio)`，
        //    ratio = 1/2 → 乘 sqrt(2)。这是 soxr 自己不去补偿的那份。
        // 2. 本函数的插值平均还会让**宽带信号**的 RMS 再降 sqrt(2)
        //    （低通把一半频段的能量滤掉了，而 soxr 的输出是逐样本等幅的）。
        //
        // 实测：只补 sqrt(2) 时，第 i 级相对 liborsa 的比例恰好是 2^(-i/2)
        //（bin216=1.003、bin150=0.495、bin60=0.251、bin20=0.126），即每级还差
        // sqrt(2) —— 这就是第 2 条的证明。
        out[i] = (acc * 2.0) as f32;
    }
    out
}

/// 频率域滤波器组：`(n_bins, n_fft/2+1)` 稠密矩阵，行主序。
struct FilterBank {
    data: Vec<Complex<f32>>,
    n_bins: usize,
    n_freq: usize,
    n_fft: usize,
}

impl FilterBank {
    /// `out[k] = Σ_f basis[k, f] · spec[f]`
    fn apply(&self, spec: &[Complex<f32>]) -> Vec<Complex<f32>> {
        let mut out = vec![Complex::new(0.0f32, 0.0); self.n_bins];
        for k in 0..self.n_bins {
            let row = &self.data[k * self.n_freq..(k + 1) * self.n_freq];
            let mut acc = Complex::new(0.0f32, 0.0);
            for f in 0..self.n_freq {
                acc += row[f] * spec[f];
            }
            out[k] = acc;
        }
        out
    }
}

/// 移植 `wavelet()` + `__vqt_filter_fft()`。
///
/// 1. 每个频率构造复数正弦（`phasor`）× 周期 Hann 窗
/// 2. 除以 L1 范数（`norm=1`）
/// 3. **居中**补零到 `max_len = 2^ceil(log2(max(lengths)))`
/// 4. 乘 `lengths[k] / n_fft`
/// 5. `n_fft` 点 FFT —— 输入只有 `max_len` 长，所以是**尾部**补零（不是居中！）
/// 6. 取前 `n_fft/2+1` 列
///
/// `min_n_fft` 对应 librosa 的 `hop_length` 约束：
/// `n_fft ≥ 2^(1+ceil(log2(hop)))`（`pseudo_cqt` 会传 1024）。
fn build_filter_bank(
    freqs: &[f64],
    sr: f64,
    lengths: &[f64],
    min_n_fft: Option<usize>,
) -> FilterBank {
    let n_bins = freqs.len();
    let max_len = lengths.iter().cloned().fold(0.0f64, f64::max);
    let mut n_fft = 2.0f64.powf(max_len.log2().ceil()) as usize;
    if let Some(min) = min_n_fft {
        if n_fft < min {
            n_fft = min;
        }
    }
    let n_freq = n_fft / 2 + 1;

    let mut planner = rustfft::FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut data = vec![Complex::new(0.0f32, 0.0); n_bins * n_freq];

    for (k, &freq) in freqs.iter().enumerate() {
        let ilen = lengths[k];
        // Python: np.arange(-ilen // 2, ilen // 2)
        //   -ilen // 2 = floor(-ilen/2)，ilen // 2 = floor(ilen/2)
        let lo = (-(ilen / 2.0)).floor();
        let hi = (ilen / 2.0).floor();
        let n = (hi - lo).max(0.0) as usize;

        // phasor × periodic hann
        let mut sig: Vec<Complex<f32>> = Vec::with_capacity(n);
        for i in 0..n {
            let t = lo + i as f64;
            let ang = t * 2.0 * std::f64::consts::PI * freq / sr;
            let w = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos();
            sig.push(Complex::new(
                (ang.cos() * w) as f32,
                (ang.sin() * w) as f32,
            ));
        }
        // normalize(norm=1) → 除以 sum(|sig|)
        let l1: f32 = sig.iter().map(|c| c.norm()).sum();
        if l1 > 0.0 {
            for s in sig.iter_mut() {
                *s = Complex::new(s.re / l1, s.im / l1);
            }
        }
        // 居中补零到 max_len
        let max_len_i = 2.0f64.powf(max_len.log2().ceil()) as usize;
        let mut basis = vec![Complex::new(0.0f32, 0.0); max_len_i];
        let lpad = (max_len_i - n) / 2;
        basis[lpad..lpad + n].copy_from_slice(&sig);
        // basis *= lengths[k] / n_fft
        let scale = (ilen / n_fft as f64) as f32;
        for s in basis.iter_mut() {
            *s = Complex::new(s.re * scale, s.im * scale);
        }
        // n_fft 点 FFT（basis 只有 max_len 长 → 尾部补零）
        let mut buf = vec![Complex::new(0.0f32, 0.0); n_fft];
        let copy_len = basis.len().min(n_fft);
        buf[..copy_len].copy_from_slice(&basis[..copy_len]);
        fft.process(&mut buf);

        data[k * n_freq..(k + 1) * n_freq].copy_from_slice(&buf[..n_freq]);
    }

    FilterBank {
        data,
        n_bins,
        n_freq,
        n_fft,
    }
}

/// librosa 的 `__cqt_response`：STFT（矩形窗，补 0）后做滤波器组矩阵乘。
fn cqt_response(y: &[f32], bank: &FilterBank, hop: usize) -> Vec<Vec<Complex<f32>>> {
    let stft = Stft::new(bank.n_fft, hop, Window::Ones);
    let frames = stft.frame_count(y.len());
    let spec = stft.stft(y);
    let n_freq = stft.n_bins();

    let mut out = Vec::with_capacity(frames);
    let mut buf = vec![Complex::new(0.0f32, 0.0); n_freq];
    for f in 0..frames {
        buf.copy_from_slice(&spec[f * n_freq..(f + 1) * n_freq]);
        out.push(bank.apply(&buf));
    }
    out
}

/// 真正的 multirate CQT（`vqt` 的 `gamma=0` 特例）。
///
/// 返回 `frames × n_bins` 的**复数**响应，已除以 `sqrt(lengths)`。
fn vqt(y: &[f32], freqs: &[f64], lengths: &[f64]) -> Vec<Vec<Complex<f32>>> {
    let n_bins = freqs.len();
    if n_bins == 0 {
        return Vec::new();
    }
    let n_octaves = (n_bins as f64 / BPO as f64).ceil() as usize;
    let n_filters = BPO.min(n_bins);

    let mut my_y: Vec<f32> = y.to_vec();
    let mut my_sr = SR as f64;
    let mut my_hop = HOP;
    let mut parts: Vec<Vec<Vec<Complex<f32>>>> = Vec::with_capacity(n_octaves);

    for i in 0..n_octaves {
        // 当前 octave 的切片：i=0 取最高的 36 个，最后一级可能不足 36
        let stop = n_bins - n_filters * i;
        let start = stop.saturating_sub(n_filters);
        if start >= stop {
            break;
        }
        let f_oct = &freqs[start..stop];
        let l_oct = &lengths[start..stop];

        // 每级用 my_sr 生成滤波器（长度随 sr 减半而缩短）
        let scaled: Vec<f64> = l_oct.iter().map(|&l| l * (my_sr / SR as f64)).collect();
        let bank = build_filter_bank(f_oct, my_sr, &scaled, None);
        parts.push(cqt_response(&my_y, &bank, my_hop));

        if i + 1 < n_octaves && my_hop % 2 == 0 {
            let new_sr = my_sr / 2.0;
            // ⚠️ 不用 resample_mono：rubato 的 SincFixedIn 每块有启动延迟，
            // 7 级串联会把长度越截越短（实测 517 帧 → 505 帧）。
            // CQT 只需要「精确 2 倍下采样」，用零延迟的 FIR 抽取即可。
            my_y = downsample_2x(&my_y);
            my_hop /= 2;
            my_sr = new_sr;
        }
    }

    // 裁到共同帧数，倒序放置（i=0 是最高 octave → 末尾）
    let frames = parts.iter().map(|p| p.len()).min().unwrap_or(0);
    let mut out = vec![vec![Complex::new(0.0f32, 0.0); n_bins]; frames];
    let mut end = n_bins;
    for part in parts.iter() {
        if part.is_empty() {
            continue;
        }
        let nb = part[0].len();
        let start = end.saturating_sub(nb);
        let take = nb.min(end - start);
        for f in 0..frames {
            for k in 0..take {
                out[f][start + k] = part[f][k];
            }
        }
        end = start;
    }

    // scale=True：每 bin 除以 sqrt(lengths)（用原始 sr 下的 lengths）
    for frame in out.iter_mut() {
        for (k, v) in frame.iter_mut().enumerate() {
            let s = lengths[k].sqrt() as f32;
            *v = Complex::new(v.re / s, v.im / s);
        }
    }
    out
}

/// 高频段的近似 CQT（`pseudo_cqt`）：单次 STFT + 固定滤波器组。
///
/// # 和 `cqt_response`（vqt 用）的三处关键差异
///
/// 读 librosa 的 `pseudo_cqt` 才发现的，三处都会单独造成几倍~几十倍的幅度偏差：
///
/// 1. **`fft_basis = np.abs(fft_basis)`** —— 滤波器组先取幅度（变成实数）
/// 2. **`window="hann"`** —— 不是 vqt 的 `ones`
/// 3. **`phase=False`** —— 先取 STFT 的幅度谱再做矩阵乘
/// 4. **`C /= sqrt(n_fft)`** —— 用 `n_fft = 1024` 归一化（≈ 除以 32）
///
/// 漏掉第 4 条会让整段偏高 24 倍（实测 0.1847 vs 0.00755）。
fn pseudo_cqt(y: &[f32], freqs: &[f64], lengths: &[f64]) -> Vec<Vec<Complex<f32>>> {
    let min_n_fft = 2usize.pow(1 + (HOP as f64).log2().ceil() as u32);
    let bank = build_filter_bank(freqs, SR as f64, lengths, Some(min_n_fft));

    let stft = Stft::new(bank.n_fft, HOP, Window::Hann);
    let frames = stft.frame_count(y.len());
    let spec = stft.stft(y);
    let n_freq = stft.n_bins();
    let norm = 1.0 / (bank.n_fft as f32).sqrt();

    let mut out = Vec::with_capacity(frames);
    let mut mag = vec![0.0f32; n_freq];
    for f in 0..frames {
        // phase=False → 取幅度谱
        for (i, m) in mag.iter_mut().enumerate() {
            *m = spec[f * n_freq + i].norm();
        }
        // fft_basis 已取 abs（实数）
        let mut row = vec![Complex::new(0.0f32, 0.0); bank.n_bins];
        for k in 0..bank.n_bins {
            let base = k * bank.n_freq;
            let mut acc = 0.0f32;
            for i in 0..bank.n_freq {
                acc += bank.data[base + i].norm() * mag[i];
            }
            row[k] = Complex::new(acc * norm, 0.0);
        }
        out.push(row);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frequencies_start_at_fmin_and_double_per_octave() {
        let f = interval_frequencies(N_BINS, FMIN_HZ as f64, BPO);
        assert!((f[0] - FMIN_HZ as f64).abs() < 1e-9);
        assert!((f[BPO] / f[0] - 2.0).abs() < 1e-9, "一个 octave 应翻倍");
        assert_eq!(f.len(), N_BINS);
    }

    #[test]
    fn relative_bandwidth_is_nearly_constant() {
        let f = interval_frequencies(N_BINS, FMIN_HZ as f64, BPO);
        let a = relative_bandwidth(&f);
        for k in 5..280 {
            assert!(
                (a[k] - a[5]).abs() < 1e-6,
                "bin {k} 偏离: {} vs {}",
                a[k],
                a[5]
            );
        }
        assert!((a[0] - a[5]).abs() / a[5] < 0.05);
    }

    #[test]
    fn alpha_matches_librosa_value() {
        // 2^(2/36) = 1.03926  → alpha = (q-1)/(q+1) = 0.019253
        let f = interval_frequencies(N_BINS, FMIN_HZ as f64, BPO);
        let a = relative_bandwidth(&f);
        assert!((a[100] - 0.019253).abs() < 1e-4, "得到 {}", a[100]);
    }

    #[test]
    fn wavelet_lengths_match_librosa_measurements() {
        let f = interval_frequencies(N_BINS, FMIN_HZ as f64, BPO);
        let alpha = relative_bandwidth(&f);
        let (len, _) = wavelet_lengths(&f, SR as f64, alpha);
        // Python 实测：最低 49529.5，最高 197.2
        assert!((len[0] - 49529.5).abs() < 60.0, "最低频 {}", len[0]);
        assert!((len[N_BINS - 1] - 197.2).abs() < 2.0, "最高频 {}", len[N_BINS - 1]);
    }

    #[test]
    fn pseudo_split_is_50_238() {
        let f = interval_frequencies(N_BINS, FMIN_HZ as f64, BPO);
        let alpha = relative_bandwidth(&f);
        let (len, _) = wavelet_lengths(&f, SR as f64, alpha);
        let n_pseudo = len
            .iter()
            .filter(|&&l| 2.0f64.powf(l.log2().ceil()) < 2.0 * HOP as f64)
            .count();
        assert_eq!(n_pseudo, 50, "pseudo bin 数");
        // pseudo 必须全部在末尾（最高频）
        for k in 0..(N_BINS - n_pseudo) {
            assert!(
                2.0f64.powf(len[k].log2().ceil()) >= 2.0 * HOP as f64,
                "bin {k} 不该是 pseudo"
            );
        }
    }

    #[test]
    fn output_shape_is_frames_by_288() {
        let y: Vec<f32> = (0..22050 * 3).map(|i| (i as f32 * 0.01).sin() * 0.3).collect();
        let c = hybrid_cqt(&y, 0.0);
        assert_eq!(c.data.len(), c.frames * N_BINS);
        assert!(c.frames > 100 && c.frames < 140, "帧数 {}", c.frames);
    }

    #[test]
    fn silence_is_near_zero() {
        let y = vec![0.0f32; 22050 * 2];
        let c = hybrid_cqt(&y, 0.0);
        let max = c.data.iter().cloned().fold(0.0f32, f32::max);
        assert!(max < 1e-4, "静音时最大幅度 {max}");
    }

    #[test]
    fn sine_peak_lands_in_right_bin() {
        // 440 Hz 正弦 → bin = 36 * log2(440/F#0) ≈ 152
        let y: Vec<f32> = (0..22050 * 3)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / SR).sin() * 0.5)
            .collect();
        let c = hybrid_cqt(&y, 0.0);
        let frame = c.frame(c.frames / 2);
        let peak = frame
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;
        let expect = (36.0 * (440.0f64 / FMIN_HZ as f64).log2()) as usize;
        assert!(
            (peak as i64 - expect as i64).abs() <= 2,
            "峰值 bin {peak}，期望 {expect}"
        );
    }

    // ── 与 Python librosa 逐值对齐 ──

    fn read_f32(b: &[u8]) -> Vec<f32> {
        b.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }

    /// 12 秒音频（264600 samples）→ 517 帧 × 288 bin，与 librosa 逐值对比。
    #[test]
    fn cqt_matches_librosa() {
        let y = read_f32(include_bytes!("../../assets/golden_wave22k.f32"));
        let expect = read_f32(include_bytes!("../../assets/golden_cqt.f32"));
        let got = hybrid_cqt(&y, 0.0);

        assert_eq!(got.frames, 517, "帧数应与 librosa 一致");
        assert_eq!(expect.len(), 517 * N_BINS, "golden 尺寸异常");

        let mut max_err = 0.0f32;
        let mut max_at = (0usize, 0usize);
        let mut sum_err = 0.0f64;
        let mut sum_ref = 0.0f64;
        for f in 0..got.frames {
            for k in 0..N_BINS {
                let g = got.data[f * N_BINS + k];
                let e = expect[f * N_BINS + k];
                let d = (g - e).abs();
                if d > max_err {
                    max_err = d;
                    max_at = (f, k);
                }
                sum_err += d as f64;
                sum_ref += e as f64;
            }
        }
        let rel = sum_err / sum_ref * 100.0;
        println!("CQT 最大绝对误差 {max_err:.6} at frame {} bin {}，相对 {rel:.4}%", max_at.0, max_at.1);
        // 诊断：看各频段的尺度比例（Rust / Python）
        for (label, lo, hi) in [
            ("vqt 低频 0-36", 0usize, 36usize),
            ("vqt 中频 108-144", 108, 144),
            ("vqt 高频 216-238", 216, 238),
            ("pseudo 238-288", 238, 288),
        ] {
            let mut g = 0.0f64;
            let mut e = 0.0f64;
            let mut cnt = 0usize;
            for f in 0..got.frames {
                for k in lo..hi {
                    g += got.data[f * N_BINS + k] as f64;
                    e += expect[f * N_BINS + k] as f64;
                    cnt += 1;
                }
            }
            println!("  {label}: rust 均值 {:.5} python 均值 {:.5} 比例 {:.3}", g / cnt as f64, e / cnt as f64, g / e);
            // 逐 bin 对比（同一帧），看是否整段错位
            let fr = 82usize;
            for k in [20usize, 60, 108, 150, 216, 237, 240, 270] {
                println!("    bin {k:3}: rust {:.6} python {:.6} 比例 {:.3}",
                    got.data[fr * N_BINS + k],
                    expect[fr * N_BINS + k],
                    got.data[fr * N_BINS + k] / expect[fr * N_BINS + k]);
            }
        }

        // 重采样器不同（rubato vs soxr）会带来 1e-3 量级差异；结构错位会是 1.0+
        assert!(
            rel < 2.0,
            "CQT 相对误差 {rel:.3}% 过大（>2% 说明结构不对，不只是重采样差异）"
        );
    }

    /// chroma 用的 252 bin 全 vqt 版本（`librosa.cqt`，fmin=C1）。
    ///
    /// 与 `hybrid_cqt` 分开验收是因为频段构成不同：这里 252 个 bin 全走 vqt，
    /// 最低频是 C1（32.7 Hz），滤波器比 288 bin 版更长，边界效应更明显。
    #[test]
    fn full_cqt_mag_matches_librosa() {
        let y = read_f32(include_bytes!("../../assets/golden_wave22k.f32"));
        let expect = read_f32(include_bytes!("../../assets/golden_cqt252.f32"));
        // Python: tuning = librosa.estimate_tuning(y, sr, bins_per_octave=36) = 0.02
        let fmin = crate::audio::chroma::C1_HZ * 2.0f64.powf(0.02 / BPO as f64);
        let (frames, got) = full_cqt_mag(&y, 252, fmin);

        assert_eq!(frames, 517, "帧数应与 librosa 一致");
        assert_eq!(expect.len(), 517 * 252, "golden 尺寸异常");

        for (label, lo, hi) in [
            ("帧 0..5（边界）", 0usize, 5usize),
            ("帧 5..512", 5, 512),
            ("帧 512..（边界）", 512, 517),
        ] {
            let mut sum_err = 0.0f64;
            let mut sum_ref = 0.0f64;
            for f in lo..hi {
                for k in 0..252 {
                    sum_err += (got[f * 252 + k] - expect[f * 252 + k]).abs() as f64;
                    sum_ref += expect[f * 252 + k] as f64;
                }
            }
            println!("  {label}: 相对 {:.4}%", sum_err / sum_ref * 100.0);
        }

        // 中间帧必须逐值贴合（重采样差异 ~1e-3）
        let mut mid_err = 0.0f64;
        let mut mid_ref = 0.0f64;
        for f in 5..512 {
            for k in 0..252 {
                mid_err += (got[f * 252 + k] - expect[f * 252 + k]).abs() as f64;
                mid_ref += expect[f * 252 + k] as f64;
            }
        }
        let mid_rel = mid_err / mid_ref * 100.0;
        assert!(mid_rel < 2.0, "中间帧相对误差 {mid_rel:.4}% 过大");
    }

    /// 把 Rust 算出的 CQT 落到文件，供 Python 侧喂给 ChordNet 验证。
    ///
    /// 这个测试不参与常规回归（要手动跑），只是排查工具：
    /// `cargo test --lib audio::cqt::tests::dump_cqt_for_python -- --ignored`
    #[test]
    #[ignore = "排查工具，手动运行"]
    fn dump_cqt_for_python() {
        let y = read_f32(include_bytes!("../../assets/golden_wave22k.f32"));
        let got = hybrid_cqt(&y, 0.0);
        let bytes: Vec<u8> = got.data.iter().flat_map(|v| v.to_le_bytes()).collect();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tmp-cqt-rust.f32");
        std::fs::write(path, &bytes).expect("写入失败");
        println!("已写入 {path}：{} 帧 × {N_BINS} bin", got.frames);
    }

    /// 60 秒（2584 帧）长音频的 CQT 对比 —— 查「整首歌跑偏」是否来自长信号漂移。
    ///
    /// 12 秒的 `cqt_matches_librosa` 只覆盖 517 帧，`vqt` 的 7 级降采样在长信号上
    /// 是否累积误差看不出来。
    #[test]
    fn long_cqt_matches_librosa() {
        let y = read_f32(include_bytes!("../../assets/golden_wave60.f32"));
        let expect = read_f32(include_bytes!("../../assets/golden_cqt60.f32"));
        // librosa 在 tuning=None 时自动估出 -0.06 bin（-2 音分）并据此平移 fmin，
        // 这里用同一个值，才能把「调音偏差」从「CQT 本身」里摘出去。
        let got = hybrid_cqt(&y, -0.06);

        assert_eq!(got.frames, 2584, "帧数应与 librosa 一致");
        assert_eq!(expect.len(), 2584 * N_BINS, "golden 尺寸异常");

        // 按频段看：低频走 pseudo 段、中频走 vqt 后几级、高频走 vqt 第一级
        let bands = [
            ("bin 0..36（pseudo 段）", 0usize, 36usize),
            ("bin 36..108（vqt 低）", 36, 108),
            ("bin 108..216（vqt 中）", 108, 216),
            ("bin 216..288（vqt 高）", 216, 288),
        ];
        let mut total_rel = 0.0f64;
        for (label, lo, hi) in bands {
            let mut sum_err = 0.0f64;
            let mut sum_ref = 0.0f64;
            let mut sum_got = 0.0f64;
            for f in 0..2584 {
                for k in lo..hi {
                    sum_err += (got.data[f * N_BINS + k] - expect[f * N_BINS + k]).abs() as f64;
                    sum_ref += expect[f * N_BINS + k] as f64;
                    sum_got += got.data[f * N_BINS + k] as f64;
                }
            }
            // 均值比例 ≈ 1 说明只是噪声；明显偏离 1 说明是**增益**问题
            let ratio = sum_got / sum_ref;
            let rel = sum_err / sum_ref * 100.0;
            println!("  {label}: 相对 {rel:.4}%  比例 {ratio:.4}");
            total_rel = total_rel.max(rel);
        }

        // 逐帧 argmax 一致率：这才是和弦模型真正吃进去的东西
        let mut agree = 0usize;
        for f in 0..2584 {
            let mut ga = 0usize;
            let mut ea = 0usize;
            for k in 0..N_BINS {
                if got.data[f * N_BINS + k] > got.data[f * N_BINS + ga] {
                    ga = k;
                }
                if expect[f * N_BINS + k] > expect[f * N_BINS + ea] {
                    ea = k;
                }
            }
            if ga == ea {
                agree += 1;
            }
        }
        println!("  逐帧 argmax 一致: {agree}/2584");

        assert!(total_rel < 3.0, "长音频 CQT 相对误差 {total_rel:.4}% 过大");
    }
}
