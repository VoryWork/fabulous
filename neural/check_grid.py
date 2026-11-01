"""检查 downbeats 与真实强拍是否对齐（诊断小节线偏移）。

用法：
    python -u neural/check_grid.py <song_id>
"""
import json, os, sys
import numpy as np

base = os.path.join(os.environ['APPDATA'], 'com.xmmpp.client')
sid = sys.argv[1]
p = os.path.join(base, 'songs', sid, 'analysis.json')
a = json.load(open(p, encoding='utf-8'))
d = np.array(a['downbeatsSec'])
b = np.array(a['beatsSec'])
ch = a['chords']['submission']

print(f"曲目: {a['song']['title']}  (id={sid})")
print(f"downbeats={len(d)}  beats={len(b)}  duration={a['song']['durationSec']:.2f}s")
print()

bar = np.diff(d)
print("=== 小节时长分布 ===")
print(f"  中位 {np.median(bar):.3f}s  min {bar.min():.3f}  max {bar.max():.3f}")
lens = {}
for x in np.round(bar, 2):
    lens[x] = lens.get(x, 0) + 1
top = sorted(lens.items(), key=lambda kv: -kv[1])[:6]
print(f"  最常见的时长: {top}")
print()

beat = np.diff(b)
print("=== 拍间隔 ===")
print(f"  中位 {np.median(beat):.4f}s  min {beat.min():.4f}  max {beat.max():.4f}")
print(f"  一小节 = {np.median(bar)/np.median(beat):.2f} 拍（应为 4）")
print()

print("=== 前 12 个小节起点 ===")
for i in range(min(12, len(d))):
    print(f"  小节{i+1:2d}: {d[i]:.3f}s")
print()

print("=== 和弦边界 vs 小节线 ===")
# 每个和弦起点距最近小节线的距离（以拍为单位）
bar_ticks = np.median(bar)
offs = []
for c in ch:
    t = c['start']
    k = np.argmin(np.abs(d - t))
    delta = (t - d[k]) / bar_ticks * 4  # 拍
    if abs(delta) < 3.5:
        offs.append(delta)
offs = np.array(offs)
print(f"  和弦起点 {len(offs)} 个（距最近小节线的拍数）")
print(f"  距小节线 <0.1 拍: {(np.abs(offs)<0.1).sum()} 个 ({(np.abs(offs)<0.1).mean()*100:.0f}%)")
print(f"  接近整数拍(±0.15): {(np.abs(offs-np.round(offs))<0.15).sum()} 个")
print(f"  分布: {np.round(np.percentile(offs, [5,25,50,75,95]),2)}")
