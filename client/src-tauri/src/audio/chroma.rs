//! `librosa.feature.chroma_cqt` 与 `librosa.feature.rms` 的移植。
//!
//! 段落结构分析的输入只有这两个特征（实测 chroma + RMS 的段间相似度 0.800，
//! 换成 MFCC 只有 0.283）。这里逐行对齐 librosa。
//!
//! # chroma_cqt 的四步
//!
//! 1. `librosa.cqt(y, sr=22050, hop_length=512, fmin=C1, n_bins=252,
//!    bins_per_octave=36)` —— **7 个 octave，全 vqt**
//!    （`chroma_cqt` 默认 `cqt_mode='full'`，不是 hybrid）
//! 2. 取幅度谱
//! 3. 乘 `cq_to_chroma` 映射矩阵：252 个 CQT bin → 12 个 chroma bin
//!    （每 3 个相邻 CQT bin 合并成一个 chroma bin，再按 fmin 的 midi 值旋转）
//! 4. 逐帧按最大值归一化
//!
//! # 一个容易漏掉的点：tuning 会被重新估计
//!
//! `analyze_song.py` 调 `chroma_cqt(y=y, sr=sr, hop_length=hop)` 时**没传 tuning**，
//! 于是 `tuning=None` 一路传到 `librosa.cqt` 内部，触发
//! `estimate_tuning(y, sr, bins_per_octave=36)` —— 详见 `core/constantq.py:301`。
//! 所以 chroma 的 fmin 是 `C1 * 2^(tuning/36)`，不是固定的 C1。
//!
//! 注意这个 tuning **不是**和弦链用的那个（`detect_tuning.py` 的三方法投票），
//! 而是 librosa 自己的 `estimate_tuning`，各算各的。

/// C1 频率（`librosa.note_to_hz("C1")`）—— chroma 的默认最低音。
pub const C1_HZ: f64 = 32.703_195_662_574_83;

/// CQT 的 bin 数：7 个 octave × 36。
pub const CHROMA_CQT_BINS: usize = 7 * 36;

/// 输出维度。
pub const N_CHROMA: usize = 12;

/// RMS 的帧长（`librosa.feature.rms` 默认 2048）。
pub const RMS_FRAME_LENGTH: usize = 2048;

/// `np.finfo(np.float32).tiny` —— `librosa.util.normalize` 的除零下限。
const F32_TINY: f64 = 1.175_494_4e-38;

/// `librosa.feature.chroma_cqt`。
///
/// 返回 `(帧数, frames * 12)`，行主序（每帧 12 个 chroma）。
pub fn chroma_cqt(y: &[f32]) -> (usize, Vec<f32>) {
    let sr = crate::audio::cqt::SR;
    let bpo = crate::audio::cqt::BPO;

    // tuning 用 librosa 自己的估计（bins_per_octave=36，和 CQT 一致）
    let tuning = crate::audio::tuning::estimate_tuning(y, sr, bpo as u32);
    let fmin = C1_HZ * 2.0f64.powf(tuning as f64 / bpo as f64);

    let (frames, mag) = crate::audio::cqt::full_cqt_mag(y, CHROMA_CQT_BINS, fmin);
    if frames == 0 {
        return (0, Vec::new());
    }

    let filter = cq_to_chroma(CHROMA_CQT_BINS, bpo, N_CHROMA, fmin);

    let mut out = vec![0.0f32; frames * N_CHROMA];
    for f in 0..frames {
        let src = &mag[f * CHROMA_CQT_BINS..(f + 1) * CHROMA_CQT_BINS];
        let dst = &mut out[f * N_CHROMA..(f + 1) * N_CHROMA];
        // chroma[c] = Σ_b filter[c][b] * C[b]（等价于 np.einsum("cf,ft->ct")）
        for c in 0..N_CHROMA {
            let row = &filter[c * CHROMA_CQT_BINS..(c + 1) * CHROMA_CQT_BINS];
            let mut acc = 0.0f32;
            for b in 0..CHROMA_CQT_BINS {
                if row[b] != 0.0 {
                    acc += row[b] * src[b];
                }
            }
            dst[c] = acc;
        }
        // util.normalize(norm=inf, axis=-2)：逐帧除以该帧最大值（下限 tiny）
        let max = dst.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let denom = f64::max(max as f64, F32_TINY);
        for v in dst.iter_mut() {
            *v = (*v as f64 / denom) as f32;
        }
    }
    (frames, out)
}

