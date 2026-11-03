//! 段落结构分析：**音频特征 + 自相似矩阵**（经典 MSA，零模型）。
//!
//! 移植自 `neural/structure_ssm.py`。整条链：
//!
//! ```text
//! chroma_cqt + rms  →  按小节取中位数  →  SSM  →  Foote checkerboard novelty
//!                   →  切边界（峰值 + 最小段长）  →  KMeans 分组  →  按响度命名
//! ```
//!
//! # 为什么不用模型
//!
//! `all-in-one-infer` 要跑 `demucs` 做源分离才有段落，这对「零 Python 分发」是硬伤。
//! 而段落分析在深度学习之前就有成熟方法（Foote 2000），纯信号处理就能到可用水平。
//!
//! # 为什么用 KMeans 而不是「和已出现的段比相似度」
//!
//! 贪心匹配要求「最相似的那个已出现段」就超过阈值，而噪声让最近邻经常不是同类
//! —— 实测三首歌全部退化成 `A B C D …` 每段一个字母。KMeans 是**全局**优化，
//! 只看整体分布，同一首歌的 verse1/verse2 和声模式本来就该落进同一个簇。
//!
//! # 为什么特征只有 chroma + RMS
//!
//! 用「段间相似度最高值」做客观指标比过四组特征：
//!
//! | 特征 | 段间相似度 |
//! |---|---|
//! | mfcc20 | 0.283 |
//! | chroma + mfcc8 | 0.429 |
//! | chroma 12 | 0.694 |
//! | **chroma + rms** | **0.800** |
//!
//! MFCC 在这里是噪声：它描述音色细节，而同一首歌 verse1/verse2 的人声细节本来就不同。
//! 结构的主要线索是**和声重复**（chroma）加**编配厚度**（rms）。

use crate::audio::chroma::N_CHROMA;

/// 特征维度：12 chroma + 1 rms。
pub const N_FEATS: usize = N_CHROMA + 1;

/// 一段的最短长度（小节）。太碎的段落对用户没意义。
pub const MIN_SEG_BARS: usize = 8;

/// Foote checkerboard 核的半径（核大小 = 2k × 2k）。
pub const KERNEL_BARS: usize = 4;

/// novelty 峰值阈值（min-max 归一化之后）。
pub const NOVELTY_THRESHOLD: f64 = 0.20;

/// SSM 的平滑窗口半径。
pub const SSM_WINDOW: usize = 2;

/// 一个结构段。
#[derive(Debug, Clone, PartialEq)]
pub struct StructureSegment {
    pub start_bar: usize,
    /// 不含（Python 侧同样是 `bounds[i+1]`，末端是 nbars）。
    pub end_bar: usize,
    /// 重复模式字母（A/B/C…），相同字母 = 同类段落。
    pub group: char,
    /// 映射到结构字典后的标签。
    pub label: String,
    pub t0: f64,
    pub t1: f64,
    /// 段首的 novelty 值。
    pub peak: f64,
}

/// 按小节聚合出来的特征矩阵（行主序，`nbars * N_FEATS`）。
pub struct BarFeatures {
    pub nbars: usize,
    pub feats: Vec<f32>,
    pub rms_db: Vec<f32>,
    pub duration: f64,
}

impl BarFeatures {
    pub fn row(&self, bar: usize) -> &[f32] {
        &self.feats[bar * N_FEATS..(bar + 1) * N_FEATS]
    }
}

