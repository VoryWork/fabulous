//! 拍点后处理 —— 从逐帧 logits 到「拍的时间点（秒）」。
//!
//! # 算法（`Postprocessor(type="minimal")` 的 Rust 版）
//!
//! 1. **局部极大**：窗口 `±3` 帧（约 ±60 ms）内的最大值，且 logit > 0
//!    （即 sigmoid 后概率 > 0.5）。
//! 2. **相邻去重**：帧索引相距 ≤ 1 的合并成一个，位置取**递推平均**。
//! 3. **帧 → 秒**：`frame / 50`（模型的 50 FPS）。
//! 4. **downbeat 吸附到最近的 beat** —— 小节线必须落在拍上，这是乐理约束。
//!    模型单独预测 downbeat 时可能偏一两帧，吸附能消掉这个偏差。
//!    吸附后可能撞车，所以最后还要 `unique`。
//!
//! # 为什么第 4 步不能省
//!
//! 前端的时间轴是「拍网格 + 小节线」的结构。如果 downbeat 不落在 beat 上，
//! 会画出一条落在格子之间的竖线 —— 用户一眼就看出不对。而这一步在
//! Python 侧就是 `_postp_minimal_item` 里做的，不是额外加工。
//!
//! # 关于 `padding_mask`
//!
//! Python 侧的调用方（`analyze_song.py`）永远传全 True 的 mask，
//! 所以这里不实现 mask 参数 —— 少一个可以出错的维度。

/// 模型的帧率（Hz）。
pub const FPS: f32 = 50.0;

/// 峰值检测的窗口半径（帧）。`max_pool1d(kernel=7, padding=3)` 对应半径 3。
const PEAK_RADIUS: usize = 3;

/// 后处理结果（秒）。
pub struct Peaks {
    pub beats: Vec<f32>,
    pub downbeats: Vec<f32>,
}

/// 从 beat / downbeat 两条 logits 提取拍点。
pub fn postprocess(beat_logits: &[f32], downbeat_logits: &[f32]) -> Peaks {
    assert_eq!(
        beat_logits.len(),
        downbeat_logits.len(),
        "beat / downbeat logits 长度必须一致"
    );

    let beat_frames = pick_peaks(beat_logits);
    let downbeat_frames = pick_peaks(downbeat_logits);

    let beat_times: Vec<f32> = beat_frames.iter().map(|&f| f / FPS).collect();
    let mut downbeat_times: Vec<f32> = downbeat_frames.iter().map(|&f| f / FPS).collect();

    // downbeat 吸附到最近的 beat
    if !beat_times.is_empty() {
        for d in downbeat_times.iter_mut() {
            let mut best = 0usize;
            let mut best_dist = f32::MAX;
            for (i, &bt) in beat_times.iter().enumerate() {
                let dist = (bt - *d).abs();
                if dist < best_dist {
                    best_dist = dist;
                    best = i;
                }
            }
            *d = beat_times[best];
        }
    }

    // 吸附后会有重复（两个 downbeat 被拉到同一拍），去重
    downbeat_times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    downbeat_times.dedup_by(|a, b| (*a - *b).abs() < 1e-6);

    Peaks {
        beats: beat_times,
        downbeats: downbeat_times,
    }
}

/// 找出局部极大且 logit > 0 的帧索引，并按 `width = 1` 去重。
fn pick_peaks(logits: &[f32]) -> Vec<f32> {
    let n = logits.len();
    let mut frames: Vec<i32> = Vec::new();

    for i in 0..n {
        let v = logits[i];
        if v <= 0.0 {
            continue;
        }
        // 窗口 [i-RADIUS, i+RADIUS]，越界按 -inf 处理
        // （PyTorch 的 max_pool1d padding 填的是 -inf，不是 0）
        let lo = i.saturating_sub(PEAK_RADIUS);
        let hi = (i + PEAK_RADIUS + 1).min(n);
        let mut is_max = true;
        for &w in &logits[lo..hi] {
            if w > v {
                is_max = false;
                break;
            }
        }
        if is_max {
            frames.push(i as i32);
        }
    }

    dedupe_adjacent(&frames, 1)
}

