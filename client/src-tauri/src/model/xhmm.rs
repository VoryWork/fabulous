//! XHMM 解码：把逐帧和弦概率变成「和弦标签段」。
//!
//! # 它解决什么问题
//!
//! ChordNet 输出的是**逐帧**概率（每个 23ms 帧一个 301~3145 维的分布）。
//! 直接取 argmax 会得到一堆抖动的、音乐上不可能的和弦串。XHMM 是在
//! **已知和弦名**上跑 Viterbi：每帧的得分是发射概率，换和弦要付固定罚分，
//! 于是解出来的路径天然是「少数几个和弦持续若干帧」。
//!
//! # 三档词表
//!
//! | 档位 | 状态数 | 特点 |
//! |---|---|---|
//! | `submission` | 301 | 通用（默认），保留七和弦/挂留/转位 |
//! | `ismir2017` | 169 | 研究对比用，抹掉转位和低音 |
//! | `full` | 3145 | 最全，含九/十一/十三和弦 |
//!
//! 词表本身不在这里生成 —— 它依赖 `complex_chord.py` 里几百行的和弦后缀解析表。
//! 词表是静态数据，由 `neural/export_chord_vocab.py` 预计算成 TSV，
//! 这里只负责读（保证与 Python 逐状态一致）。
//!
//! # 转移罚分：`beat_arr` 全是 1
//!
//! `decode_to_chordlab(entry, probs, False)` 用的是默认
//! `use_beats=False, use_downbeats=False`，于是 `beat_arr` 是**全 1**：
//! 每一帧都按「普通拍点」收 `DIFF_TRANS_PENALTY = 30.0` 的换和弦罚分。
//! 所以这里不需要拍点信息，也就不实现 `beat_arr` 的分级逻辑（用不上）。
//!
//! # 为什么 pre 存成位图
//!
//! 朴素实现要存 `(帧数, 状态数)` 的 u32 回溯表：315 秒 × 50fps × 3145 状态
//! ≈ 2 亿项 = 800MB，不可接受。
//!
//! 但 `pre[t][c]` 只有两种取值：`c`（保持不变）或 `best_prev[t-1]`（换和弦）。
//! 所以每帧只要存 **1 个 best_prev + 状态数个 bit**，`full` 档降到 ~6MB。

use anyhow::{Context, Result};

use crate::model::chord::{CHORD_PROB_DIM, HEAD_SIZES};
use crate::model::resolve_asset;

/// 换和弦的罚分（`beat_arr == 1` 时用这个）。
const DIFF_TRANS_PENALTY: f32 = 30.0;
/// 帧移（秒）。
const DELTA: f64 = 512.0 / 22050.0;
/// 备选和弦取前几个。
const TOP_K: usize = 4;
/// 备选概率低于这个就丢掉。
const MIN_ALT_PROB: f32 = 1e-4;

/// 一个和弦段。
#[derive(Debug, Clone)]
pub struct ChordSegment {
    pub start: f64,
    pub end: f64,
    pub chord: String,
    /// 被选中和弦在该段的平均概率。
    pub confidence: f32,
    /// 备选（和弦名, 平均概率），按概率降序。
    pub alternatives: Vec<(String, f32)>,
}

/// 词表：状态数组 + 名字。
struct Vocab {
    /// 每个状态 6 个索引：triad, bass, 7th, 9th, 11th, 13th。-1 表示该位不参与。
    arrays: Vec<[i32; 6]>,
    names: Vec<String>,
}

impl Vocab {
    fn load(vocab: &str) -> Result<Self> {
        let name = format!("chord_vocab_{vocab}.tsv");
        let path = resolve_asset(&name)?;
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("读取词表失败: {}", path.display()))?;

