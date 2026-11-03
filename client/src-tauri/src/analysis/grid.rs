//! 拍网格的几何修正：**拍号检测 / 用 downbeat 重建拍点 / 补漏检 / half-time 缩放**。
//!
//! 全部移植自 `neural/analyze_song.py`。这些函数不碰音频，只摆弄时间数组，
//! 是整个分析链里最容易踩坑的部分 —— 每一处都有"踩过的坑"注释，改动前请读。
//!
//! # 核心不变式
//!
//! 前端画小节线用 `downbeatsSec`，而「秒 → tick」用的是 `beatsSec` 的**下标**
//! （第 i 个拍点 = tick i×PPQ）。所以两者必须是同一个网格：
//!
//! ```text
//! downbeats[k] == beats[k * beats_per_bar]
//! ```
//!
//! 只靠模型输出保证不了（它会在小节交界处多检/漏检），所以必须
//! [`rebuild_beats_from_downbeats`] 重建一次。

/// numpy 的线性插值百分位（`np.percentile` 默认 method="linear"）。
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let idx = p / 100.0 * (sorted.len() - 1) as f64;
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    let frac = idx - lo as f64;
    sorted[lo] + (sorted[hi] - sorted[lo]) * frac
}

/// 中位数（偶数个取中间两个的平均，与 `np.median` 一致）。
pub fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let n = s.len();
    if n % 2 == 1 {
        s[n / 2]
    } else {
        (s[n / 2 - 1] + s[n / 2]) * 0.5
    }
}

/// 相邻差。
pub fn diff(v: &[f64]) -> Vec<f64> {
    v.windows(2).map(|w| w[1] - w[0]).collect()
}

/// 贪心去重：相邻间隔小于 `gap` 的点丢掉。
///
/// `run_beats` 用它把 beat_this 在小节交界处挤出来的假拍清掉
/// （实测 88 处 0.20~0.22s 的假拍，而真实拍间隔 0.42s）。
pub fn dedupe(times: &[f64], gap: f64) -> Vec<f64> {
    if times.is_empty() {
        return Vec::new();
    }
    let mut keep = vec![times[0]];
    for &t in &times[1..] {
        if t - keep[keep.len() - 1] >= gap {
            keep.push(t);
        }
    }
    keep
}

/// 推断拍号，返回 `(numerator, denominator, confidence, votes)`。
///
/// # 为什么必须检测，不能写死 4/4
///
/// 《海蓝色圆舞曲》是 6/8：beat_this 原始输出每小节 **6 拍**（0.320s × 6 = 1.92s），
/// 写死 4 拍会把它压成 4 拍 —— 715 拍 → 489 拍、BPM 93.75 → 126.32，
/// 用户一眼看出「BPM 整体快了 3/4」。而且**压完之后原始拍间隔就永久消失了，
/// 再也检测不出来**，所以必须在重建网格**之前**调。
///
/// # numerator 取众数而不是中位数
///
/// 模型会在局部漏检/多检。《海蓝色圆舞曲》的分布是 `{6: 81, 3: 47, 4: 3}`，
/// 那 47 个「3 拍」小节是半速误判，中位数会被带偏，众数才稳。
///
/// # denominator 靠分子判断，不靠 BPM 猜
///
/// 同样的拍间隔在不同分母下能算出两个都合理的 BPM
/// （0.42s：按四分是 143、按八分是 71，两个都「正常」），所以用 BPM 区间
/// 反推分母会二义。改用乐理惯例：复合拍（6/9/12）和不规则拍（5/7）的
/// 一拍是八分音符，其余是四分音符。
pub fn detect_meter(beats: &[f64], downbeats: &[f64]) -> (usize, usize, f64, usize) {
    let default = (4usize, 4usize, 0.0, 0usize);
    if beats.len() < 4 || downbeats.len() < 3 {
        return default;
    }

    // ---- 1) 统计每小节实际有几拍 ----
    // 保持**首次出现顺序**：Python 的 Counter.most_common 在票数相同时就是按
    // 插入顺序返回，所以这里不能用 BTreeMap（会按拍数排序）。
    let mut counts: Vec<(usize, usize)> = Vec::new();
    let mut j = 0usize;
    for i in 0..downbeats.len() - 1 {
        let mut k = j;
        while k < beats.len() && beats[k] < downbeats[i + 1] {
            k += 1;
        }
        if k > j {
            let n = k - j;
            match counts.iter_mut().find(|(key, _)| *key == n) {
                Some((_, c)) => *c += 1,
                None => counts.push((n, 1)),
            }
        }
        j = k;
    }
    if counts.is_empty() {
        return default;
    }

    let total: usize = counts.iter().map(|(_, c)| *c).sum();
    // most_common(1)：票数最多的那个，并列时先出现的优先
    let (numerator, votes) = *counts
        .iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
        .unwrap();
    let confidence = votes as f64 / total as f64;

    // 离谱的值（漏检成 1 拍、或碎片化）不采信
    if !(2..=16).contains(&numerator) {
        return (4, 4, confidence, votes);
    }

    // ---- 2) 分母按乐理惯例 ----
    let denominator = match numerator {
        5 | 6 | 7 | 9 | 12 => 8,
        _ => 4,
    };
    (numerator, denominator, confidence, votes)
}