/// 把逐帧 chroma / rms 按小节聚合成 `(nbars, 13)`。
///
/// 用**中位数**而不是均值：中位数抗瞬态（军鼓不会把整小节的代表值带偏）。
pub fn bar_features(
    chroma: &[f32],
    chroma_frames: usize,
    rms: &[f32],
    rms_frames: usize,
    downs: &[f64],
    duration: f64,
) -> BarFeatures {
    let nbars = downs.len();
    let fps = crate::audio::cqt::SR as f64 / crate::audio::cqt::HOP as f64;

    let mut feats = vec![0.0f32; nbars * N_FEATS];
    let mut rms_db = vec![0.0f32; nbars];
    let mut scratch: Vec<f32> = Vec::new();

    for b in 0..nbars {
        let t0 = downs[b];
        let t1 = if b + 1 < nbars { downs[b + 1] } else { duration };
        let i0 = ((t0 * fps) as i64).max(0) as usize;

        // ---- 特征 ----
        let i1 = (i1_raw(t1, fps, chroma_frames)).max(i0 + 1).min(chroma_frames);
        if i1 > i0 {
            for c in 0..N_CHROMA {
                scratch.clear();
                for f in i0..i1 {
                    scratch.push(chroma[f * N_CHROMA + c]);
                }
                feats[b * N_FEATS + c] = median(&mut scratch);
            }
            scratch.clear();
            for f in i0..i1 {
                scratch.push(rms[f]);
            }
            let m = median(&mut scratch);
            // log1p(rms * 100) * 0.5 —— 压缩动态范围，半权重让 12 维和声主导
            feats[b * N_FEATS + N_CHROMA] = (m * 100.0).ln_1p() * 0.5;
        }

        // ---- 该小节的响度（dB） ----
        let j1 = (i1_raw(t1, fps, rms_frames)).max(i0 + 1).min(rms_frames);
        let mut sum = 0.0f64;
        if j1 > i0 {
            for &v in &rms[i0..j1] {
                sum += v as f64;
            }
            sum /= (j1 - i0) as f64;
        }
        rms_db[b] = (20.0 * (sum + 1e-9).log10()) as f32;
    }

    // 按维度全局标准化：chroma 和 rms 的尺度不同，不标准化会让 SSM 偏斜
    // （这一条漏掉时《何なんw》只能切出 1 个边界）
    for c in 0..N_FEATS {
        let mut mean = 0.0f64;
        for b in 0..nbars {
            mean += feats[b * N_FEATS + c] as f64;
        }
        mean /= nbars as f64;
        let mut var = 0.0f64;
        for b in 0..nbars {
            let d = feats[b * N_FEATS + c] as f64 - mean;
            var += d * d;
        }
        // numpy 的 std 是总体标准差（ddof=0）
        let sd = (var / nbars as f64).sqrt();
        for b in 0..nbars {
            let v = feats[b * N_FEATS + c] as f64;
            feats[b * N_FEATS + c] = ((v - mean) / (sd + 1e-6)) as f32;
        }
    }

    BarFeatures {
        nbars,
        feats,
        rms_db,
        duration,
    }
}

/// `int(t * fps)`，负数归 0。
fn i1_raw(t: f64, fps: f64, _frames: usize) -> usize {
    (t * fps) as i64 as usize
}

/// 中位数（偶数个取中间两个的平均）。
fn median(v: &mut [f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) * 0.5
    }
}

/// 小节 × 小节的余弦相似度矩阵，用 `window` 平滑成乐句尺度。
///
/// 平滑用 edge 填充的 `(2w+1)²` 均值滤波 —— 让「同一段落内部」和
/// 「段落交界处」的差异更明显，checkerboard 核才有东西可抓。
pub fn build_ssm(feats: &[f32], nbars: usize, window: usize) -> Vec<f32> {
    let mut f = feats.to_vec();
    for b in 0..nbars {
        let row = &mut f[b * N_FEATS..(b + 1) * N_FEATS];
        let norm = row.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>().sqrt();
        let d = (norm + 1e-9) as f32;
        for v in row.iter_mut() {
            *v /= d;
        }
    }

    let mut ssm = vec![0.0f32; nbars * nbars];
    for i in 0..nbars {
        for j in 0..nbars {
            let mut acc = 0.0f32;
            for c in 0..N_FEATS {
                acc += f[i * N_FEATS + c] * f[j * N_FEATS + c];
            }
            ssm[i * nbars + j] = acc;
        }
    }

    if window <= 1 {
        return ssm;
    }
    let k = window;
    let at = |i: i64, j: i64| -> f32 {
        let ii = i.clamp(0, nbars as i64 - 1) as usize;
        let jj = j.clamp(0, nbars as i64 - 1) as usize;
        ssm[ii * nbars + jj]
    };
    let mut sm = vec![0.0f32; nbars * nbars];
    let span = (2 * k + 1) as f32;
    for i in 0..nbars {
        for j in 0..nbars {
            let mut acc = 0.0f32;
            for di in 0..(2 * k + 1) {
                for dj in 0..(2 * k + 1) {
                    acc += at(i as i64 + di as i64 - k as i64, j as i64 + dj as i64 - k as i64);
                }
            }
            sm[i * nbars + j] = acc / (span * span);
        }
    }
    sm
}