        let mut arrays = Vec::new();
        let mut names = Vec::new();
        for (lineno, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let mut parts = line.split('\t');
            let nums = parts.next().unwrap_or("");
            let chord_name = parts.next().unwrap_or("");
            anyhow::ensure!(
                !chord_name.is_empty(),
                "词表第 {} 行缺少和弦名: {line}",
                lineno + 1
            );
            let mut arr = [-1i32; 6];
            for (i, tok) in nums.split(',').enumerate() {
                anyhow::ensure!(i < 6, "词表第 {} 行有超过 6 个索引", lineno + 1);
                arr[i] = tok
                    .trim()
                    .parse()
                    .with_context(|| format!("词表第 {} 行第 {} 个索引不是整数", lineno + 1, i))?;
            }
            // 和 Python 的 `array[i] >= prob_list[i].shape[-1]` 过滤等价，
            // 只是提前到加载期做（头宽是常量，不依赖数据）
            let in_range = arr
                .iter()
                .enumerate()
                .all(|(i, &v)| v < HEAD_SIZES[i] as i32);
            if !in_range || arr[0] < 0 {
                continue;
            }
            arrays.push(arr);
            names.push(chord_name.to_string());
        }

        anyhow::ensure!(!arrays.is_empty(), "词表 {vocab} 是空的");
        Ok(Self { arrays, names })
    }
}

/// XHMM 解码器。
pub struct Xhmm {
    vocab: Vocab,
    /// 每帧回溯位图需要的 u32 个数。
    words_per_frame: usize,
}

impl Xhmm {
    /// 加载某个档位的词表。
    pub fn load(vocab: &str) -> Result<Self> {
        let vocab = Vocab::load(vocab)?;
        let n = vocab.arrays.len();
        Ok(Self {
            words_per_frame: (n + 31) / 32,
            vocab,
        })
    }

    /// 解码整条概率序列，返回和弦段。
    ///
    /// `probs` 是 `(n_frames, 100)` 的行主序概率矩阵（来自
    /// [`crate::model::chord::ChordPredictor::predict`]）。
    pub fn decode(&self, probs: &[f32], n_frames: usize) -> Result<Vec<ChordSegment>> {
        anyhow::ensure!(
            probs.len() == n_frames * CHORD_PROB_DIM,
            "概率矩阵长度 {} 与帧数 {n_frames} 不符",
            probs.len()
        );
        anyhow::ensure!(n_frames > 0, "没有帧可以解码");

        let n = self.vocab.arrays.len();
        let words = self.words_per_frame;

        // 逐帧 log 概率：算出来就用，不整张存（full 档整张要 200MB）
        let mut row = vec![0.0f32; n];

        // ---- 前向 ----
        let mut prev_dp = vec![0.0f32; n];
        let mut cur_dp = vec![0.0f32; n];
        // 回溯用的位图 + best_prev
        let mut bits = vec![0u32; n_frames * words];
        let mut best_prev = vec![0u32; n_frames];
        let mut best_now: usize = 0;

        for t in 0..n_frames {
            self.logprob_row(probs, t, &mut row);
            if t == 0 {
                // dp[0, :] = -inf，只有状态 0（"N"）为 0
                for (c, v) in cur_dp.iter_mut().enumerate() {
                    *v = if c == 0 {
                        row[0]
                    } else {
                        f32::NEG_INFINITY
                    };
                }
            } else {
                let diff = prev_dp[best_now] - DIFF_TRANS_PENALTY;
                let fbase = t * words;
                for c in 0..n {
                    let same = prev_dp[c];
                    let use_same = same > diff;
                    if use_same {
                        bits[fbase + c / 32] |= 1u32 << (c % 32);
                        cur_dp[c] = same + row[c];
                    } else {
                        cur_dp[c] = diff + row[c];
                    }
                }
                best_prev[t] = best_now as u32;
            }
            // argmax（并列取第一个，和 np.argmax 一致）
            let mut bi = 0usize;
            let mut bv = cur_dp[0];
            for c in 1..n {
                if cur_dp[c] > bv {
                    bv = cur_dp[c];
                    bi = c;
                }
            }
            best_now = bi;
            std::mem::swap(&mut prev_dp, &mut cur_dp);
        }

        // ---- 回溯 ----
        let mut ids = vec![0usize; n_frames];
        ids[n_frames - 1] = best_now;
        for t in (0..n_frames - 1).rev() {
            let c = ids[t + 1];
            let fbase = (t + 1) * words;
            let keep = bits[fbase + c / 32] & (1u32 << (c % 32)) != 0;
            ids[t] = if keep { c } else { best_prev[t + 1] as usize };
        }

        // ---- 分段 + 备选 ----
        let mut segments = Vec::new();
        let mut last = 0usize;
        for i in 0..n_frames {
            if i + 1 == n_frames || ids[i + 1] != ids[i] {
                let s = last as f64 * DELTA;
                let e = (i + 1) as f64 * DELTA;
                let (confidence, alternatives) = self.segment_alternatives(probs, n_frames, s, e, ids[i]);
                segments.push(ChordSegment {
                    start: s,
                    end: e,
                    chord: self.vocab.names[ids[i]].clone(),
                    confidence,
                    alternatives,
                });
                last = i + 1;
            }
        }
        Ok(segments)
    }