/// 用 downbeats 当骨架重建拍点，保证 `downs[k] == beats[k * beats_per_bar]`。
///
/// 返回**修正过**的 downbeats —— 调用方必须用返回的这份，不能用传进来的原值，
/// 否则 `beats` 是新网格、`downbeats` 是旧边界，前端画小节线时又错位。
///
/// # 为什么不在模型输出上「删假拍」而要重建
///
/// 删假拍要先判断哪个是假的 —— 而 0.20s 和 0.42s 之间的界限在变速歌里并不牢靠
/// （慢歌一拍可能 0.6s，快歌 0.25s）。判错一个就少一拍，后面全错。
///
/// downbeats 的**数量**是可靠的（一首歌的小节数是确定的），用它当骨架就不需要
/// 判断「哪一拍是假的」：每小节固定 `beats_per_bar` 拍，位置由小节边界决定。
///
/// 代价：小节内部的轻微不均分被抹平（人耳几乎不可闻，而且这种「抢拍」本来就
/// 该由用户手动调，不该由模型噪声决定）。
///
/// # 边界情况
///
/// - 某小节内模型拍数和 `beats_per_bar` 不一致（漏检/多检）：仍然均分，
///   因为均分一定不会让**后续小节**漂移。
/// - 最后一个小节之后没有 downbeat：按最后一小节的速度外推，
///   上界**必须是音频真实时长**。
pub fn rebuild_beats_from_downbeats(
    beats: &[f64],
    downs: &[f64],
    beats_per_bar: usize,
    duration: f64,
) -> (Vec<f64>, Vec<f64>) {
    if downs.is_empty() {
        return (beats.to_vec(), downs.to_vec());
    }
    if downs.len() == 1 {
        // 只有一个小节：按已有拍的平均间隔外推
        let gap = if beats.len() > 1 {
            median(&diff(beats))
        } else {
            0.5
        };
        let n = beats.len().max(1);
        let out = (0..n).map(|k| downs[0] + k as f64 * gap).collect();
        return (out, downs.to_vec());
    }

    // ---- 先修正异常的 downbeat 间隔 ----
    //
    // 症状：**开头几小节的强拍和小节线错位**。beat_this 在歌曲开头/结尾会
    // 倍速或半速地检出拍点。实测《何なんw》：
    //
    // ```text
    // beat[0] 2.760  gap=0.340  <-DOWNBEAT
    // beat[1] 3.100  gap=0.340   ... gap 全是 0.340（正常 0.665，正好一半）
    // beat[4] 4.120  gap=0.835  <-DOWNBEAT   ← 突然跳到 0.835
    // ```
    //
    // 于是 downbeat[0]=2.760 到 downbeat[1]=4.120 只差 1.36s（约 2 拍），
    // 直接按 beats_per_bar 均分的话这一小节被压成 1.36s，后面的小节线全部前移。
    //
    // 判据：某小节时长明显偏离中位小节时长（<55% 或 >180%）。
    // 处理方式不是「删掉可疑小节」（那会凭空少一块信息），而是把该小节的边界
    // **按中位时长的整数倍重算**，保证网格连续。
    // ---- 音频真实末尾：一切外推的硬上界 ----
    //
    // ## 为什么必须在修正**之前**算好
    //
    // 下面「异常小节按整数倍拉长」的逻辑会让 `d` **累积后移**：只要有几个
    // 间隔减半的假小节，后面的小节线就整体往后推。实测《満ちてゆく》
    // 原始 downbeat 末位 307.06s，修正后推到 342.5s（曲长只有 315.4s）。
    //
    // 那些被推到曲末之后的 downbeat 是**模型在静音尾巴上的幻觉峰**，
    // 后端留着它们会让谱面比歌长（前端只能靠 totalTicks 截断掩盖）。
    let audio_end = {
        let mut e = if duration > 0.0 {
            duration
        } else if let Some(last) = beats.last() {
            *last
        } else {
            downs[downs.len() - 1]
        };
        // 原始 beats 的末拍如果没超界，用它（更贴近真实最后一拍）
        if let Some(last) = beats.last() {
            if *last <= e {
                e = *last;
            }
        }
        e
    };
    // 裁 downbeat 要用**曲长**，不能用上面那个 `audio_end` ——
    // 它会被 `beats.last()` 收窄，而末拍通常早于最后一条小节线
    // （小节线是「下一个强拍」，模型往往还没检到那里）。
    // 借用它做裁剪会平白砍掉最后一个真实小节。
    let trim_end = if duration > 0.0 {
        duration
    } else {
        downs[downs.len() - 1]
    };
    // 丢掉超出音频末尾的 downbeat —— 至少保留头两个，否则下面均分没法进行
    let mut downs_trim: Vec<f64> = downs.iter().copied().filter(|t| *t <= trim_end).collect();
    if downs_trim.len() < 2 {
        downs_trim = downs.to_vec();
    }
    let downs: &[f64] = &downs_trim;

    let med_bar = if downs.len() > 2 { median(&diff(downs)) } else { 0.0 };
    let mut d: Vec<f64> = Vec::with_capacity(downs.len());
    if med_bar > 0.0 {
        d.push(downs[0]);
        for i in 1..downs.len() {
            let mut span = downs[i] - d[d.len() - 1];
            let ratio = span / med_bar;
            if ratio < 0.55 || ratio > 1.8 {
                // 倍速/半速通常正好是 0.5x 或 2x，所以按整数倍推进
                let mult = (ratio.round() as i64).max(1);
                span = med_bar * mult as f64;
            }
            d.push(d[d.len() - 1] + span);
        }
    } else {
        d.extend_from_slice(downs);
    }

    // ---- 修正之后再裁一次 ----
    //
    // 上面「异常小节按整数倍拉长」是**累加**的：每遇到一个间隔减半的假小节，
    // 后面的小节线就整体后移一截。实测《満ちてゆく》原始末位 307.06s，
    // 修正后推到 342.5s（曲长 315.4s）。那些被推到曲末之后的「小节」不是
    // 音乐内容，只是误差累积的产物，必须丢掉 —— 否则谱面比歌长。
    if d.len() > 2 {
        let kept: Vec<f64> = d.iter().copied().filter(|t| *t <= trim_end).collect();
        if kept.len() >= 2 {
            d = kept;
        }
    }
    // ---- 每小节均分 ----
    let mut out: Vec<f64> = Vec::new();
    for i in 0..d.len() - 1 {
        let (bar_start, bar_end) = (d[i], d[i + 1]);
        let step = (bar_end - bar_start) / beats_per_bar as f64;
        for k in 0..beats_per_bar {
            out.push(bar_start + k as f64 * step);
        }
    }

    // ---- 最后一段：用最后一小节的速度外推补齐尾拍 ----
    //
    // ⚠️ `audio_end` 必须以**音频真实末尾**为上界。
    //
    // 踩过的坑：原来写 `max(b[-1], d[-1] + last_span)`，当 d 被上面的修正逻辑
    // 改过（异常小节被拉长）时 `d[-1]` 可能已经远超前于音频末尾，于是补出
    // 一大堆不存在的拍 —— 实测多出 54 秒（末拍 369s vs 曲长 315s），
    // 前端按 totalTicks 截断后表现为「谱面比歌长」。
    //
    // 另一头：beat_this 会往外推几个拍（它不知道音频什么时候结束），
    // 所以也不能直接拿 `b[-1]` 当上界 —— 实测《何なんw》末拍补到 322.08s，
    // 而曲长只有 319.97s。
    // `audio_end` 已在函数开头算好（并据此裁掉了超界的 downbeat）
    let last_span = d[d.len() - 1] - d[d.len() - 2];
    let step = last_span / beats_per_bar as f64;
    if step > 0.0 {
        let n_tail = (((audio_end - d[d.len() - 1]) / step).ceil() as i64).max(0);
        for k in 0..=n_tail {
            let t = d[d.len() - 1] + k as f64 * step;
            // 硬性截断：绝不产出超过音频末尾的拍点
            if k > 0 && t > audio_end + step {
                break;
            }
            out.push(t);
        }
    }

    (out, d)
}

