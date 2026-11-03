//! lv-chordia 的 ChordNet 和弦识别（5 折 ensemble）。
//!
//! # 输入
//!
//! `(帧数, 288)` 的 CQT 幅度谱（行主序），来自 [`crate::audio::cqt::hybrid_cqt`]。
//! 模型内部自己会切 `[18:270]` 取 252 维（`SHIFT_HIGH*SHIFT_STEP = 18`），
//! 所以这里**不要再切**，直接把 288 维喂进去。
//!
//! # 输出
//!
//! `(帧数, 100)` 的概率矩阵，100 列是 6 个概率头首尾相接：
//!
//! | 头 | 列区间 | 维度 | 含义 |
//! |---|---|---|---|
//! | triad | `0..73` | 73 | 6 种三和弦 × 12 根音 + 1 个「无和弦」 |
//! | bass | `73..86` | 13 | 12 个低音 + 1 |
//! | seventh | `86..90` | 4 | 3 种七音 + 1 |
//! | ninth | `90..94` | 4 | |
//! | eleventh | `94..97` | 3 | |
//! | thirteenth | `97..100` | 3 | |
//!
//! # 聚合方式：median，不是 mean
//!
//! 五折之间的分歧很大（同一段五个模型各给一个不同的和弦）。`mean` 会把
//! 少数派的峰值平均掉，HMM 收到的分布趋于均匀 → 退化成一串「无和弦」。
//! 实测《満ちてゆく》的 N 总时长：mean 47.9s(15.2%) / median 33.7s(10.7%)。
//!
//! median 之后各列不再和为 1，必须**按行重新归一化**，否则 HMM 的发射概率
//! 尺度不对。
//!
//! # 为什么不分块
//!
//! 模型里有 **bidirectional LSTM**，它对整条序列做前向 + 后向扫描。分块推理
//! 会让边界处的后向上下文丢失，结果和整段推理不等价 —— 这一点和 beat_this
//! 的纯卷积模型相反（那个必须分块，因为 T=1500 是硬约束）。

use std::path::Path;

use anyhow::{Context, Result};
use ort::session::Session;
use ort::value::Tensor;

use crate::model::beat::ensure_ort;
use crate::model::resolve_asset;

/// CQT 维度（模型内部切中间的 252 维）。
pub const CQT_DIM: usize = 288;
/// 6 个概率头的维度。
pub const HEAD_SIZES: [usize; 6] = [73, 13, 4, 4, 3, 3];
/// 概率矩阵总宽度。
pub const CHORD_PROB_DIM: usize = 100;

/// 6 个概率头在 100 列里的起始列。
///
/// **归一化必须按头分组做**，不能对整行 100 列做 —— 见 [`aggregate_median`]。
pub const HEAD_STARTS: [usize; 6] = [0, 73, 86, 90, 94, 97];
/// 折数。
pub const N_FOLDS: usize = 5;

/// 5 折 ChordNet ensemble。
pub struct ChordPredictor {
    // 每折一个 Session。5 个模型共 ~9.5 MB，常驻内存没问题。
    sessions: Vec<Session>,
}

impl ChordPredictor {
    /// 加载全部 5 折模型。
    pub fn load() -> Result<Self> {
        let env = ensure_ort()?;
        let mut sessions = Vec::with_capacity(N_FOLDS);
        for i in 0..N_FOLDS {
            let name = format!("chord_fold{i}.onnx");
            let path = resolve_asset(&name)?;
            let session = Session::builder(env)?
                .commit_from_file(&path)
                .with_context(|| format!("加载和弦模型失败: {}", path.display()))?;
            sessions.push(session);
        }
        Ok(Self { sessions })
    }

    /// 从指定目录加载（测试 / 排查用）。
    pub fn load_from_dir(dir: &Path) -> Result<Self> {
        let env = ensure_ort()?;
        let mut sessions = Vec::with_capacity(N_FOLDS);
        for i in 0..N_FOLDS {
            let path = dir.join(format!("chord_fold{i}.onnx"));
            let session = Session::builder(env)?
                .commit_from_file(&path)
                .with_context(|| format!("加载和弦模型失败: {}", path.display()))?;
            sessions.push(session);
        }
        Ok(Self { sessions })
    }

