"""段落结构分析：**音频特征 + 自相似矩阵**（经典 MSA，零模型）。

## 为什么不用模型

`all-in-one-infer` 要跑 `demucs`（源分离）才能出段落，对 bundle 路线是硬伤。
而段落分析在深度学习之前就有成熟方法（Foote 2000）：

    特征序列 → 自相似矩阵(SSM) → checkerboard kernel → novelty → 切边界

全程只有 FFT / mel / DCT，没有神经网络权重，Rust 可以直接实现。

## 为什么不能只用和弦

先试过「和弦标签序列 → 12 维 chroma → SSM」，结果是**段间区分度太低**：
三首歌的分组几乎全是同一类。原因是和弦标签丢掉了太多信息 ——
音色、密度、voicing、其它乐器的活动全都看不到，而流行歌的和弦进行又高度相似。

所以必须回到**音频特征**。这里用三组互补的：

| 特征 | 捕捉什么 | 维度 |
|---|---|---|
| MFCC | 音色 / 编配变化（换乐器、加声部） | 20 |
| chroma_cqt | 和声内容（比和弦标签细，带强度） | 12 |
| RMS + spectral contrast | 能量 / 动态（段落起伏） | 8 |

按**小节**聚合（取中位数），所以边界天然对齐到小节线 ——
文献里 barwise 对齐能把 SALAMI 上的效果从 ≈60% 提到 ≈80%。

## 关于精度预期

SALAMI 上两个人类标注者互相只有 F1=74%（0.5s 容差），
所以这个脚本的目标不是「猜中标注者」，而是给出**结构合理、便于用户修改**的初稿。

用法：
    python -u neural/structure_ssm.py --all
    python -u neural/structure_ssm.py testdata/songs/02-nannan-w/analysis.json
"""

import json
import os
import sys

import librosa
import numpy as np

# ---- 参数（乐句尺度） ----
N_MFCC = 20
MIN_SEG_BARS = 8
KERNEL_BARS = 4
NOVELTY_THRESHOLD = 0.20


def bar_features(audio_path, downs):
    """把音频特征按小节聚合成 (nbars, D)。"""
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    hop = 512
    fps = sr / hop

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    rms = librosa.feature.rms(y=y, hop_length=hop)

    # ## 只用和声 + 能量（实测结论）
    #
    # 试过四组特征，用「段间相似度最高值」这个客观指标比较：
    #
    #   mfcc20 only     0.283   ← 完全没有结构信息
    #   chroma+mfcc8    0.429
    #   chroma 12       0.694
    #   chroma+rms      0.800   ← 采用
    #
    # MFCC 在这里是噪声：它描述音色细节，而同一首歌的 verse1/verse2
    # 人声细节本来就不同。结构的主要线索是**和声重复**（chroma）
    # 加上**编配厚度**（rms）。
    #
    # chroma 乘 4、rms 占半权重 —— 让 12 维和声主导、1 维能量做微调，
    # 否则 1 维能量会被 12 维和声淹没。
    feats = np.vstack([chroma * 4.0, np.log1p(rms * 100.0) * 0.5])

    nbars = len(downs)
    dur = len(y) / sr
    out = np.zeros((nbars, feats.shape[0]), dtype=np.float32)
    for b in range(nbars):
        t0 = downs[b]
        t1 = downs[b + 1] if b + 1 < nbars else dur
        i0 = max(0, int(t0 * fps))
        i1 = max(i0 + 1, min(feats.shape[1], int(t1 * fps)))
        # 中位数比均值抗瞬态（军鼓不会把整小节的代表值带偏）
        out[b] = np.median(feats[:, i0:i1], axis=1)
    # 每小节的响度（dB）。用来区分副歌和主歌 —— 副歌通常更响，
    # 这比「出现次数」可靠得多（主歌段数常常不比副歌少）。
    rms_db = np.zeros(nbars, dtype=np.float32)
    for b in range(nbars):
        t0 = downs[b]
        t1 = downs[b + 1] if b + 1 < nbars else dur
        i0 = max(0, int(t0 * fps))
        i1 = max(i0 + 1, min(rms.shape[1], int(t1 * fps)))
        rms_db[b] = 20.0 * np.log10(float(rms[:, i0:i1].mean()) + 1e-9)

    # 按维度全局标准化：chroma 和 rms 的尺度不同，不标准化会让 SSM 偏斜
    # （这一条漏掉时何なんw 只能切出 1 个边界）。
    out = (out - out.mean(axis=0)) / (out.std(axis=0) + 1e-6)

    return out, rms_db, dur