/// 补全 half-time 漏检：间隔是基础间隔整数倍时插点。
///
/// `base` 取 IOI 的 **15% 分位**而不是最小值 —— 最小值会被个别假拍
/// （间隔 0.05s）拖到毫无意义的量级。
pub fn fill_half_time_gaps(times: &[f64], min_ratio: f64) -> (Vec<f64>, usize) {
    if times.len() < 3 {
        return (times.to_vec(), 0);
    }
    let mut ioi = diff(times);
    ioi.sort_by(|a, b| a.total_cmp(b));
    let base = percentile(&ioi, 15.0);
    if base <= 0.0 {
        return (times.to_vec(), 0);
    }

    let mut out = vec![times[0]];
    let mut added = 0usize;
    for &t in &times[1..] {
        let gap = t - out[out.len() - 1];
        let n = (gap / base).round() as i64;
        if n >= 2 && (gap - n as f64 * base).abs() < base * min_ratio {
            let step = gap / n as f64;
            for _ in 1..n {
                let next = out[out.len() - 1] + step;
                out.push(next);
                added += 1;
            }
        }
        out.push(t);
    }
    (out, added)
}

/// 「一小节实际有几拍」= 小节间隔 / 拍间隔。
///
/// 4/4 拍歌理想值是 4；≈2 说明拍点被整体记成 half-time。
pub fn beats_per_bar_ratio(beats: &[f64], downbeats: &[f64], beats_per_bar: usize) -> f64 {
    if beats.len() < 4 || downbeats.len() < 4 {
        return beats_per_bar as f64;
    }
    let beat_ioi = median(&diff(beats));
    let bar_ioi = median(&diff(downbeats));
    if beat_ioi <= 0.0 {
        return beats_per_bar as f64;
    }
    bar_ioi / beat_ioi
}