    /// 对整条 CQT 做 5 折推理 + median 聚合。
    ///
    /// `cqt` 是 `(n_frames, 288)` 的行主序展平数据。
    /// 返回 `(n_frames, 100)` 的行主序概率矩阵，每行和为 1。
    pub fn predict(&mut self, cqt: &[f32], n_frames: usize) -> Result<Vec<f32>> {
        self.predict_with_progress(cqt, n_frames, &mut |_, _| {})
    }

    /// 带进度版本：`on(已完成折数, 总折数)`。
    ///
    /// 5 折是**串行**推理（每折一次 ONNX run，整首歌的序列一次喂进去），
    /// 每折几秒，所以只能在折之间报进度 —— 但比整个和弦阶段一动不动好得多。
    pub fn predict_with_progress(
        &mut self,
        cqt: &[f32],
        n_frames: usize,
        on: &mut dyn FnMut(usize, usize),
    ) -> Result<Vec<f32>> {
        assert_eq!(
            cqt.len(),
            n_frames * CQT_DIM,
            "CQT 长度与帧数不匹配"
        );

        let total = self.sessions.len();
        let mut folds: Vec<Vec<f32>> = Vec::with_capacity(N_FOLDS);
        for (i, session) in self.sessions.iter_mut().enumerate() {
            let probs = run_fold(session, cqt, n_frames)
                .with_context(|| format!("第 {i} 折推理失败"))?;
            folds.push(probs);
            on(i + 1, total);
        }

        Ok(aggregate_median(&folds, n_frames))
    }
}

/// 单折推理：返回 `(n_frames, 100)` 行主序概率。
fn run_fold(session: &mut Session, cqt: &[f32], n_frames: usize) -> Result<Vec<f32>> {
    // 注意没有 batch 维：导出的图接受 (T, 288)
    let input = Tensor::from_array(([n_frames, CQT_DIM], cqt.to_vec()))?;
    let outputs = session.run(ort::inputs![input])?;

    let mut out = vec![0.0f32; n_frames * CHORD_PROB_DIM];
    let mut col = 0usize;
    for (k, size) in HEAD_SIZES.iter().enumerate() {
        let (_shape, data) = outputs[k]
            .try_extract_tensor::<f32>()
            .with_context(|| format!("读取第 {k} 个概率头失败"))?;
        // 图内 softmax 后的形状是 (1, T, size)，行主序展平后就是 T 行 size 列
        anyhow::ensure!(
            data.len() == n_frames * size,
            "第 {k} 个概率头长度 {} 与期望 {} 不符",
            data.len(),
            n_frames * size
        );
        for f in 0..n_frames {
            out[f * CHORD_PROB_DIM + col..f * CHORD_PROB_DIM + col + size]
                .copy_from_slice(&data[f * size..(f + 1) * size]);
        }
        col += size;
    }
    Ok(out)
}