/// Foote checkerboard novelty：对角线两块求和，反对角两块求差。
///
/// 值大 = 这个位置前后风格突变 = 段落边界。
pub fn foote_novelty(ssm: &[f32], nbars: usize, k: usize) -> Vec<f64> {
    let mut nov = vec![0.0f64; nbars];
    for i in k..nbars.saturating_sub(k) {
        let mut acc = 0.0f64;
        for di in 0..(2 * k) {
            for dj in 0..(2 * k) {
                let sign = if (di < k) == (dj < k) { 1.0 } else { -1.0 };
                let r = i - k + di;
                let c = i - k + dj;
                acc += sign * ssm[r * nbars + c] as f64;
            }
        }
        nov[i] = acc;
    }
    let lo = nov.iter().cloned().fold(f64::INFINITY, f64::min);
    let hi = nov.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if hi > lo {
        for v in nov.iter_mut() {
            *v = (*v - lo) / (hi - lo);
        }
    }
    nov
}

/// 挑段落边界：局部极大 + 高于阈值 + 最小段长约束。
pub fn pick_boundaries(nov: &[f64], nbars: usize, min_seg: usize, thresh: f64) -> Vec<usize> {
    let mut cands: Vec<(f64, usize)> = Vec::new();
    for i in 1..nov.len().saturating_sub(1) {
        if nov[i] >= nov[i - 1] && nov[i] >= nov[i + 1] && nov[i] > thresh {
            cands.push((nov[i], i));
        }
    }
    // Python: cands.sort(reverse=True) —— 值降序，并列时索引**大**的优先
    cands.sort_by(|a, b| b.0.total_cmp(&a.0).then(b.1.cmp(&a.1)));

    let mut chosen = vec![0usize];
    for &(_, i) in &cands {
        if chosen.iter().all(|&c| (i as i64 - c as i64).unsigned_abs() as usize >= min_seg) {
            chosen.push(i);
        }
    }
    chosen.sort_unstable();
    if chosen.len() > 1 && nbars - chosen[chosen.len() - 1] < min_seg {
        chosen.pop();
    }
    chosen
}

