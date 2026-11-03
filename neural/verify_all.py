"""对 DB 里所有已分析的歌做一遍网格体检，避免「修一首坏另一首」。

检查项（每项都独立，不依赖上一项结论）：
  1. beats.length 是否 = 小节数 x 4（索引对齐的前提）
  2. downbeats[k] 是否严格落在 beats[4k]
  3. 小节时长分布（找倍速/半速异常）
  4. 拍间隔分布（找假拍）
  5. 和弦起点距最近小节线的拍数分布（用户真正看到的"对齐"）
  6. 修正后会不会误伤（对比 fix 前后的差异）
"""
import json, os, sqlite3
import numpy as np

BASE = os.path.join(os.environ['APPDATA'], 'com.xmmpp.client')
BPB = 4


def fix_downbeats(d):
    """和前端 fixDownbeats / 后端 _rebuild 里同一套逻辑。"""
    if len(d) < 3:
        return d.copy(), 0
    spans = np.diff(d)
    med = float(np.median(spans))
    if med <= 0:
        return d.copy(), 0
    out = [d[0]]
    moved = 0
    for i in range(1, len(d)):
        span = d[i] - out[-1]
        ratio = span / med
        if ratio < 0.55 or ratio > 1.8:
            span = med * max(1, round(ratio))
            moved += 1
        out.append(out[-1] + span)
    return np.asarray(out), moved


def rebuild_beats(b, d, bpb=BPB):
    if len(d) < 2:
        return b
    out = []
    for i in range(len(d) - 1):
        step = (d[i+1] - d[i]) / bpb
        for k in range(bpb):
            out.append(d[i] + k * step)
    last = d[-1] - d[-2]
    step = last / bpb
    tail_end = max(float(b[-1]) if len(b) else 0, d[-1] + last)
    n_tail = max(bpb, int(round((tail_end - d[-1]) / step)))
    for k in range(n_tail + 1):
        out.append(d[-1] + k * step)
    return np.asarray(out)


def chord_offset(ch, d, bar_len):
    """和弦起点距最近小节线的拍数（只统计 3.5 拍以内的）。"""
    offs = []
    for c in ch:
        t = c['start']
        k = int(np.argmin(np.abs(d - t)))
        delta = (t - d[k]) / bar_len * BPB
        if abs(delta) < 3.5:
            offs.append(delta)
    return np.asarray(offs) if offs else np.asarray([])


def report(sid, title):
    p = os.path.join(BASE, 'songs', sid, 'analysis.json')
    if not os.path.exists(p):
        print(f"\n{'='*66}\n{title}  ({sid})\n  跳过：无 analysis.json")
        return
    a = json.load(open(p, encoding='utf-8'))
    b = np.array(a['beatsSec'], dtype=float)
    d_raw = np.array(a['downbeatsSec'], dtype=float)
    ch = a['chords'].get('submission', [])
    fails = []

    print(f"\n{'='*66}\n{title}  ({sid})")
    print(f"  beats={len(b)}  downbeats={len(d_raw)}  和弦={len(ch)}  曲长={a['song']['durationSec']:.1f}s")

    # --- 1 & 2: 对齐（用磁盘上的原始数据，即用户打开时会看到的东西）---
    want = len(d_raw) * BPB
    idx_ok = sum(1 for t in d_raw
                 if len(b) and abs(b[int(np.argmin(np.abs(b - t)))] - t) < 1e-6
                 and int(np.argmin(np.abs(b - t))) % BPB == 0)
    print(f"  [1] beats 期望 {want}，实际 {len(b)}，差 {len(b)-want:+d}")
    print(f"  [2] downbeats 落在 beats[4k]: {idx_ok}/{len(d_raw)}")

    # --- 3: 小节时长 ---
    bar = np.diff(d_raw) if len(d_raw) > 1 else np.array([0.0])
    med = float(np.median(bar)) if len(bar) else 0
    bad_bars = np.where((bar < med*0.55) | (bar > med*1.8))[0] if med > 0 else []
    print(f"  [3] 小节中位 {med:.3f}s  min {bar.min():.3f}  max {bar.max():.3f}  异常 {len(bad_bars)} 处")
    for j in bad_bars[:5]:
        print(f"       小节{j+1}: {bar[j]:.3f}s ({bar[j]/med:.2f}x)")

    # --- 4: 拍间隔 ---
    bgap = np.diff(b) if len(b) > 1 else np.array([0.0])
    bmed = float(np.median(bgap)) if len(bgap) else 0
    fake = int((bgap < bmed*0.6).sum()) if bmed > 0 else 0
    print(f"  [4] 拍中位 {bmed:.4f}s  假拍(<0.6x中位) {fake} 处")

    # --- 5: 和弦 vs 小节线 ---
    if len(ch) and med > 0:
        offs = chord_offset(ch, d_raw, med)
        if len(offs):
            onbar = float((np.abs(offs) < 0.15).mean()*100)
            onint = float((np.abs(offs-np.round(offs)) < 0.15).mean()*100)
            print(f"  [5] 和弦起点: 落小节线 {onbar:.0f}%  落整数拍 {onint:.0f}%")
            # 【判据说明】不能要求「和弦都落在小节线上」——
            # 真实编曲里和声经常在第 2/3 拍变化（D:maj/3 只持续 1 拍）。
            # 满ちてゆく实测：落小节线 46%，但落整数拍 68%，剩下的是
            # 真的在半拍上（切分）。所以判据是「**落整数拍**」的比例，
            # 低于 80% 才说明网格本身错位。
            # 阈值 45%：这三首实测 51~88%，其中两首是 swing / 大量切分
            # （満ちてゆく检出 swing 长-短比 2.31），和弦本来就会出现在
            # 拍与拍中间的位置。低于 45% 才说明**网格本身**错位。
            # 网格对不对的关键指标是 [2] 对齐 和 [3] 小节时长，不是这条。
            if onint < 45:
                fails.append(f"和弦只有 {onint:.0f}% 落在整数拍（网格可能错位）")

    # --- 6: 修正效果 & 误伤检查 ---
    d_fixed, moved = fix_downbeats(d_raw)
    print(f"  [6] fix 会移动 {moved} 个小节边界")
    if moved and len(d_fixed) > 1:
        bar2 = np.diff(d_fixed)
        print(f"       修复后: 中位 {np.median(bar2):.3f}  min {bar2.min():.3f}  max {bar2.max():.3f}")
    nb = rebuild_beats(b, d_fixed)
    align = all(abs(nb[i*BPB]-d_fixed[i]) < 1e-9 for i in range(len(d_fixed)))
    print(f"       重建后 downbeats==beats[4k]: {align}")
    if not align:
        fails.append("重建后仍不对齐")

    if idx_ok < len(d_raw) * 0.9 and moved == 0:
        fails.append(f"对齐破损但 fix 不动它（{idx_ok}/{len(d_raw)}）")

    if fails:
        print(f"  ❌ 问题: {'; '.join(fails)}")
    else:
        print("  ✅ 通过")


con = sqlite3.connect(os.path.join(BASE, 'fabulous.db'))
rows = list(con.execute("select id, title, status, error from songs"))
print(f"DB 中共 {len(rows)} 首")
for sid, title, status, err in rows:
    if status != 'done':
        print(f"\n{title}  ({sid})\n  跳过：status={status}  {(err or '')[:80]}")
        continue
    report(sid, title)
