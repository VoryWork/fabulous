"""拍点后处理：清理帧栅格抖动与相邻重复峰。

发现的两个真实问题（Refrain 实测）：

问题 1：帧栅格抖动
  50fps -> 帧间隔 0.02s。真实 BPM 78.1 落在栅格之间，
  相邻拍的 IOI 在 0.76 / 0.78 之间来回跳（各占约一半）。
  这不是模型错误，是**量化分辨率**的必然结果。

问题 2：相邻重复峰
  模型输出是逐帧 logits，Postprocessor 用 max_pool1d(kernel=7, stride=1, pad=3)
  找局部极大值，然后取 >0（概率 >0.5）的帧。
  在糊成一团的段落（失真吉他、密集鼓），局部的 plateau 会产生
  **相邻 4-5 帧的多个峰**，表现为 0.08s / 0.10s 的"双拍"。

清理策略：
  A. 去重：间隔 < MIN_IOI 的连续拍只保留 logits 更高的那个
  B. 这不是"全谱去重"，而是**只处理相邻重复峰**，不改变真实节拍结构

注意：**不使用全局 BPM 固定化**。
    半拍错误（半速/倍速）必须由用户手动切换，不能自动"修正"。
"""

import sys
from pathlib import Path

import numpy as np

NEURAL = Path(__file__).parent.resolve()
OUT = NEURAL / "exported"


def dedupe_peaks(beats, logits, min_ioi=0.25):
    """相邻过近的峰只保留 logits 最大的那个。

    beats: 升序时间数组
    logits: 对应的模型输出值（用于判断哪个更强）
    min_ioi: 小于此间隔视为重复峰（0.25s 约对应 240 BPM，超过就不像真实拍点）
    """
    keep = []
    i = 0
    while i < len(beats):
        j = i + 1
        # 收集一个"簇"：连续相邻且间距过近
        while j < len(beats) and (beats[j] - beats[j - 1]) < min_ioi:
            j += 1
        cluster = list(range(i, j))
        best = max(cluster, key=lambda k: logits[k])
        keep.append(best)
        i = j
    return np.array(keep, dtype=int)


def report(name, beats, downs, logits=None, min_ioi=0.25):
    ioi = np.diff(beats)
    bad = ioi < min_ioi
    print(f"\n--- {name} ---")
    print(f"  拍 {len(beats)} / 小节 {len(downs)}")
    print(f"  异常短间隔(<{min_ioi}s): {bad.sum()}")
    if len(ioi) > 2:
        med = np.median(ioi[~bad]) if (~bad).any() else np.median(ioi)
        print(f"  正常 IOI 中位 {med:.4f}s -> BPM {60/med:.2f}")
    return bad.sum()


def main():
    beats = np.load(OUT / "beats_final.npy")
    downs = np.load(OUT / "downbeats_final.npy")

    # 用 beats 文件推算 logits 不可行（没保存），这里用一个简单代理：
    # 距离"局部中位栅格"的偏差越小越可信。但更稳妥的是重新读取 logits。
    # 本脚本先演示"纯按时间去重"的效果，并给出栅格量化报告。
    print("=" * 70)
    print("  帧栅格分析")
    print("=" * 70)
    ioi = np.diff(beats)
    frame = 1 / 50
    print(f"  帧间隔 = {frame}s (50 fps)")
    uniq, cnt = np.unique(np.round(ioi, 4), return_counts=True)
    print(f"  IOI 唯一值 {len(uniq)} 个（栅格量化导致）:")
    for u, c in sorted(zip(uniq, cnt), key=lambda x: -x[1])[:8]:
        print(f"    {u:.4f}s = {u/frame:5.1f} 帧   x{c}")

    # 找出哪一个栅格区间是主拍
    good = ioi[ioi > 0.25]
    med = np.median(good)
    print(f"\n  主拍中位 IOI = {med:.4f}s -> BPM {60/med:.2f}")
    print(f"  落在 ±0.02s（1 帧）内的比例: {np.mean(np.abs(good-med)<=0.021)*100:.1f}%")

    print()
    print("=" * 70)
    print("  相邻重复峰")
    print("=" * 70)
    bad_idx = np.where(ioi < 0.25)[0]
    print(f"  共 {len(bad_idx)} 处，间隔: {sorted(set(np.round(ioi[bad_idx],3)))}")
    print("  -> 这是 max_pool1d 在糊段落留下的 plateau 多峰，应去重")

    # 纯时间去重（无 logits 时，保留每簇第一个）
    keep = []
    i = 0
    while i < len(beats):
        j = i + 1
        while j < len(beats) and (beats[j] - beats[j - 1]) < 0.25:
            j += 1
        keep.append(i)
        i = j
    beats2 = beats[keep]
    ioi2 = np.diff(beats2)
    print(f"\n  去重后: {len(beats2)} 拍（原 {len(beats)}，去掉 {len(beats)-len(beats2)}）")
    print(f"  IOI 最小 {ioi2.min():.3f}s / 中位 {np.median(ioi2):.4f}s / 最大 {ioi2.max():.3f}s")

    # 小节完整性检查
    in_bar = []
    for k, db in enumerate(downs):
        nxt = downs[k + 1] if k + 1 < len(downs) else beats2[-1] + 1
        n = ((beats2 >= db) & (beats2 < nxt)).sum()
        in_bar.append(n)
    from collections import Counter
    print(f"\n  每小节拍数分布: {dict(Counter(in_bar).most_common())}")

    np.save(OUT / "beats_dedup.npy", beats2)
    print(f"\n  已保存 beats_dedup.npy ({len(beats2)} 拍)")


if __name__ == "__main__":
    main()