    /// 一帧的 log 概率。
    ///
    /// 复刻 `get_chord_tag_obs`：
    /// ```text
    /// logprob = log(triad[a0]) + log(bass[a1+1]) + Σ log(suffix_k[a[k+2]])
    /// ```
    /// bass 的 `+1` 是因为 `prob_bass` 的第 0 列是「无低音」，词表里用 -1 表示。
    fn logprob_row(&self, probs: &[f32], frame: usize, out: &mut [f32]) {
        let base = frame * CHORD_PROB_DIM;
        for (c, arr) in self.vocab.arrays.iter().enumerate() {
            let mut lp = probs[base + arr[0] as usize].ln();
            let bass_col = (arr[1] + 1) as usize;
            lp += probs[base + HEAD_SIZES[0] + bass_col].ln();
            let mut col = HEAD_SIZES[0] + HEAD_SIZES[1];
            for k in 0..4 {
                let idx = arr[k + 2];
                if idx >= 0 {
                    lp += probs[base + col + idx as usize].ln();
                }
                col += HEAD_SIZES[k + 2];
            }
            out[c] = lp;
        }
    }

    /// 段内逐帧概率取平均 → 归一化 → top-k。
    ///
    /// 复刻 `_segment_alternatives`：取平均而不是取最后一帧，避免受边界干扰。
    fn segment_alternatives(
        &self,
        probs: &[f32],
        n_frames: usize,
        start: f64,
        end: f64,
        chosen: usize,
    ) -> (f32, Vec<(String, f32)>) {
        let i0 = ((start / DELTA).round() as i64).max(0) as usize;
        let i1_raw = (end / DELTA).round() as i64;
        let i1 = (i1_raw.max(i0 as i64 + 1) as usize).min(n_frames);
        if i1 <= i0 {
            return (0.0, Vec::new());
        }

        let n = self.vocab.arrays.len();
        let mut sum = vec![0.0f64; n];
        let mut row = vec![0.0f32; n];
        for t in i0..i1 {
            self.logprob_row(probs, t, &mut row);
            for c in 0..n {
                sum[c] += row[c].exp() as f64;
            }
        }
        let count = (i1 - i0) as f64;
        let total: f64 = sum.iter().map(|v| v / count).sum();
        if total <= 0.0 {
            return (0.0, Vec::new());
        }
        let mean: Vec<f32> = sum.iter().map(|v| (v / count / total) as f32).collect();

        // 按概率降序取前 TOP_K（并列按索引升序，和 np.argsort 稳定排序一致）
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by(|&a, &b| mean[b].total_cmp(&mean[a]).then(a.cmp(&b)));
        let alternatives = order
            .iter()
            .take(TOP_K)
            .filter(|&&i| mean[i] > MIN_ALT_PROB)
            .map(|&i| (self.vocab.names[i].clone(), mean[i]))
            .collect();

        (mean[chosen], alternatives)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 概率矩阵是从 golden 文件读的，和 Python 侧完全同一份输入。
    fn golden_probs() -> (Vec<f32>, usize) {
        let data = crate::model::read_golden_f32("golden_chord_median.f32");
        let frames = data.len() / CHORD_PROB_DIM;
        (data, frames)
    }

    /// 解析 golden tsv：`start \t end \t chord \t confidence \t name=prob;...`
    fn golden_lab(vocab: &str) -> Vec<ChordSegment> {
        let path = resolve_asset(&format!("golden_chord_lab_{vocab}.tsv")).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|line| {
                let f: Vec<&str> = line.split('\t').collect();
                assert_eq!(f.len(), 5, "golden 行格式不对: {line}");
                let alternatives = if f[4].is_empty() {
                    Vec::new()
                } else {
                    f[4]
                        .split(';')
                        .map(|p| {
                            let (n, v) = p.rsplit_once('=').expect("备选缺少 =");
                            (n.to_string(), v.parse::<f32>().unwrap())
                        })
                        .collect()
                };
                ChordSegment {
                    start: f[0].parse().unwrap(),
                    end: f[1].parse().unwrap(),
                    chord: f[2].to_string(),
                    confidence: f[3].parse().unwrap(),
                    alternatives,
                }
            })
            .collect()
    }