/// 把段落聚成 2~4 类（相同字母 = 同类段落）。
pub fn group_segments(feats: &[f32], nbars: usize, bounds: &[usize]) -> Vec<char> {
    let n = bounds.len();
    if n <= 1 {
        return vec!['A'; n];
    }

    // 段质心 → 行归一化
    let mut cents = vec![0.0f64; n * N_FEATS];
    for i in 0..n {
        let a = bounds[i];
        let b = if i + 1 < n { bounds[i + 1] } else { nbars };
        if b > a {
            for bar in a..b {
                for c in 0..N_FEATS {
                    cents[i * N_FEATS + c] += feats[bar * N_FEATS + c] as f64;
                }
            }
            for c in 0..N_FEATS {
                cents[i * N_FEATS + c] /= (b - a) as f64;
            }
        }
        let norm = cents[i * N_FEATS..(i + 1) * N_FEATS]
            .iter()
            .map(|v| v * v)
            .sum::<f64>()
            .sqrt();
        for c in 0..N_FEATS {
            cents[i * N_FEATS + c] /= norm + 1e-9;
        }
    }

    // 段少时只需二分（verse/chorus），段多时再细分。
    // k 太大会把同类段拆开（k=4 时《満ちてゆく》就成了 DDDDDBDCCCC…）
    let mut k = if n <= 9 {
        2
    } else if n <= 15 {
        3
    } else {
        4
    };
    k = k.min(n);

    let labels = kmeans(&cents, n, N_FEATS, k);

    // 簇编号 → 字母，按**首次出现顺序**排，这样 A 总是第一段所在的类
    let mut remap: Vec<Option<char>> = vec![None; k];
    let mut next = 0usize;
    let mut out = Vec::with_capacity(n);
    for &lab in &labels {
        if remap[lab].is_none() {
            remap[lab] = Some((b'A' + next as u8) as char);
            next += 1;
        }
        out.push(remap[lab].unwrap());
    }
    out
}

/// k-means++ 初始化 + Lloyd 迭代，多次重启取 inertia 最小的那次。
///
/// # 为什么不逐位对齐 sklearn
///
/// sklearn 的 `KMeans(n_init=10, random_state=0)` 用自己的 MT19937 流，
/// 逐位复现它需要连 RNG 的调用顺序一起抄。这里用固定的 splitmix64、
/// `n_local_trials = 2 + ln(k)` 次候选试探、10 次重启 —— 实现的是同一套算法。
///
/// 段数最多几十、维度 13，k ≤ 4，最优解几乎总能找到；golden 测试
/// 直接比字母序列，如果真的收敛到不同局部极值会立刻暴露。
fn kmeans(data: &[f64], n: usize, dim: usize, k: usize) -> Vec<usize> {
    let mut rng = SplitMix64::new(0x5eed);
    let mut best_labels = vec![0usize; n];
    let mut best_inertia = f64::INFINITY;

    for _ in 0..10 {
        let centers = kmeans_plus_plus(data, n, dim, k, &mut rng);
        let (labels, inertia) = lloyd(data, n, dim, k, centers);
        if inertia < best_inertia {
            best_inertia = inertia;
            best_labels = labels;
        }
    }
    best_labels
}

fn kmeans_plus_plus(data: &[f64], n: usize, dim: usize, k: usize, rng: &mut SplitMix64) -> Vec<f64> {
    let mut centers = vec![0.0f64; k * dim];
    let first = rng.next_below(n);
    centers[..dim].copy_from_slice(&data[first * dim..(first + 1) * dim]);

    let mut closest = vec![0.0f64; n];
    for i in 0..n {
        closest[i] = dist2(data, i, &centers, 0, dim);
    }

    // sklearn: n_local_trials = 2 + int(log(k))
    let n_trials = 2 + (k as f64).ln() as usize;
    for c in 1..k {
        let pot: f64 = closest.iter().sum();
        let mut best_cand = 0usize;
        let mut best_cost = f64::INFINITY;
        let mut best_closest = closest.clone();

        for _ in 0..n_trials {
            // 按距离平方（= 对 inertia 的贡献）加权采样
            let cand = if pot > 0.0 {
                let target = rng.next_f64() * pot;
                let mut acc = 0.0;
                let mut pick = n - 1;
                for i in 0..n {
                    acc += closest[i];
                    if acc >= target {
                        pick = i;
                        break;
                    }
                }
                pick
            } else {
                rng.next_below(n)
            };

            let mut cost = 0.0f64;
            let mut cand_closest = Vec::with_capacity(n);
            for i in 0..n {
                let d = dist2(data, i, &data, cand, dim);
                let m = closest[i].min(d);
                cand_closest.push(m);
                cost += m;
            }
            if cost < best_cost {
                best_cost = cost;
                best_cand = cand;
                best_closest = cand_closest;
            }
        }

        centers[c * dim..(c + 1) * dim].copy_from_slice(&data[best_cand * dim..(best_cand + 1) * dim]);
        closest = best_closest;
    }
    centers
}

