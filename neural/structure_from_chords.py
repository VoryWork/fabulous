"""用**和弦序列**做段落结构分析（不用音频、不用模型）。

## 为什么不用 all-in-one-infer

它依赖 `demucs`（源分离，另一个大模型）才能出段落。对 bundle 路线（零 Python、
模型 ONNX 化）是硬伤 —— 拍点和和弦都轻量，结构却要拖一个大模型进来，不划算。

## 为什么用和弦而不是音频频谱

段落边界在音乐上主要由**和声进行的变化**界定：主歌一套进行、副歌换一套。
我们已经有 lv-chordia 的和弦序列 + 可靠的 downbeat 网格，比从频谱找自相似
更贴合语义，而且是纯算法（零模型，天然可移植到 Rust）。

## 方法

1. 以**小节**为单位取该小节的主和弦 → 12 维 chroma（根音/三音/五音/七音）
2. 算小节×小节的余弦相似度矩阵（SSM），用 4 小节窗口平滑（一个乐句）
3. 沿对角线滑 Foote 的 checkerboard kernel → novelty 曲线
4. 在 novelty 峰值处切边界，间距不小于 8 小节（避免切碎）
5. 用 SSM 给段落分组（相同和弦进行 → 同一字母）

## 两个必须注意的点

1. **边界天然对齐到小节线**。文献里 barwise 对齐能把 SALAMI 上的效果
   从 ≈60% 提到 ≈80%，我们现在正好有可信的 downbeat 网格。
2. **不追求"正确"**。SALAMI 上两个人类标注者互相也只有 F1=74% ——
   段落边界本身是主观的。这里的目标是给出一个**结构合理、便于用户修改**的初稿，
   而不是猜中标注者的心思。

用法：
    python -u neural/structure_from_chords.py <song_id>
    python -u neural/structure_from_chords.py --json <path>
"""

import json
import os
import sys

import numpy as np

# 和弦性质 → 相对根音的半音集合
QUALITY_INTERVALS = {
    "maj": [0, 4, 7],
    "min": [0, 3, 7],
    "dim": [0, 3, 6],
    "aug": [0, 4, 8],
    "sus": [0, 5, 7],
    "sus2": [0, 2, 7],
    "maj7": [0, 4, 7, 11],
    "min7": [0, 3, 7, 10],
    "7": [0, 4, 7, 10],
    "hdim7": [0, 3, 6, 10],
    "dim7": [0, 3, 6, 9],
    "minmaj7": [0, 3, 7, 11],
    "6": [0, 4, 7, 9],
    "min6": [0, 3, 7, 9],
    "9": [0, 4, 7, 10, 14],
    "maj9": [0, 4, 7, 11, 14],
    "min9": [0, 3, 7, 10, 14],
}

PITCH = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4,
    "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9,
    "A#": 10, "Bb": 10, "B": 11,
}

# 调参（都是"乐句尺度"的合理默认值）
WINDOW_BARS = 4       # SSM 平滑窗口：一个乐句
MIN_SEG_BARS = 8      # 最短段落：8 小节（2 个乐句）
KERNEL_BARS = 4       # Foote checkerboard 半径


def chord_chroma(label):
    """和弦名 → 12 维 binary chroma。解析不了返回 None。"""
    if not label or label in ("N", "未识别"):
        return None
    root = label.split(":")[0].split("/")[0].strip()
    quality = ""
    if ":" in label:
        quality = label.split(":", 1)[1].split("/")[0].strip()
    q = quality.lower()
    intervals = None
    # 最长匹配优先（min7 不能先命中 min）
    for key in sorted(QUALITY_INTERVALS, key=len, reverse=True):
        if q.startswith(key):
            intervals = QUALITY_INTERVALS[key]
            break
    if intervals is None:
        intervals = [0, 4, 7]  # 认不出来按大三和弦
    base = PITCH.get(root)
    if base is None:
        return None
    v = np.zeros(12, dtype=np.float32)
    for iv in intervals:
        v[(base + iv) % 12] = 1.0
    n = np.linalg.norm(v)
    return v / n if n > 0 else None


def bars_from_analysis(a):
    """把和弦序列摊到「每小节一个 chroma」上。"""
    downs = np.asarray(a["downbeatsSec"], dtype=float)
    nbars = len(downs)
    chords = a.get("chords", {}).get("submission", [])

    per_bar = [None] * nbars
    durations = [0.0] * nbars

    for c in chords:
        v = chord_chroma(c.get("chord", ""))
        if v is None:
            continue
        s, e = float(c["start"]), float(c["end"])
        # 找出这个和弦覆盖的小节，按时长占比投票
        for b in range(nbars):
            b0 = downs[b]
            b1 = downs[b + 1] if b + 1 < nbars else b0 + (downs[-1] - downs[-2] if nbars > 1 else 2.0)
            ov = min(e, b1) - max(s, b0)
            if ov > 0 and ov > durations[b]:
                per_bar[b] = v
                durations[b] = ov

    # 空小节沿用上一小节
    last = None
    for b in range(nbars):
        if per_bar[b] is None:
            per_bar[b] = last
        else:
            last = per_bar[b]

    return downs, per_bar


