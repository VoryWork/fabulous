"""鼓组相位检查：小节起点到底落在底鼓上还是军鼓上？

用法：
    python -u neural/check_groove.py <song_id>
    python -u neural/check_groove.py --audio <音频路径> --analysis <analysis.json>

## 为什么需要这个

拍点检测（beat_this）能给出一套**间距完美均匀**的网格，但整条网格可能
**错半拍到一拍**：小节线落在军鼓上而不是底鼓上。

这种错用「间隔是否均匀」「和弦落不落小节线」都发现不了 ——
间距是均匀的，而和弦边界本身也有 ±1 拍的容忍度。
用户是**用耳朵**发现的：「第一拍一般是底鼓，第二拍是军鼓，你的第一拍是军鼓」。

所以这里用**鼓组编配的物理规律**当判据：

    4/4 流行/摇滚的 standard backbeat
      第 1、3 拍 → 底鼓（kick）    能量集中在 30~110 Hz
      第 2、4 拍 → 军鼓（snare）   鼓皮基频 150~450 Hz，频谱质心更高

判据不只看「第 1 拍低频最强」，而是看**四个位置的模式是否匹配**：
好的网格应该 kick 在 {0,2} 强、在 {1,3} 弱，snare 反过来。

## 两个坑

1. **不能用 2.5~6kHz 判断军鼓**。那是镲片和响弦的位置，每拍都在响，
   会把军鼓完全淹没（实测四个位置的高频能量几乎一样）。
   军鼓的**鼓皮**基频在 150~450 Hz，这才是区分点。

2. **必须先 HPSS 分出打击乐成分**。贝斯和底鼓在同一频段，不分离的话
   低频会被贝斯的持续音污染，测不出底鼓的瞬态。
"""

import json
import os
import sqlite3
import sys

import librosa
import numpy as np

# 频段（Hz）
KICK_BAND = (30, 110)
SNARE_BAND = (150, 450)
# 只分析中间这一段，避开前奏（可能没有鼓）和尾奏（可能淡出）
SEGMENT_START_RATIO = 0.15
SEGMENT_END_RATIO = 0.75
SEGMENT_MAX_SEC = 90.0
# 取样窗口（秒）：拍点本身有 ±20ms 抖动，窗口要比它宽
PICK_WIN_SEC = 0.05


def _band_energy(spectrogram, freqs, lo, hi):
    return spectrogram[(freqs >= lo) & (freqs < hi)].sum(axis=0)


def analyze_phase(beats, sr, y, start_index=0):
    """返回每拍的 kick / snare 特征。

    ## `start_index` 是个必须传的参数（踩过的坑）

    本函数只在某一段音频上工作，所以传进来的 `beats` 是**子集**。
    如果直接用 `enumerate` 的下标做 `% 4`，相位就完全错了 ——
    它假设子集的第一个元素就是小节起点。

    实测：整首跑是对的，取 48~138s 这段却报「网格偏了 3 拍」，
    正是因为 48s 处那拍的全局索引 mod 4 = 3。
    所以要传全局起始索引，位置按 `(start_index + i) % 4` 算。
    """
    y_perc = librosa.effects.hpss(y)[1]
    S = np.abs(librosa.stft(y_perc, n_fft=2048, hop_length=256))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    kick = _band_energy(S, freqs, *KICK_BAND)
    snare = _band_energy(S, freqs, *SNARE_BAND)
    centroid = librosa.feature.spectral_centroid(S=S, sr=sr)[0]

    fps = sr / 256.0
    w = int(PICK_WIN_SEC * fps)
    n = S.shape[1]

    rows = []
    for i, t in enumerate(beats):
        k = int(round(t * fps))
        if k < w or k >= n - w:
            continue
        seg = slice(k - w, k + w + 1)
        rows.append(
            {
                "index": start_index + i,
                "pos": (start_index + i) % 4,
                "t": float(t),
                "kick": float(kick[seg].max()),
                "snare": float(snare[seg].max()),
                "centroid": float(centroid[seg].max()),
            }
        )
    return rows


def summarize(rows):
    """按四个位置求均值，并给出判定。"""
    by_pos = {p: [] for p in range(4)}
    for r in rows:
        by_pos[r["pos"]].append(r)

    stats = []
    for p in range(4):
        vs = by_pos[p]
        if not vs:
            stats.append(None)
            continue
        stats.append(
            {
                "pos": p,
                "n": len(vs),
                "kick": float(np.mean([v["kick"] for v in vs])),
                "snare": float(np.mean([v["snare"] for v in vs])),
                "centroid": float(np.mean([v["centroid"] for v in vs])),
            }
        )
    return stats