fn lloyd(
    data: &[f64],
    n: usize,
    dim: usize,
    k: usize,
    mut centers: Vec<f64>,
) -> (Vec<usize>, f64) {
    let mut labels = vec![0usize; n];
    for _ in 0..300 {
        // ---- 分配 ----
        let mut changed = false;
        for i in 0..n {
            let mut best = 0usize;
            let mut best_d = f64::INFINITY;
            for c in 0..k {
                let d = dist2(data, i, &centers, c, dim);
                if d < best_d {
                    best_d = d;
                    best = c;
                }
            }
            if labels[i] != best {
                labels[i] = best;
                changed = true;
            }
        }
        if !changed {
            break;
        }

        // ---- 更新 ----
        let mut sums = vec![0.0f64; k * dim];
        let mut counts = vec![0usize; k];
        for i in 0..n {
            counts[labels[i]] += 1;
            for c in 0..dim {
                sums[labels[i] * dim + c] += data[i * dim + c];
            }
        }
        let mut moved = 0.0f64;
        for c in 0..k {
            if counts[c] == 0 {
                continue; // 空簇保留原中心（sklearn 会挪用最远点，这里数据量小可忽略）
            }
            for d in 0..dim {
                let new = sums[c * dim + d] / counts[c] as f64;
                let delta = new - centers[c * dim + d];
                moved += delta * delta;
                centers[c * dim + d] = new;
            }
        }
        if moved < 1e-12 {
            break;
        }
    }

    let mut inertia = 0.0f64;
    for i in 0..n {
        inertia += dist2(data, i, &centers, labels[i], dim);
    }
    (labels, inertia)
}

fn dist2(data: &[f64], i: usize, centers: &[f64], c: usize, dim: usize) -> f64 {
    let mut acc = 0.0;
    for d in 0..dim {
        let delta = data[i * dim + d] - centers[c * dim + d];
        acc += delta * delta;
    }
    acc
}

/// splitmix64 —— 只要确定性，不需要密码学质量。
struct SplitMix64(u64);

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self(seed)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn next_below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

// ─────────────────────────── 命名 ───────────────────────────