/// 拍点需要的缩放倍数（2.0 = half-time 要拆成两拍；0.5 = 要合并）。
///
/// 阈值 3% 的取舍：宁可漏修，也不能把 3/4 拍强行改成 4 拍
/// —— 那会静默毁掉整首歌的网格，而漏修的后果只是多一次用户手动调。
pub fn beat_scale_for_beats(downbeats: &[f64], beats: &[f64], beats_per_bar: usize) -> f64 {
    let ratio = beats_per_bar_ratio(beats, downbeats, beats_per_bar);
    if ratio <= 0.0 {
        return 1.0;
    }
    let scale = beats_per_bar as f64 / ratio;
    for candidate in [0.5, 1.0, 2.0] {
        if (scale - candidate).abs() <= candidate * 0.03 {
            return candidate;
        }
    }
    1.0
}

/// 把等距点加密/稀疏 `factor` 倍（首尾不动，线性插值）。
pub fn rescale_times(times: &[f64], factor: f64) -> Vec<f64> {
    if factor == 1.0 || times.len() < 2 {
        return times.to_vec();
    }
    if factor >= 2.0 {
        let n_sub = factor.round() as usize;
        let mut out = Vec::with_capacity(times.len() * n_sub);
        for i in 0..times.len() - 1 {
            let (a, b) = (times[i], times[i + 1]);
            for k in 0..n_sub {
                out.push(a + (b - a) * k as f64 / n_sub as f64);
            }
        }
        out.push(times[times.len() - 1]);
        return out;
    }
    let step = (1.0 / factor).round() as usize;
    let step = step.max(1);
    let mut out: Vec<f64> = times.iter().step_by(step).cloned().collect();
    if out[out.len() - 1] != times[times.len() - 1] {
        out.push(times[times.len() - 1]);
    }
    out
}

