"""检查小节线是否落在音乐的强拍上（客观依据）。

用法：
    python -u neural/check_energy.py <song_id>

## 为什么需要这个

判断 downbeat 对错时，"看起来规整"不算证据 —— 一条错位的小节线也可以
间距完全均匀。真正的依据是**音乐本身**：小节起点必然伴随一个起音事件
（底鼓、贝斯重音、和弦切分）。

所以这里量的是「每个小节线处的 onset 强度 / 全局均值」。
低于 1.5x 就该人工看一眼。

## 两个坑（都踩过）

1. **不能用窄带低频**（如 40~120Hz）判断。这首歌的强拍在军鼓/吉他上，
   低频窄带测出来 0.26x，让人误以为"那里没音乐"，差点把正确的修正撤销。
2. **窗口不能太窄**。±2 帧（0.046s）测不到有 0.1s 误差的拍点。
   用 ±0.08s 取最大值，容忍拍点检测的正常抖动。
"""

import json
import os
import sqlite3
import sys

import librosa
import numpy as np

BASE = os.path.join(os.environ['APPDATA'], 'com.xmmpp.client')
WINDOW_SEC = 0.08
WEAK_RATIO = 1.5


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    sid = sys.argv[1]

    path = os.path.join(BASE, 'songs', sid, 'analysis.json')
    a = json.load(open(path, encoding='utf-8'))

    con = sqlite3.connect(os.path.join(BASE, 'fabulous.db'))
    row = con.execute('select audio_path from songs where id = ?', (sid,)).fetchone()
    if not row:
        print(f'找不到歌曲 {sid}')
        return
    audio = row[0]

    d = np.asarray(a['downbeatsSec'], dtype=float)
    y, sr = librosa.load(audio, sr=22050, mono=True)
    oe = librosa.onset.onset_strength(y=y, sr=sr)
    fps = sr / 512.0
    base = float(oe.mean())
    w = int(WINDOW_SEC * fps)

    print(a['song']['title'])
    print(f'  小节 {len(d)} 个   曲长 {a["song"]["durationSec"]:.1f}s')
    print()

    rows = []
    for i, t in enumerate(d):
        k = int(round(t * fps))
        if k < w or k >= len(oe) - w:
            continue
        rows.append((i + 1, float(t), float(oe[k - w:k + w + 1].max()) / base))

    vals = np.array([r[2] for r in rows])
    print(f'  小节线处 onset 强度（相对全局均值）：')
    print(f'    中位 {np.median(vals):.2f}x   最低 {vals.min():.2f}x   最高 {vals.max():.2f}x')
    print(f'    偏弱（<{WEAK_RATIO}x）: {(vals < WEAK_RATIO).sum()}/{len(vals)} 个')
    print()

    weak = [r for r in rows if r[2] < WEAK_RATIO]
    if weak:
        print(f'  ⚠️ 偏弱的小节线（建议人工核对）：')
        for bar, t, v in weak[:15]:
            print(f'    第 {bar:3d} 小节  {t:7.2f}s  {v:.2f}x')
    else:
        print('  ✅ 所有小节线都落在明显的起音上')


if __name__ == '__main__':
    main()