/// 把 A/B/C 重复模式映射成**结构字典里的词**。
///
/// ## 核心规则：先按「组的角色」命名，再处理首尾
///
/// 很容易犯的错是「首段叫 Intro」按**组**去赋值 —— 那样整个 A 组
/// （可能是 6 个 verse）都会叫 Intro。实测就踩过这个坑。
///
/// 1. 所有组按**平均响度**排序：最响 → `Chorus`，第二 → `Verse`
///    （副歌编配最满、最响；这比「出现次数」可靠得多 —— 主歌的段数常常不比副歌少）
/// 2. **然后**看首尾：只有「首段所在的组**只出现 1 次**」才改叫 `Intro`；
///    「末段所在的组只出现 1 次」才改叫 `Outro`。
///    如果首段就是反复出现的副歌/主歌组，那它不该叫 Intro。
/// 3. 其余重复组依次给 `Pre-Chorus` / `Post-Chorus` / `Bridge`…
///
/// 这只是**初稿**：用户右键 → 重命名 → 从字典里选就能改。
pub fn assign_labels(segs: &mut [StructureSegment], rms_db: &[f32]) {
    if segs.is_empty() {
        return;
    }

    // ---- 1) 统计每个组：出现次数、总小节数、平均响度 ----
    struct Stat {
        group: char,
        count: usize,
        loud: f64,
    }
    let mut stats: Vec<Stat> = Vec::new();
    for s in segs.iter() {
        let loud = if s.end_bar > s.start_bar {
            rms_db[s.start_bar..s.end_bar].iter().map(|v| *v as f64).sum::<f64>()
                / (s.end_bar - s.start_bar) as f64
        } else {
            -60.0
        };
        match stats.iter_mut().find(|x| x.group == s.group) {
            Some(x) => {
                x.count += 1;
                x.loud += loud;
            }
            None => stats.push(Stat {
                group: s.group,
                count: 1,
                loud,
            }),
        }
    }
    for s in stats.iter_mut() {
        s.loud /= s.count as f64;
    }

    // ---- 2) 按响度给所有组排序分配主体标签 ----
    let mut ordered: Vec<&Stat> = stats.iter().collect();
    ordered.sort_by(|a, b| b.loud.total_cmp(&a.loud));
    let body_pool = ["Pre-Chorus", "Post-Chorus", "Bridge", "Interlude", "Break"];
    let mut pool_iter = body_pool.iter();
    let mut labels: Vec<(char, String)> = Vec::new();
    for (idx, st) in ordered.iter().enumerate() {
        let label = if idx == 0 {
            "Chorus".to_string()
        } else if idx == 1 {
            "Verse".to_string()
        } else if let Some(next) = pool_iter.next() {
            next.to_string()
        } else {
            format!("Section {}", st.group)
        };
        labels.push((st.group, label));
    }

    // ---- 3) 首尾特例：只在该组**唯一出现**时才叫 Intro / Outro ----
    let first_g = segs[0].group;
    let last_g = segs[segs.len() - 1].group;
    let count_of = |g: char| stats.iter().find(|s| s.group == g).map(|s| s.count).unwrap_or(0);
    if count_of(first_g) == 1 {
        if let Some(x) = labels.iter_mut().find(|(g, _)| *g == first_g) {
            x.1 = "Intro".to_string();
        }
    }
    if last_g != first_g && count_of(last_g) == 1 {
        if let Some(x) = labels.iter_mut().find(|(g, _)| *g == last_g) {
            x.1 = "Outro".to_string();
        }
    }

    for s in segs.iter_mut() {
        s.label = labels
            .iter()
            .find(|(g, _)| *g == s.group)
            .map(|(_, l)| l.clone())
            .unwrap_or_else(|| format!("Section {}", s.group));
    }
}

/// 从特征矩阵出发的完整结构推断（不碰音频，方便用 golden 数据验收）。
pub fn analyze_from_features(
    feats: &[f32],
    nbars: usize,
    rms_db: &[f32],
    downs: &[f64],
    duration: f64,
) -> Vec<StructureSegment> {
    let ssm = build_ssm(feats, nbars, SSM_WINDOW);
    let nov = foote_novelty(&ssm, nbars, KERNEL_BARS);
    let bounds = pick_boundaries(&nov, nbars, MIN_SEG_BARS, NOVELTY_THRESHOLD);
    let letters = group_segments(feats, nbars, &bounds);

    let mut segs: Vec<StructureSegment> = bounds
        .iter()
        .enumerate()
        .map(|(i, &start)| {
            let end = if i + 1 < bounds.len() { bounds[i + 1] } else { nbars };
            StructureSegment {
                start_bar: start,
                end_bar: end,
                group: letters[i],
                label: String::new(),
                t0: downs[start],
                t1: if end < nbars { downs[end] } else { duration },
                peak: nov[start],
            }
        })
        .collect();
    assign_labels(&mut segs, rms_db);
    segs
}