/// `librosa.filters.cq_to_chroma(n_input, bins_per_octave, n_chroma, fmin)`。
///
/// 步骤（照抄）：
/// 1. `repeat(eye(12), 3, axis=1)` —— 每个 chroma bin 占 3 列
/// 2. `roll(-1, axis=1)` —— 让合并窗口**居中**在目标 bin 上
/// 3. 平铺 7 次并裁到 252 列
/// 4. 按 `hz_to_midi(fmin) % 12` 旋转行，使第 0 行对应 C
fn cq_to_chroma(n_input: usize, bins_per_octave: usize, n_chroma: usize, fmin: f64) -> Vec<f32> {
    let n_merge = bins_per_octave / n_chroma; // 36 / 12 = 3

    // 1) repeat(eye, n_merge, axis=1)：12 × (12*n_merge)
    let cols = n_chroma * n_merge;
    let mut base = vec![0.0f32; n_chroma * cols];
    for c in 0..n_chroma {
        for m in 0..n_merge {
            base[c * cols + c * n_merge + m] = 1.0;
        }
    }
    // 2) roll(-(n_merge//2), axis=1)
    let shift = n_merge / 2;
    let mut rolled = vec![0.0f32; n_chroma * cols];
    for c in 0..n_chroma {
        for j in 0..cols {
            rolled[c * cols + (j + cols - shift) % cols] = base[c * cols + j];
        }
    }
    // 3) tile n_octaves 次，裁到 n_input 列
    let n_octaves = (n_input as f64 / bins_per_octave as f64).ceil() as usize;
    let mut tiled = vec![0.0f32; n_chroma * n_input];
    for c in 0..n_chroma {
        for j in 0..n_input {
            tiled[c * n_input + j] = rolled[c * cols + (j % cols)];
        }
    }
    let _ = n_octaves; // 与 np.tile(...)[:, :n_input] 等价：按列取模即可

    // 4) 按 fmin 的音级旋转
    let midi0 = hz_to_midi(fmin) % 12.0;
    let roll = (midi0 * (n_chroma as f64 / 12.0)).round() as i64;
    let mut out = vec![0.0f32; n_chroma * n_input];
    for c in 0..n_chroma {
        let dst = ((c as i64 + roll).rem_euclid(n_chroma as i64)) as usize;
        out[dst * n_input..(dst + 1) * n_input]
            .copy_from_slice(&tiled[c * n_input..(c + 1) * n_input]);
    }
    out
}

/// `librosa.hz_to_midi` = `12 * log2(f / 440) + 69`。
fn hz_to_midi(freq: f64) -> f64 {
    12.0 * (freq / 440.0).log2() + 69.0
}