def build_ssm(per_bar):
    """小节×小节的余弦相似度，并用窗口平滑成长程结构。"""
    valid = [i for i, v in enumerate(per_bar) if v is not None]
    n = len(per_bar)
    if not valid:
        return None
    M = np.zeros((n, 12), dtype=np.float32)
    for i in valid:
        M[i] = per_bar[i]
    # 空行用最近的填充，避免相似度全 0
    for i in range(n):
        if i not in valid:
            M[i] = M[valid[0]]

    ssm = M @ M.T  # 余弦（已归一化）

    # 用 WINDOW_BARS 窗口把「相邻几小节的整体进行」也纳入相似度
    k = WINDOW_BARS
    padded = np.pad(ssm, k, mode="edge")
    sm = np.zeros_like(ssm)
    for i in range(n):
        for j in range(n):
            sm[i, j] = padded[i:i + 2 * k + 1, j:j + 2 * k + 1].mean()
    return sm


def foote_novelty(ssm, k=KERNEL_BARS):
    """沿对角线滑 checkerboard kernel，响应大的位置 = 段落边界候选。"""
    n = ssm.shape[0]
    ker = np.zeros((2 * k, 2 * k), dtype=np.float32)
    ker[:k, :k] = 1
    ker[k:, k:] = 1
    ker[:k, k:] = -1
    ker[k:, :k] = -1

    nov = np.zeros(n, dtype=np.float32)
    for i in range(k, n - k):
        nov[i] = float((ssm[i - k:i + k, i - k:i + k] * ker).sum())
    # 归一化到 0..1
    lo, hi = nov.min(), nov.max()
    if hi > lo:
        nov = (nov - lo) / (hi - lo)
    return nov


def pick_boundaries(nov, nbars, min_seg=MIN_SEG_BARS):
    """在 novelty 上挑边界：取局部峰，且间距 >= min_seg。"""
    cands = []
    for i in range(1, len(nov) - 1):
        if nov[i] >= nov[i - 1] and nov[i] >= nov[i + 1] and nov[i] > 0.15:
            cands.append((float(nov[i]), i))
    cands.sort(reverse=True)

    chosen = [0]
    for _, i in cands:
        if all(abs(i - c) >= min_seg for c in chosen):
            chosen.append(i)
    chosen.sort()

    # 尾部残段太短就并进前一段
    if len(chosen) > 1 and nbars - chosen[-1] < min_seg:
        chosen.pop()

    return chosen


def group_segments(per_bar, bounds):
    """按段内的**和弦特征均值**给段落分组（同一字母 = 同一类段落）。

    注意不能拿 SSM 的行均值当质心 —— SSM 的每一行是「该小节和其它所有小节的
    相似度」，不是它自己的和弦。用它算质心会让所有段落看起来都一样
    （实测全被判成同一组 A）。
    """
    n = len(bounds)
    total = len(per_bar)
    cents = []
    for i in range(n):
        a = bounds[i]
        b = bounds[i + 1] if i + 1 < n else total
        vs = [per_bar[k] for k in range(a, b) if per_bar[k] is not None]
        cents.append(np.mean(vs, axis=0) if vs else np.zeros(12, dtype=np.float32))

    letters: list[str] = []
    for i in range(n):
        best, best_sim = None, 0.0
        ci = cents[i]
        ni = float(np.linalg.norm(ci)) or 1e-9
        for j in range(i):
            cj = cents[j]
            sim = float(np.dot(ci, cj) / (ni * (float(np.linalg.norm(cj)) or 1e-9)))
            if sim > best_sim and sim > 0.85:
                best, best_sim = letters[j], sim
        if best is None:
            best = chr(ord('A') + len(set(letters)))
        letters.append(best)
    return letters


def analyze(a):
    downs, per_bar = bars_from_analysis(a)
    nbars = len(downs)
    ssm = build_ssm(per_bar)
    if ssm is None:
        return None
    nov = foote_novelty(ssm)
    bounds = pick_boundaries(nov, nbars)
    letters = group_segments(per_bar, bounds)

    segs = []
    for i, start in enumerate(bounds):
        end = bounds[i + 1] if i + 1 < len(bounds) else nbars
        segs.append({
            "startBar": start,
            "endBar": end,
            "bars": end - start,
            "group": letters[i],
            "t0": round(float(downs[start]), 2),
            "t1": round(float(downs[end]) if end < nbars else float(a["song"]["durationSec"]), 2),
        })
    return segs


def load_song(sid):
    base = os.path.join(os.environ["APPDATA"], "com.xmmpp.client")
    path = os.path.join(base, "songs", sid, "analysis.json")
    if os.path.exists(path):
        return json.load(open(path, encoding="utf-8")), None
    # testdata 里找
    root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "testdata", "songs")
    p = os.path.join(root, sid, "analysis.json")
    if os.path.exists(p):
        return json.load(open(p, encoding="utf-8")), None
    return None, f"找不到 {sid}"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    targets = sys.argv[1:]
    if targets == ["--all"]:
        root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "testdata", "songs")
        targets = sorted(os.listdir(root))

    for t in targets:
        a, err = load_song(t)
        if err:
            print(f"[skip] {err}")
            continue
        segs = analyze(a)
        print()
        print("=" * 70)
        print(f"  {a['song']['title']}   （{len(a['downbeatsSec'])} 小节）")
        print("=" * 70)
        if not segs:
            print("  没有可用和弦")
            continue
        print(f"  {'段':<4}{'小节':<14}{'长度':<8}{'时间':<18}组")
        for i, s in enumerate(segs, 1):
            print(f"  {i:<4}{s['startBar'] + 1:>3}-{s['endBar']:<10}"
                  f"{s['bars']:<8}{s['t0']:>7.1f}-{s['t1']:<10.1f}{s['group']}")

        # 和 all-in-one-infer 的原始输出对比
        raw = a.get("sections") or []
        if raw:
            print(f"\n  原 all-in-one-infer：{len(raw)} 段  "
                  f"→ {' '.join(str(x.get('label')) for x in raw)}")


if __name__ == "__main__":
    main()