def judge(stats):
    """判断相位是否正确。

    返回 `(offset, confidence, note)`：
      - `offset`：小节起点应该**后移**多少拍才是对的（0 表示已经正确）
      - `confidence`：0~1，越高越可信
      - `note`：人类可读的说明
    """
    if any(s is None for s in stats):
        return 0, 0.0, "有效拍太少，无法判断"

    kick = [s["kick"] for s in stats]
    snare = [s["snare"] for s in stats]
    total_k = sum(kick) or 1e-9
    total_s = sum(snare) or 1e-9

    # 标准 backbeat 期望：kick 在 0/2，snare 在 1/3
    kick_good = (kick[0] + kick[2]) / total_k      # 当前假设下 kick 的集中度
    snare_good = (snare[1] + snare[3]) / total_s
    # 反向：kick 在 1/3（说明网格偏了奇数拍）
    kick_swap = (kick[1] + kick[3]) / total_k
    snare_swap = (snare[0] + snare[2]) / total_s

    score_good = kick_good + snare_good
    score_swap = kick_swap + snare_swap

    # ## 差距不够就承认「看不出来」
    #
    # 这首歌是 swing（长 0.453s / 短 0.196s），鼓组不是标准 backbeat；
    # kick 总能量也只有 42~106（其它歌 400~800），snare 还偏偏在 1、4 拍
    # 都强。这种数据下硬判会给出误导性的「偏 3 拍」。
    #
    # 所以留一档「不明确」：两个方向的分数差不到 15% 就不下结论。
    # 宁可说不知道，也不要给个错的偏移让下游去修。
    margin = (abs(score_good - score_swap)) / max(score_good, score_swap, 1e-9)
    if margin < 0.15:
        return (
            0,
            float(max(score_good, score_swap) / 2.0),
            "鼓组模式不明确（swing / 无鼓组 / 编配特殊），建议人工确认",
        )

    if score_good >= score_swap:
        conf = score_good / 2.0
        return 0, float(conf), "底鼓在 1/3 拍、军鼓在 2/4 拍（标准 backbeat）"

    # kick 落在 1 或 3 → 偏了奇数拍。看具体是 1 还是 3
    if kick[1] >= kick[3]:
        offset, which = 1, "1"
    else:
        offset, which = 3, "3"
    conf = score_swap / 2.0
    return offset, float(conf), f"底鼓落在第 {which} 拍，网格偏了 {offset} 拍"


def load_song(song_id):
    base = os.path.join(os.environ["APPDATA"], "com.xmmpp.client")
    path = os.path.join(base, "songs", song_id, "analysis.json")
    a = json.load(open(path, encoding="utf-8"))
    con = sqlite3.connect(os.path.join(base, "musicanaz.db"))
    row = con.execute("select audio_path from songs where id = ?", (song_id,)).fetchone()
    con.close()
    if not row:
        raise SystemExit(f"找不到歌曲 {song_id}")
    return a, row[0]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    if sys.argv[1] == "--audio":
        audio = sys.argv[2]
        a = json.load(open(sys.argv[4], encoding="utf-8"))
    else:
        a, audio = load_song(sys.argv[1])

    beats = np.asarray(a["beatsSec"], dtype=float)
    if len(beats) < 8:
        print("拍点太少，跳过")
        return

    dur = float(a["song"]["durationSec"])
    t0 = dur * SEGMENT_START_RATIO
    t1 = min(dur * SEGMENT_END_RATIO, t0 + SEGMENT_MAX_SEC)
    y, sr = librosa.load(audio, sr=22050, mono=True, offset=t0, duration=t1 - t0)

    mask = (beats >= t0) & (beats < t1)
    sel = beats[mask]
    # 子集的第一个元素在整首歌里的索引 —— 相位必须基于它
    start_index = int(np.argmax(mask))
    rows = analyze_phase(sel - t0, sr, y, start_index)
    stats = summarize(rows)
    offset, conf, note = judge(stats)

    print(a["song"]["title"])
    print(f"  分析区间 {t0:.1f}~{t1:.1f}s，{len(rows)} 拍")
    print()
    print("  位置   拍数   底鼓(30-110Hz)   军鼓(150-450Hz)   频谱质心")
    for s in stats:
        if s is None:
            continue
        mark = "  ← 小节起点" if s["pos"] == 0 else ""
        print(
            f"  第{s['pos'] + 1}拍  {s['n']:4d}   {s['kick']:12.1f}   "
            f"{s['snare']:13.1f}   {s['centroid']:7.0f} Hz{mark}"
        )
    print()
    print(f"  判定: {note}")
    print(f"  置信度: {conf:.0%}")
    if offset:
        print(f"  ⚠️ 建议小节起点后移 {offset} 拍（或用 --fix 让分析流程自动校准）")


if __name__ == "__main__":
    main()