    fn check_vocab(vocab: &str) {
        let (probs, frames) = golden_probs();
        let xhmm = Xhmm::load(vocab).expect("加载词表失败");
        let got = xhmm.decode(&probs, frames).expect("解码失败");
        let expect = golden_lab(vocab);

        assert_eq!(got.len(), expect.len(), "{vocab}: 段数不一致");
        for (i, (g, e)) in got.iter().zip(expect.iter()).enumerate() {
            assert!(
                (g.start - e.start).abs() < 2e-3,
                "{vocab} 第 {i} 段 start {} vs {}",
                g.start,
                e.start
            );
            assert!(
                (g.end - e.end).abs() < 2e-3,
                "{vocab} 第 {i} 段 end {} vs {}",
                g.end,
                e.end
            );
            assert_eq!(g.chord, e.chord, "{vocab} 第 {i} 段和弦名");
            assert!(
                (g.confidence - e.confidence).abs() < 1e-3,
                "{vocab} 第 {i} 段置信度 {} vs {}",
                g.confidence,
                e.confidence
            );
            assert_eq!(
                g.alternatives.len(),
                e.alternatives.len(),
                "{vocab} 第 {i} 段备选个数"
            );
            for j in 0..e.alternatives.len() {
                assert_eq!(
                    got[i].alternatives[j].0, e.alternatives[j].0,
                    "{vocab} 第 {i} 段备选 {j} 名字"
                );
                assert!(
                    (got[i].alternatives[j].1 - e.alternatives[j].1).abs() < 1e-3,
                    "{vocab} 第 {i} 段备选 {j} 概率 {} vs {}",
                    got[i].alternatives[j].1,
                    e.alternatives[j].1
                );
            }
        }
    }

    #[test]
    fn submission_matches_python() {
        check_vocab("submission");
    }

    #[test]
    fn ismir2017_matches_python() {
        check_vocab("ismir2017");
    }

    /// `full` 有 3145 个状态，是位图回溯的真正压力测试。
    #[test]
    fn full_matches_python() {
        check_vocab("full");
    }

    #[test]
    fn vocab_has_expected_state_counts() {
        // 期望值是**过滤后**的数量：Python 的 `len(known_chord_array)` 是 301/169/3145，
        // 但 `get_chord_tag_obs` 会剔掉索引超出概率头宽度的状态。`full` 剔掉 408 个
        // （11th 只有 3 列、13th 只有 3 列，而模板里有需要更多列的和弦）。
        // 三个 golden 解码测试都通过了，说明剔除规则和 Python 等价。
        for (name, expected) in [("submission", 301), ("ismir2017", 169), ("full", 2737)] {
            let v = Vocab::load(name).expect("加载词表失败");
            assert_eq!(v.arrays.len(), expected, "{name} 状态数");
            assert_eq!(v.names[0], "N", "{name} 的第 0 个状态必须是 N");
        }
    }
}