/// 把相距 `<= width` 的帧索引合并成一个，位置取**递推平均**。
///
/// 递推平均（而非简单平均）是为了和 Python 的 `p += (p2 - p) / c` 一致 ——
/// 这个写法在整数序列上结果相同，但对齐时能避免「我以为一样其实差一帧」。
fn dedupe_adjacent(frames: &[i32], width: i32) -> Vec<f32> {
    if frames.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<f32> = Vec::new();
    let mut p = frames[0] as f32;
    let mut c = 1.0f32;

    for &f2 in &frames[1..] {
        let p2 = f2 as f32;
        if p2 - p <= width as f32 {
            c += 1.0;
            p += (p2 - p) / c;
        } else {
            out.push(p);
            p = p2;
            c = 1.0;
        }
    }
    out.push(p);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_isolated_peak() {
        let mut x = vec![-5.0f32; 100];
        x[50] = 3.0;
        let p = pick_peaks(&x);
        assert_eq!(p, vec![50.0]);
    }

    #[test]
    fn ignores_non_positive_peaks() {
        // 局部极大但 logit <= 0 → 概率 <= 0.5，不算拍
        let mut x = vec![-5.0f32; 100];
        x[50] = -1.0;
        assert!(pick_peaks(&x).is_empty());
    }

    #[test]
    fn merges_adjacent_peaks_to_mean() {
        // 两个相邻的等高峰，相距 1 帧 → 合并到中间
        let mut x = vec![-5.0f32; 100];
        x[50] = 3.0;
        x[51] = 3.0;
        let p = pick_peaks(&x);
        assert_eq!(p.len(), 1);
        assert!((p[0] - 50.5).abs() < 1e-3, "得到 {}", p[0]);
    }

    #[test]
    fn edge_peak_is_detected() {
        // 第 0 帧也是候选（padding 是 -inf，所以边缘可以成为极大）
        let mut x = vec![-5.0f32; 100];
        x[0] = 3.0;
        assert_eq!(pick_peaks(&x), vec![0.0]);
    }

    #[test]
    fn downbeats_snap_to_nearest_beat() {
        // beat 在帧 50、150；downbeat 在帧 52（偏 2 帧）
        let mut b = vec![-5.0f32; 200];
        b[50] = 3.0;
        b[150] = 3.0;
        let mut d = vec![-5.0f32; 200];
        d[52] = 3.0;
        let p = postprocess(&b, &d);
        assert_eq!(p.downbeats.len(), 1);
        assert!((p.downbeats[0] - 1.0).abs() < 1e-6, "应吸附到 50/50 = 1.0 秒");
    }

    #[test]
    fn duplicate_downbeats_are_removed_after_snapping() {
        // 两个 downbeat 吸附到同一拍 → 只留一个
        let mut b = vec![-5.0f32; 200];
        b[50] = 3.0;
        let mut d = vec![-5.0f32; 200];
        d[48] = 3.0;
        d[52] = 3.0;
        let p = postprocess(&b, &d);
        assert_eq!(p.downbeats.len(), 1);
    }

    #[test]
    fn frame_to_seconds_uses_50fps() {
        let mut x = vec![-5.0f32; 100];
        x[25] = 3.0;
        let p = postprocess(&x, &vec![-5.0f32; 100]);
        assert!((p.beats[0] - 0.5).abs() < 1e-6);
    }

    // ── 与 Python 逐值对齐 ──

    fn read_f32(b: &[u8]) -> Vec<f32> {
        b.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }

    #[test]
    fn matches_python_postprocessor() {
        let beat = read_f32(include_bytes!("../../assets/golden_beat_logits.f32"));
        let down = read_f32(include_bytes!("../../assets/golden_downbeat_logits.f32"));
        let exp_beat = read_f32(include_bytes!("../../assets/golden_beats.f32"));
        let exp_down = read_f32(include_bytes!("../../assets/golden_downbeats.f32"));

        let got = postprocess(&beat, &down);

        assert_eq!(
            got.beats.len(),
            exp_beat.len(),
            "beat 数量不一致: Rust {} vs Python {}",
            got.beats.len(),
            exp_beat.len()
        );
        for (i, (g, e)) in got.beats.iter().zip(&exp_beat).enumerate() {
            assert!(
                (g - e).abs() < 1e-5,
                "beat[{i}] Rust {g} vs Python {e}"
            );
        }

        assert_eq!(
            got.downbeats.len(),
            exp_down.len(),
            "downbeat 数量不一致: Rust {} vs Python {}",
            got.downbeats.len(),
            exp_down.len()
        );
        for (i, (g, e)) in got.downbeats.iter().zip(&exp_down).enumerate() {
            assert!(
                (g - e).abs() < 1e-5,
                "downbeat[{i}] Rust {g} vs Python {e}"
            );
        }
    }
}