// 注：Python 的 `_pick_best_scale`（用和弦边界在两套拍网格间投票）**刻意
// 没有移植** —— 理由写在 `analysis::analyze_file` 的「2c」注释里：它只插
// `beats` 不动 `downbeats`，插完就被 `finalize` 的 `beat_scale_for_beats`
// 按 downbeats 缩回去，净效果为零；而在本来就正确的网格上它还会险胜。

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn percentile_matches_numpy_linear() {
        let v = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        // np.percentile(v, 15) = 2.35
        assert!((percentile(&v, 15.0) - 2.35).abs() < 1e-9);
        assert!((percentile(&v, 50.0) - 5.5).abs() < 1e-9);
        assert!((percentile(&v, 0.0) - 1.0).abs() < 1e-9);
        assert!((percentile(&v, 100.0) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn dedupe_keeps_first_of_cluster() {
        let t = [0.0, 0.2, 0.42, 0.62, 0.84, 1.06];
        let kept = dedupe(&t, 0.25);
        assert_eq!(kept, vec![0.0, 0.42, 0.84]);
    }

    #[test]
    fn meter_detects_four_four() {
        // 8 小节 × 4 拍，每拍 0.5s
        let mut beats = Vec::new();
        let mut downs = Vec::new();
        for b in 0..8 {
            downs.push(b as f64 * 2.0);
            for k in 0..4 {
                beats.push(b as f64 * 2.0 + k as f64 * 0.5);
            }
        }
        let (num, den, conf, votes) = detect_meter(&beats, &downs);
        assert_eq!((num, den), (4, 4));
        assert!((conf - 1.0).abs() < 1e-9);
        assert_eq!(votes, 7); // downs.len()-1 = 7 个可统计的小节
    }

    #[test]
    fn meter_detects_six_eight() {
        // 6/8：每小节 6 个八分，拍间隔 0.32s
        let mut beats = Vec::new();
        let mut downs = Vec::new();
        for b in 0..10 {
            downs.push(b as f64 * 1.92);
            for k in 0..6 {
                beats.push(b as f64 * 1.92 + k as f64 * 0.32);
            }
        }
        let (num, den, _, _) = detect_meter(&beats, &downs);
        assert_eq!((num, den), (6, 8), "6 拍 → 八分音符为一拍");
    }

    #[test]
    fn meter_uses_mode_not_median() {
        // 6 拍的小节 8 个、3 拍的小节 4 个 → 众数 6（中位数会是 4.5 → 4）
        let mut beats = Vec::new();
        let mut downs = vec![0.0];
        let mut t = 0.0;
        for i in 0..12 {
            let n = if i < 8 { 6 } else { 3 };
            t += n as f64 * 0.32;
            downs.push(t);
            for k in 0..n {
                beats.push(t - (n - k) as f64 * 0.32);
            }
        }
        let (num, _, _, votes) = detect_meter(&beats, &downs);
        assert_eq!(num, 6);
        assert_eq!(votes, 8);
    }

    #[test]
    fn rebuild_aligns_downbeats_with_beats() {
        // 3 小节 4/4，正常间隔
        let downs = vec![0.0, 2.0, 4.0, 6.0];
        // 模型在第一小节多检了拍（6 个），后面正常
        let beats = vec![
            0.0, 0.33, 0.66, 1.0, 1.33, 1.66, // 多检
            2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5,
        ];
        let (out, d) = rebuild_beats_from_downbeats(&beats, &downs, 4, 8.0);
        assert_eq!(d, downs);
        for (k, &db) in d.iter().enumerate() {
            if k * 4 < out.len() {
                assert!(approx(out[k * 4], db), "downbeats[{k}] 应等于 beats[{}]", k * 4);
            }
        }
    }

    #[test]
    fn rebuild_fixes_tempo_halved_bar() {
        // 《何なんw》开头：down[0]=2.76，down[1]=4.12 只有 1.36s（正常 2.66s）
        let downs = vec![2.76, 4.12, 6.78, 9.44, 12.10];
        let beats: Vec<f64> = (0..20).map(|i| 2.76 + i as f64 * 0.34).collect();
        let (_, d) = rebuild_beats_from_downbeats(&beats, &downs, 4, 15.0);
        // 第一个异常小节被拉回 ~2.66s（中位小节时长按后面几个算）
        assert!(
            d[1] - d[0] > 2.0,
            "异常小节应被拉长，实际 {:.3}",
            d[1] - d[0]
        );
        // 网格必须单调递增
        for w in d.windows(2) {
            assert!(w[1] > w[0]);
        }
    }

    #[test]
    fn rebuild_never_exceeds_audio_end() {
        // 曲长 15s，但 beats 末拍被模型推到 17s
        let downs = vec![0.0, 2.0, 4.0];
        let beats: Vec<f64> = (0..9).map(|i| i as f64 * 0.5).collect();
        let (out, _) = rebuild_beats_from_downbeats(&beats, &downs, 4, 15.0);
        // 上界是 beats 末拍 4.0（< 15.0）→ 不会补出超界拍
        assert!(out.iter().all(|t| *t <= 4.0 + 0.5 + 1e-9), "末拍 {}", out[out.len() - 1]);
    }

    #[test]
    fn fill_gaps_inserts_missing_beats() {
        // 基础间隔 0.5s。1.0→2.0 差 1.0s（漏 1 拍）、2.5→4.0 差 1.5s（漏 2 拍）
        let t = [0.0, 0.5, 1.0, 2.0, 2.5, 4.0];
        let (out, added) = fill_half_time_gaps(&t, 0.25);
        assert_eq!(added, 3, "共补 3 拍：1.5 / 3.0 / 3.5");
        assert_eq!(out.len(), 9);
        assert!(approx(out[3], 1.5), "1.0 与 2.0 之间应补 1.5");
        assert!(approx(out[6], 3.0) && approx(out[7], 3.5), "2.5 与 4.0 之间应补 3.0/3.5");
    }

    #[test]
    fn half_time_scale_is_two() {
        // 一小节 2.66s，拍间隔 1.33s → 应是 2 拍，4/4 需要 ×2
        let beats: Vec<f64> = (0..20).map(|i| i as f64 * 1.33).collect();
        let downs: Vec<f64> = (0..6).map(|i| i as f64 * 2.66).collect();
        assert!((beats_per_bar_ratio(&beats, &downs, 4) - 2.0).abs() < 0.01);
        assert_eq!(beat_scale_for_beats(&downs, &beats, 4), 2.0);
    }

    #[test]
    fn normal_four_four_needs_no_scale() {
        let beats: Vec<f64> = (0..20).map(|i| i as f64 * 0.5).collect();
        let downs: Vec<f64> = (0..6).map(|i| i as f64 * 2.0).collect();
        assert_eq!(beat_scale_for_beats(&downs, &beats, 4), 1.0);
    }

    #[test]
    fn three_four_is_not_mistaken_for_half_time() {
        // 3/4：一小节 3 拍，ratio = 3 → scale = 4/3 = 1.333，离 1.0 有 33%
        // 绝不能判成 0.5 或 2.0（3% 阈值的作用）
        let beats: Vec<f64> = (0..20).map(|i| i as f64 * 0.5).collect();
        let downs: Vec<f64> = (0..7).map(|i| i as f64 * 1.5).collect();
        assert_eq!(beat_scale_for_beats(&downs, &beats, 4), 1.0);
    }

    #[test]
    fn rescale_doubles_and_keeps_endpoints() {
        let t = [0.0, 1.0, 2.0];
        let out = rescale_times(&t, 2.0);
        assert_eq!(out, vec![0.0, 0.5, 1.0, 1.5, 2.0]);
        let back = rescale_times(&t, 0.5);
        assert_eq!(back, vec![0.0, 2.0]);
    }
}