/// 完整链：逐帧 chroma / rms → 结构段。
pub fn analyze(
    chroma: &[f32],
    chroma_frames: usize,
    rms: &[f32],
    rms_frames: usize,
    downs: &[f64],
    duration: f64,
) -> Vec<StructureSegment> {
    let bf = bar_features(chroma, chroma_frames, rms, rms_frames, downs, duration);
    analyze_from_features(&bf.feats, bf.nbars, &bf.rms_db, downs, bf.duration)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden(name: &str) -> Vec<f32> {
        crate::model::read_golden_f32(name)
    }

    fn f64s(name: &str) -> Vec<f64> {
        crate::model::read_golden_f32(name)
            .into_iter()
            .map(|v| v as f64)
            .collect()
    }

    fn golden_segments() -> Vec<StructureSegment> {
        let path = crate::model::resolve_asset("golden_struct_segments.tsv").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|line| {
                let f: Vec<&str> = line.split('\t').collect();
                assert_eq!(f.len(), 7, "golden 段格式不对: {line}");
                StructureSegment {
                    start_bar: f[0].parse().unwrap(),
                    end_bar: f[1].parse().unwrap(),
                    group: f[2].chars().next().unwrap(),
                    label: f[3].to_string(),
                    peak: f[4].parse().unwrap(),
                    t0: f[5].parse().unwrap(),
                    t1: f[6].parse().unwrap(),
                }
            })
            .collect()
    }

    /// 《特にない》85 小节：从 Python 算好的 feats 出发，走到同一组段落。
    #[test]
    fn structure_matches_python() {
        let feats = golden("golden_struct_feats.f32");
        let rms_db = golden("golden_struct_rmsdb.f32");
        let downs = f64s("golden_struct_downbeats.f32");
        let golden_nov = f64s("golden_struct_novelty.f32");
        let expect = golden_segments();

        let nbars = downs.len();
        assert_eq!(feats.len(), nbars * N_FEATS);
        assert_eq!(rms_db.len(), nbars);

        // ---- novelty 先单独比 ----
        let ssm = build_ssm(&feats, nbars, SSM_WINDOW);
        let nov = foote_novelty(&ssm, nbars, KERNEL_BARS);
        let mut max_d = 0.0f64;
        for i in 0..nbars {
            max_d = max_d.max((nov[i] - golden_nov[i]).abs());
        }
        println!("novelty 最大绝对误差 {max_d:.6}");
        assert!(max_d < 1e-4, "novelty 最大误差 {max_d} 超过 1e-4");

        // ---- 边界 ----
        let bounds = pick_boundaries(&nov, nbars, MIN_SEG_BARS, NOVELTY_THRESHOLD);
        let expect_bounds: Vec<usize> = expect.iter().map(|s| s.start_bar).collect();
        assert_eq!(bounds, expect_bounds, "边界不一致");

        // ---- 字母序列 ----
        let letters = group_segments(&feats, nbars, &bounds);
        let expect_letters: Vec<char> = expect.iter().map(|s| s.group).collect();
        assert_eq!(letters, expect_letters, "分组字母不一致");

        // ---- 完整段（含标签） ----
        let got = analyze_from_features(&feats, nbars, &rms_db, &downs, 205.26);
        assert_eq!(got.len(), expect.len(), "段数不一致");
        for (i, (g, e)) in got.iter().zip(expect.iter()).enumerate() {
            assert_eq!(g.start_bar, e.start_bar, "第 {i} 段 start_bar");
            assert_eq!(g.end_bar, e.end_bar, "第 {i} 段 end_bar");
            assert_eq!(g.group, e.group, "第 {i} 段 group");
            assert_eq!(g.label, e.label, "第 {i} 段 label");
            assert!((g.t0 - e.t0).abs() < 0.02, "第 {i} 段 t0 {} vs {}", g.t0, e.t0);
            assert!((g.t1 - e.t1).abs() < 0.02, "第 {i} 段 t1 {} vs {}", g.t1, e.t1);
        }
    }

    /// 中位数：偶数个取中间两个的平均（和 np.median 一致）。
    #[test]
    fn median_matches_numpy() {
        assert_eq!(median(&mut [3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&mut [4.0, 1.0, 3.0, 2.0]), 2.5);
        assert_eq!(median(&mut [7.0]), 7.0);
    }

    /// SSM 对角线恒为 1（行归一化后自相似度满）。
    #[test]
    fn ssm_diagonal_is_one() {
        let n = 5;
        let feats: Vec<f32> = (0..n * N_FEATS).map(|i| (i % 7) as f32 + 1.0).collect();
        let ssm = build_ssm(&feats, n, 1);
        for i in 0..n {
            assert!((ssm[i * n + i] - 1.0).abs() < 1e-5, "对角线 {i} = {}", ssm[i * n + i]);
        }
    }

    /// 边界必须从 0 开始、严格递增、且每段不短于 min_seg。
    #[test]
    fn boundaries_respect_min_segment() {
        let nov: Vec<f64> = (0..40)
            .map(|i| if i % 10 == 0 { 0.9 } else { 0.1 })
            .collect();
        let b = pick_boundaries(&nov, 40, 8, 0.2);
        assert_eq!(b[0], 0);
        for w in b.windows(2) {
            assert!(w[1] - w[0] >= 8, "段太短: {w:?}");
        }
    }

    /// 相同输入 → 相同分组（k-means 必须是确定性的）。
    #[test]
    fn kmeans_is_deterministic() {
        // 8 段 → k = 2（n <= 9 才二分；12 段会走 k=3，那不是这个测试要验的）
        let n = 8;
        let mut feats = vec![0.0f32; n * N_FEATS];
        for i in 0..n {
            // 前 4 段一种模式，后 4 段另一种
            let base = if i < 4 { 1.0 } else { -1.0 };
            for c in 0..N_FEATS {
                feats[i * N_FEATS + c] = base * (c as f32 + 1.0) + (i % 2) as f32 * 0.01;
            }
        }
        let bounds: Vec<usize> = (0..n).collect();
        let a = group_segments(&feats, n, &bounds);
        let b = group_segments(&feats, n, &bounds);
        assert_eq!(a, b, "两次调用结果必须相同");
        assert_eq!(a[0], a[3], "前 4 段应同组");
        assert_eq!(a[4], a[7], "后 4 段应同组");
        assert_ne!(a[0], a[4], "两组应不同");
    }

    /// 组只出现一次时首段叫 Intro、末段叫 Outro；反复出现的组不叫。
    #[test]
    fn labels_use_intro_outro_only_for_unique_groups() {
        let mk = |sb: usize, eb: usize, g: char| StructureSegment {
            start_bar: sb,
            end_bar: eb,
            group: g,
            label: String::new(),
            t0: 0.0,
            t1: 0.0,
            peak: 0.0,
        };
        let mut segs = vec![mk(0, 4, 'A'), mk(4, 12, 'B'), mk(12, 16, 'C')];
        // A 最静、C 其次、B 最响 → B=Chorus, C=Verse, A=Intro（唯一出现）
        let rms_db = vec![
            -40.0, -40.0, -40.0, -40.0, // A
            -10.0, -10.0, -10.0, -10.0, -10.0, -10.0, -10.0, -10.0, // B
            -20.0, -20.0, -20.0, -20.0, // C
        ];
        assign_labels(&mut segs, &rms_db);
        assert_eq!(segs[1].label, "Chorus", "最响的组");
        // C 组既是「第二响」（Verse）又是「唯一出现的末段」，后者**覆盖**前者 ——
        // 这正是 Python 的顺序：先按响度赋主体标签，再处理首尾特例。
        assert_eq!(segs[2].label, "Outro", "唯一出现的末段覆盖 Verse");
        assert_eq!(segs[0].label, "Intro", "唯一出现的首段");

        // 首段所在组反复出现 → 不能叫 Intro
        let mut segs = vec![mk(0, 4, 'A'), mk(4, 8, 'B'), mk(8, 12, 'A')];
        let rms_db = vec![-30.0; 12];
        assign_labels(&mut segs, &rms_db);
        assert_ne!(segs[0].label, "Intro");
        assert_ne!(segs[2].label, "Outro");
    }
}