/// 逐元素取中位数（5 折 → 第 3 小），然后**按概率头分别归一化**。
///
/// # ⚠️ 归一化必须按头分组，不能对整行 100 列做
///
/// 这条踩过坑：一开始把整行 100 列当成一个分布除以总和，结果整首歌
/// 判出一堆 `N`（108 段 vs Python 的 101 段，前 3 秒全是 N）。
///
/// 原因：Python 的 `run_chords` 是
///
/// ```python
/// avg = [np.median([p[k] for p in probs], axis=0) for k in range(6)]
/// avg = [m / m.sum(axis=1, keepdims=True) for m in avg]   # ← 每个头各自归一化
/// ]
/// ```
///
/// 每个头归一化后行和为 1，6 个头合起来是 6。若对 100 列整体归一化，
/// 每个头就被压到约 1/6，而 `logprob_row` 是**按头求和**的：
///
/// ```text
/// logprob = log(triad) + log(bass) + Σ log(suffix_k)   // 最多 6 项
/// ```
///
/// 于是「用 6 个头的和弦状态」比「只用 1 个头的 N 状态」多背 5×ln6 ≈ 9 nat，
/// 等于平白给 N 加了 9 nat 的先验 —— HMM 当然往 N 跑。
///
/// 均匀缩放本身在 Viterbi 里会互相抵消，**只有跨头的相对尺度才致命**。
fn aggregate_median(folds: &[Vec<f32>], n_frames: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; n_frames * CHORD_PROB_DIM];
    let mut buf: Vec<f32> = Vec::with_capacity(folds.len());

    for f in 0..n_frames {
        let base = f * CHORD_PROB_DIM;
        for c in 0..CHORD_PROB_DIM {
            buf.clear();
            for fold in folds {
                buf.push(fold[base + c]);
            }
            // f32 排序：概率都是有限值，直接 total_cmp
            buf.sort_by(|a, b| a.total_cmp(b));
            out[base + c] = buf[buf.len() / 2];
        }

        // 按头分组归一化（每组的行和各自变成 1，合起来是 6）
        for h in 0..HEAD_SIZES.len() {
            let lo = HEAD_STARTS[h];
            let hi = lo + HEAD_SIZES[h];
            let sum: f64 = out[base + lo..base + hi].iter().map(|v| *v as f64).sum();
            let inv = if sum > 1e-12 { (1.0 / sum) as f32 } else { 0.0 };
            for c in lo..hi {
                out[base + c] *= inv;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden_cqt() -> (Vec<f32>, usize) {
        let data = crate::model::read_golden_f32("golden_cqt.f32");
        let frames = data.len() / CQT_DIM;
        assert_eq!(data.len() % CQT_DIM, 0);
        (data, frames)
    }

    #[test]
    fn median_of_five_picks_third() {
        // aggregate_median 会遍历整行，所以每折必须补满 CHORD_PROB_DIM 列
        let mk = |v: f32| {
            let mut row = vec![0.0f32; CHORD_PROB_DIM];
            row[0] = v;
            row
        };
        let folds = vec![
            mk(0.9),
            mk(0.1),
            mk(0.5),
            mk(0.7),
            mk(0.3),
        ];
        let out = aggregate_median(&folds, 1);
        // 第 0 列中位数 0.5；第 1 列全 0 → 行和为 0.5，归一化后第 0 列变 1.0
        assert!((out[0] - 1.0).abs() < 1e-6, "得到 {}", out[0]);
        assert!(out[1].abs() < 1e-6);
    }

    #[test]
    fn each_head_is_normalized() {
        let folds: Vec<Vec<f32>> = (0..N_FOLDS)
            .map(|k| {
                // 每个头给不同的量级，确保归一化是**按头**做的而不是整行一起做
                let mut v = vec![0.0f32; CHORD_PROB_DIM];
                for h in 0..HEAD_SIZES.len() {
                    let lo = HEAD_STARTS[h];
                    for c in lo..lo + HEAD_SIZES[h] {
                        v[c] = (h + 1) as f32 * (1.0 + 0.1 * k as f32);
                    }
                }
                v
            })
            .collect();
        let out = aggregate_median(&folds, 1);
        for h in 0..HEAD_SIZES.len() {
            let lo = HEAD_STARTS[h];
            let sum: f32 = out[lo..lo + HEAD_SIZES[h]].iter().sum();
            assert!((sum - 1.0).abs() < 1e-4, "头 {h} 行和 {sum}");
        }
        // 6 个头全部加起来的和必须是 6 —— 这正是 logprob_row 按头求和的假设
        let total: f32 = out.iter().sum();
        assert!((total - 6.0).abs() < 1e-3, "总和 {total}");
    }

    /// 与 Python 的 5 折 median 聚合逐值对齐。
    #[test]
    fn probs_match_python_ensemble() {
        let (cqt, frames) = golden_cqt();
        let expected = crate::model::read_golden_f32("golden_chord_median.f32");
        assert_eq!(expected.len(), frames * CHORD_PROB_DIM);

        let mut p = ChordPredictor::load().expect("加载模型失败");
        let got = p.predict(&cqt, frames).expect("推理失败");

        let mut max_abs = 0.0f32;
        let mut argmax_mismatch = 0usize;
        for f in 0..frames {
            let base = f * CHORD_PROB_DIM;
            for c in 0..CHORD_PROB_DIM {
                max_abs = max_abs.max((got[base + c] - expected[base + c]).abs());
            }
            // triad 头的 argmax 决定和弦根音 + 类型，是最重要的判据
            let (mut gi, mut ei) = (0usize, 0usize);
            for c in 0..73 {
                if got[base + c] > got[base + gi] {
                    gi = c;
                }
                if expected[base + c] > expected[base + ei] {
                    ei = c;
                }
            }
            if gi != ei {
                argmax_mismatch += 1;
            }
        }
        println!(
            "和弦概率最大误差 {max_abs:.6}，triad argmax 不一致 {argmax_mismatch}/{frames} 帧"
        );
        assert!(
            max_abs < 2e-4,
            "和弦概率最大误差 {max_abs} 过大（>2e-4 说明 ensemble 或前处理不对）"
        );
    }
}