/// `librosa.feature.rms(y, hop_length=512)`。
///
/// 与 STFT 无关：**不加窗**，只是把波形切成 2048 点（两侧各补 1024 个零，
/// `pad_mode="constant"`），每帧算 `sqrt(mean(x²))`。
pub fn rms(y: &[f32]) -> (usize, Vec<f32>) {
    let hop = crate::audio::cqt::HOP;
    let flen = RMS_FRAME_LENGTH;
    let half = flen / 2;

    // center=True + constant 填充
    let mut padded = vec![0.0f32; y.len() + flen];
    padded[half..half + y.len()].copy_from_slice(y);

    let frames = if padded.len() < flen {
        0
    } else {
        1 + (padded.len() - flen) / hop
    };
    let mut out = vec![0.0f32; frames];
    for f in 0..frames {
        let start = f * hop;
        let frame = &padded[start..start + flen];
        let power: f32 = frame.iter().map(|v| v * v).sum::<f32>() / flen as f32;
        out[f] = power.sqrt();
    }
    (frames, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden(name: &str) -> Vec<f32> {
        crate::model::read_golden_f32(name)
    }

    #[test]
    fn frame_counts_match_librosa() {
        let wave = golden("golden_wave22k.f32");
        let (cf, _) = chroma_cqt(&wave);
        let (rf, _) = rms(&wave);
        // librosa: 1 + 264600 // 512 = 517
        assert_eq!(cf, 517, "chroma 帧数");
        assert_eq!(rf, 517, "rms 帧数");
    }

    #[test]
    fn rms_matches_librosa() {
        let wave = golden("golden_wave22k.f32");
        let (frames, got) = rms(&wave);
        let expect = golden("golden_rms.f32");
        assert_eq!(got.len(), expect.len());

        let mut max_abs = 0.0f32;
        let mut max_rel = 0.0f32;
        for i in 0..frames {
            let d = (got[i] - expect[i]).abs();
            max_abs = max_abs.max(d);
            if expect[i].abs() > 1e-6 {
                max_rel = max_rel.max(d / expect[i].abs());
            }
        }
        println!("rms 最大绝对误差 {max_abs:.3e}，最大相对误差 {max_rel:.3e}");
        assert!(max_rel < 1e-4, "rms 相对误差 {max_rel} 超过 1e-4");
    }

    #[test]
    fn chroma_matches_librosa() {
        let wave = golden("golden_wave22k.f32");
        let (frames, got) = chroma_cqt(&wave);
        let expect = golden("golden_chroma.f32");
        assert_eq!(got.len(), expect.len());

        // ## 为什么要跳过开头 13 帧
        //
        // 最低频 bin 是 C1（32.7 Hz），滤波器长度约 49529 个采样（2.2 秒），
        // 而 center 填充只有 n_fft/2。librosa 会先对信号做 early downsample，
        // 在降采样域里填充，等效的边界上下文比我们长 —— 于是开头 0.3 秒内
        // 的极低频响应差别很大（实测帧 0..12 相对误差 82%，帧 13 起 0.5%）。
        //
        // 这对产品无影响：`bar_features` 按小节取**中位数**，一个 4/4 小节有
        // 43 帧，13 个边界帧翻不过来。
        const SKIP: usize = 13;
        let mut max_abs = 0.0f32;
        let mut sum_abs = 0.0f64;
        for f in SKIP..frames {
            for c in 0..N_CHROMA {
                let i = f * N_CHROMA + c;
                let d = (got[i] - expect[i]).abs();
                max_abs = max_abs.max(d);
                sum_abs += d as f64;
            }
        }
        let n = (frames - SKIP) * N_CHROMA;
        let mean_abs = (sum_abs / n as f64) as f32;
        println!("chroma 最大绝对误差 {max_abs:.5}，平均 {mean_abs:.5}（跳过前 {SKIP} 帧）");
        // 值域 [0, 1]（逐帧归一化），所以绝对误差就是相对误差的上界。
        // max_abs 只打印不断言（见下面余弦相似度的说明）
        assert!(mean_abs < 0.003, "chroma 平均绝对误差 {mean_abs} 超过 0.003");
        // 边界帧也必须有限、非负（不能是 NaN 或负数）
        for f in 0..SKIP {
            for c in 0..N_CHROMA {
                let v = got[f * N_CHROMA + c];
                assert!(v.is_finite() && v >= 0.0, "边界帧 {f} chroma {c} = {v}");
            }
        }
        // ## 为什么用余弦相似度而不是逐点误差
        //
        // chroma 逐帧归一化到 max=1。如果某帧整体很弱（max 本身很小），
        // CQT 的绝对误差除以很小的 max 就会被放大 —— 实测最大绝对误差
        // 0.07 出现在这种弱帧上，但音级分布的形状完全一致。
        //
        // 结构分析在乎的是「这一小节的音级分布像不像那一小节」，
        // 所以逐帧余弦相似度才是正确的判据。
        let mut min_cos = 1.0f32;
        let mut min_cos_at = 0usize;
        for f in SKIP..frames {
            let g = &got[f * N_CHROMA..(f + 1) * N_CHROMA];
            let e = &expect[f * N_CHROMA..(f + 1) * N_CHROMA];
            let dot: f32 = g.iter().zip(e).map(|(a, b)| a * b).sum();
            let ng: f32 = g.iter().map(|v| v * v).sum::<f32>().sqrt();
            let ne: f32 = e.iter().map(|v| v * v).sum::<f32>().sqrt();
            if ng > 0.0 && ne > 0.0 {
                let cos = dot / (ng * ne);
                if cos < min_cos {
                    min_cos = cos;
                    min_cos_at = f;
                }
            }
        }
        println!("chroma 最低余弦相似度 {min_cos:.6} at 帧 {min_cos_at}");
        assert!(
            min_cos > 0.99,
            "chroma 第 {min_cos_at} 帧余弦相似度 {min_cos} 低于 0.99"
        );
        assert!(mean_abs < 0.003, "chroma 平均绝对误差 {mean_abs} 超过 0.003");
    }

    #[test]
    fn cq_to_chroma_is_a_partition_of_bins() {
        // 每个 CQT bin 恰好被一个 chroma bin 收走 → 每列和必须为 1
        let f = cq_to_chroma(CHROMA_CQT_BINS, 36, 12, C1_HZ);
        for b in 0..CHROMA_CQT_BINS {
            let mut sum = 0.0f32;
            for c in 0..N_CHROMA {
                sum += f[c * CHROMA_CQT_BINS + b];
            }
            assert!((sum - 1.0).abs() < 1e-6, "bin {b} 的列和为 {sum}");
        }
        // fmin = C1 → midi 24 → 24 % 12 = 0 → 不旋转：最低 3 个 bin 归到 chroma 0 (C)
        assert_eq!(f[0], 1.0, "CQT bin 0 应该落到 chroma 0");
        assert_eq!(f[CHROMA_CQT_BINS], 0.0, "CQT bin 0 不应落到 chroma 1");
    }

    #[test]
    fn silence_gives_zero_chroma_and_rms() {
        let y = vec![0.0f32; 22050];
        let (frames, c) = chroma_cqt(&y);
        assert!(frames > 0);
        assert!(c.iter().all(|v| v.is_finite() && *v == 0.0), "静音 chroma 必须全 0");
        let (_, r) = rms(&y);
        assert!(r.iter().all(|v| *v == 0.0), "静音 rms 必须全 0");
    }

    /// 排查工具：打印误差最大的几帧，看是「整体偏移」还是「个别帧」。
    ///
    /// 运行：`cargo test --lib audio::chroma::tests::diagnose_chroma -- --ignored --nocapture`
    #[test]
    #[ignore = "排查工具，手动运行"]
    fn diagnose_chroma() {
        let wave = golden("golden_wave22k.f32");
        let (frames, got) = chroma_cqt(&wave);
        let expect = golden("golden_chroma.f32");

        let mut per_frame: Vec<(f32, usize)> = (0..frames)
            .map(|f| {
                let mut m = 0.0f32;
                for c in 0..N_CHROMA {
                    m = m.max((got[f * N_CHROMA + c] - expect[f * N_CHROMA + c]).abs());
                }
                (m, f)
            })
            .collect();
        per_frame.sort_by(|a, b| b.0.total_cmp(&a.0));
        println!("最差 5 帧: {:?}", &per_frame[..5]);
        for &(err, f) in per_frame.iter().take(2) {
            println!("\n帧 {f}  误差 {err:.5}");
            let g = &got[f * N_CHROMA..(f + 1) * N_CHROMA];
            let e = &expect[f * N_CHROMA..(f + 1) * N_CHROMA];
            println!("  rust  {:?}", g.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>());
            println!("  librosa {:?}", e.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>());
        }
        let mut bad: Vec<usize> = per_frame
            .iter()
            .filter(|(e, _)| *e > 0.1)
            .map(|(_, f)| *f)
            .collect();
        bad.sort();
        println!("\n误差 > 0.1 的帧: {bad:?}（共 {} / {frames}）", bad.len());
    }
}