def build_ssm(feats, window):
    """小节 × 小节的余弦相似度矩阵，用 `window` 平滑成乐句尺度。"""
    F = feats / (np.linalg.norm(feats, axis=1, keepdims=True) + 1e-9)
    ssm = F @ F.T
    if window <= 1:
        return ssm
    n = ssm.shape[0]
    k = window
    padded = np.pad(ssm, k, mode="edge")
    sm = np.zeros_like(ssm)
    for i in range(n):
        for j in range(n):
            sm[i, j] = padded[i:i + 2 * k + 1, j:j + 2 * k + 1].mean()
    return sm


def foote_novelty(ssm, k=KERNEL_BARS):
    n = ssm.shape[0]
    ker = np.zeros((2 * k, 2 * k), dtype=np.float32)
    ker[:k, :k] = 1
    ker[k:, k:] = 1
    ker[:k, k:] = -1
    ker[k:, :k] = -1
    nov = np.zeros(n, dtype=np.float32)
    for i in range(k, n - k):
        nov[i] = float((ssm[i - k:i + k, i - k:i + k] * ker).sum())
    lo, hi = nov.min(), nov.max()
    if hi > lo:
        nov = (nov - lo) / (hi - lo)
    return nov


def pick_boundaries(nov, nbars, min_seg=MIN_SEG_BARS, thresh=NOVELTY_THRESHOLD):
    cands = []
    for i in range(1, len(nov) - 1):
        if nov[i] >= nov[i - 1] and nov[i] >= nov[i + 1] and nov[i] > thresh:
            cands.append((float(nov[i]), i))
    cands.sort(reverse=True)

    chosen = [0]
    for _, i in cands:
        if all(abs(i - c) >= min_seg for c in chosen):
            chosen.append(i)
    chosen.sort()
    if len(chosen) > 1 and nbars - chosen[-1] < min_seg:
        chosen.pop()
    return chosen


def group_segments(feats, bounds):
    """把段落聚成 2~4 类（相同字母 = 同类段落）。

    ## 为什么用 KMeans，而不是「和前面每个段比相似度」

    贪心匹配要求「最相似的那个已出现段」就超过阈值，而噪声让最近邻
    经常不是同类 —— 实测三首歌全部退化成 `A B C D ...` 每段一个字母。

    KMeans 是**全局**优化，只看整体分布。同一首歌的 verse1/verse2
    和声模式本来就该落进同一个簇。换掉之后：

        満ちてゆく k=2 → BBBBBBBAAAABAAAA   （前后段类型分明）
        特にない   k=2 → BABAABB            （verse/chorus 交替）

    实测段间质心相似度最高能到 0.96 —— 高度重复的段落确实存在，
    只是贪心分组连不起来。

    ## k 怎么定

    按段数选：段少时只需二分（verse/chorus），段多时再细分。
    k 太大会把同类段拆开（k=4 时満ちてゆく 就成了 DDDDDBDCCCC…）。
    """
    n = len(bounds)
    total = len(feats)
    if n <= 1:
        return ['A'] * n

    cents = []
    for i in range(n):
        a = bounds[i]
        b = bounds[i + 1] if i + 1 < n else total
        seg = feats[a:b]
        cents.append(seg.mean(axis=0) if len(seg) else np.zeros(feats.shape[1], dtype=np.float32))
    C = np.asarray(cents, dtype=np.float64)
    C = C / (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)

    k = 2 if n <= 9 else (3 if n <= 15 else 4)
    k = min(k, n)

    try:
        from sklearn.cluster import KMeans
        labels = KMeans(n_clusters=k, n_init=10, random_state=0).fit_predict(C)
    except Exception:
        # 没装 sklearn 时退化：按响度二分，至少给出「厚的段 / 薄的段」
        loud = np.array([
            float(np.mean(feats[bounds[i]:(bounds[i + 1] if i + 1 < n else total)]))
            for i in range(n)
        ])
        labels = (loud > np.median(loud)).astype(int)

    # 簇编号 → 字母，按**首次出现顺序**排，这样 A 总是第一段所在的类
    remap: dict[int, str] = {}
    letters: list[str] = []
    for lab in labels:
        key = int(lab)
        if key not in remap:
            remap[key] = chr(ord('A') + len(remap))
        letters.append(remap[key])
    return letters


# 能从结构字典里拿到的段落名（与前端 SectionLabels.ts 的「主体」组对齐）
LABEL_POOL = [
    'Chorus', 'Verse', 'Pre-Chorus', 'Post-Chorus', 'Bridge',
    'Interlude', 'Instrumental', 'Solo', 'Break', 'Riff',
]


def assign_labels(segs, rms_db):
    """把 A/B/C 重复模式映射成**结构字典里的词**。

    ## 核心规则：先按「组的角色」命名，再处理首尾

    很容易犯的错是「首段叫 Intro」按**组**去赋值 —— 那样整个 A 组
    （可能是 6 个 verse）都会叫 Intro。实测就踩过这个坑。

    正确顺序：
      1. 所有组按**平均响度**排序：最响 → `Chorus`，第二 → `Verse`
         （副歌编配最满、最响；这比「出现次数」可靠得多 ——
          主歌的段数常常不比副歌少）
      2. **然后**看首尾：只有「首段所在的组**只出现 1 次**」才改叫 `Intro`；
        「末段所在的组只出现 1 次」才改叫 `Outro`。
        如果首段就是反复出现的副歌/主歌组，那它不该叫 Intro。
      3. 其余重复组一次给 `Pre-Chorus` / `Post-Chorus` / `Bridge`。

    这只是**初稿**：错是正常的，用户右键 → 重命名 → 字典选择器就能改。
    """
    n = len(segs)
    if n == 0:
        return segs

    # ---- 1) 统计每个组 ----
    stats: dict[str, dict] = {}
    for i, s in enumerate(segs):
        g = s['group']
        lo, hi = s['startBar'], s['endBar']
        loud = float(np.mean(rms_db[lo:hi])) if hi > lo else -60.0
        d = stats.setdefault(g, {'count': 0, 'loud': 0.0, 'bars': 0})
        d['count'] += 1
        d['bars'] += hi - lo
        d['loud'] += loud
    for d in stats.values():
        d['loud'] /= d['count']

    # ---- 2) 按响度给所有组排序分配主体标签 ----
    ordered = sorted(stats.items(), key=lambda x: -x[1]['loud'])
    body_pool = ['Pre-Chorus', 'Post-Chorus', 'Bridge', 'Interlude', 'Break']
    labels: dict[str, str] = {}
    for idx, (g, _d) in enumerate(ordered):
        if idx == 0:
            labels[g] = 'Chorus'
        elif idx == 1:
            labels[g] = 'Verse'
        elif body_pool:
            labels[g] = body_pool.pop(0)
        else:
            labels[g] = f'Section {g}'

    # ---- 3) 首尾特例：只在该组**唯一出现**时才叫 Intro / Outro ----
    first_g, last_g = segs[0]['group'], segs[-1]['group']
    if stats[first_g]['count'] == 1:
        labels[first_g] = 'Intro'
    if last_g != first_g and stats[last_g]['count'] == 1:
        labels[last_g] = 'Outro'

    for s in segs:
        s['label'] = labels.get(s['group'], f"Section {s['group']}")
    return segs



def analyze(audio_path, a, window=2):
    downs = np.asarray(a["downbeatsSec"], dtype=float)
    feats, rms_db, dur = bar_features(audio_path, downs)
    nbars = len(downs)
    ssm = build_ssm(feats, window)
    nov = foote_novelty(ssm)
    bounds = pick_boundaries(nov, nbars)
    letters = group_segments(feats, bounds)

    segs = []
    for i, start in enumerate(bounds):
        end = bounds[i + 1] if i + 1 < len(bounds) else nbars
        segs.append({
            "startBar": start,
            "endBar": end,
            "bars": end - start,
            "group": letters[i],
            "t0": round(float(downs[start]), 2),
            "t1": round(float(downs[end]) if end < nbars else dur, 2),
            "peak": round(float(nov[start]), 2),
        })
    return assign_labels(segs, rms_db)


def main():
    raw_args = sys.argv[1:]
    if not raw_args:
        print(__doc__)
        return

    paths = []
    if "all" in sys.argv or "--all" in sys.argv:
        root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "testdata", "songs")
        for d in sorted(os.listdir(root)):
            ap = os.path.join(root, d, "audio.flac")
            an = os.path.join(root, d, "analysis.json")
            if os.path.exists(ap) and os.path.exists(an):
                paths.append((ap, an))
    else:
        for p in [x for x in raw_args if not x.startswith('-')]:
            base = os.path.dirname(p)
            paths.append((os.path.join(base, "audio.flac"), p))

    for audio, an_path in paths:
        a = json.load(open(an_path, encoding="utf-8"))
        segs = analyze(audio, a)
        print()
        print("=" * 72)
        print(f"  {a['song']['title']}   （{len(a['downbeatsSec'])} 小节）")
        print("=" * 72)
        print(f"  {'段':<4}{'小节':<14}{'长度':<8}{'时间':<18}{'组':<4}{'标签':<14}novelty")
        for i, s in enumerate(segs, 1):
            print(f"  {i:<4}{s['startBar'] + 1:>3}-{s['endBar']:<10}"
                  f"{s['bars']:<8}{s['t0']:>7.1f}-{s['t1']:<11.1f}"
                  f"{s['group']:<4}{s['label']:<14}{s['peak']}")

        raw = a.get("sections") or []
        if raw:
            print(f"\n  原 all-in-one-infer：{len(raw)} 段")
            line = []
            for x in raw:
                lbl = x.get("label")
                span = x.get("end", 0) - x.get("start", 0)
                line.append(f"{lbl}({span:.0f}s)")
            print("    " + "  ".join(line))


if __name__ == "__main__":
    main()
