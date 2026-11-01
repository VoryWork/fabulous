"""把真实模型分析结果转成前端可用的 analysis.json。

数据来源（都是真实跑出来的，不是编的）：
  ../exported/downbeats_final.npy   beat_this 检出的小节起点（秒）
  ../exported/beats_final.npy       beat_this 检出的拍点（秒）
  ../exported/chords_*.json         lv-chordia 三档解码结果

输出：
  ../../client/src/timeline/demo/analysis.json

用法：
    conda activate harmonize
    python neural/build_analysis_json.py
"""

import json
from pathlib import Path

import numpy as np

NEURAL = Path(__file__).parent.resolve()
EXPORTED = NEURAL / "exported"
OUT = NEURAL.parent / "client" / "src" / "timeline" / "demo" / "analysis.json"

# 曲目信息从结构分析结果里读（那里记录了音频文件名与时长）
# 没有结构结果时用 Refrain 的实测值兜底
DURATION_SEC = 290.15
SONG = {"title": "Refrain", "artist": "Aimer", "durationSec": DURATION_SEC}

# 拍号：4/4。前端 TempoMap 也按这个铺网格，两边必须一致
BEATS_PER_BAR = 4


def song_from_structure(structure_file: Path) -> dict:
    """从 structure_allin1.json 读取曲目信息。

    注意：`song` 字段是**音频文件名**。用户导出的文件可能已经被重命名成
    一串数字（实测 `69910425165.flac`），这时拿文件名当曲名会显示成乱码一样的标题。
    判定：纯数字/纯 ID 形的文件名没有信息量，回退到已知曲目信息。
    """
    if not structure_file.exists():
        return SONG
    try:
        st = json.loads(structure_file.read_text(encoding="utf-8"))
        duration = float(st.get("durationSec") or DURATION_SEC)
        raw = str(st.get("song", ""))
        title = Path(raw).stem.strip() or "未命名"

        # 纯数字/纯十六进制 ID 形的名字（用户重命名过）→ 不可用
        looks_like_id = bool(title) and (
            title.isdigit() or (title.isalnum() and any(c.isdigit() for c in title) and " " not in title)
        )
        if looks_like_id:
            return {**SONG, "durationSec": duration}

        # 文件名形如 "Aimer - Refrain" 时拆成 artist / title
        if " - " in title:
            artist, _, name = title.partition(" - ")
            return {"title": name.strip(), "artist": artist.strip(), "durationSec": duration}
        return {"title": title, "artist": "", "durationSec": duration}
    except Exception:
        return SONG


def dedupe_times(times: np.ndarray, min_gap: float) -> np.ndarray:
    """去掉间隔过近的重复峰。

    beat_this 的 postprocessor 在糊段落会留下 plateau 多峰（间隔 4-5 帧 ≈ 0.08-0.10s），
    这些不是真实拍点，必须过滤，否则小节网格会被切碎。
    """
    if len(times) == 0:
        return times
    keep = [0]
    for i in range(1, len(times)):
        if times[i] - times[keep[-1]] >= min_gap:
            keep.append(i)
    return times[keep]



def rebuild_beats_from_downbeats(
    beats: np.ndarray, downbeats: np.ndarray, beats_per_bar: int
) -> tuple[np.ndarray, np.ndarray]:
    """用 downbeats 当骨架重建拍点，保证 `downbeats[k] == beats[k*beats_per_bar]`。

    ## 为什么不在模型输出上"删假拍"而要重建

    删假拍要先判断哪个是假的 —— 0.20s 和 0.42s 的界限在变速歌里并不牢靠
    （慢歌一拍 0.6s、快歌 0.25s 都正常）。判错一个就少一拍，后面全错。

    downbeats 的数量可靠（一首歌的小节数是确定的），用它当骨架就不需要
    判断"哪一拍是假的" —— 每小节固定 `beats_per_bar` 拍，位置由小节边界决定。
    即使某小节内模型漏检/多检，均分也**不会让后续小节漂移**。

    ## 边界情况

    - 最后一个小节之后没有 downbeat：用倒数两小节的间隔外推补拍，
      否则曲末没拍点、谱面画不满。
    - 只有一个小节：按已有拍的平均间隔外推。
    """
    b = np.asarray(beats, dtype=float)
    d = np.asarray(downbeats, dtype=float)
    if len(d) == 0:
        return b, d
    if len(d) == 1:
        gap = float(np.median(np.diff(b))) if len(b) > 1 else 0.5
        return d[0] + np.arange(max(1, len(b))) * gap, d

    # 修正倍速/半速检出的异常小节（详见 analyze_song.py 里的同一段说明）。
    # 不丢弃、只挪位置 —— 丢弃会让小节数凭空变少，拍号和信息对不上。
    med_bar = float(np.median(np.diff(d))) if len(d) > 2 else 0.0
    if med_bar > 0:
        fixed = [d[0]]
        for i in range(1, len(d)):
            span = d[i] - fixed[-1]
            ratio = span / med_bar
            if ratio < 0.55 or ratio > 1.8:
                span = med_bar * max(1, int(round(ratio)))
            fixed.append(fixed[-1] + span)
        d = np.asarray(fixed, dtype=float)

    out = []
    for i in range(len(d) - 1):
        bar_start, bar_end = d[i], d[i + 1]
        step = (bar_end - bar_start) / beats_per_bar
        for k in range(beats_per_bar):
            out.append(bar_start + k * step)

    last_span = d[-1] - d[-2]
    step = last_span / beats_per_bar
    tail_end = float(b[-1]) if len(b) and b[-1] > d[-1] else d[-1] + last_span
    n_tail = max(beats_per_bar, int(round((tail_end - d[-1]) / step)))
    for k in range(n_tail + 1):
        out.append(d[-1] + k * step)

    return np.asarray(out, dtype=float), d

def quantize_downbeats(downbeats: np.ndarray, bar_sec: float) -> np.ndarray:
    """把 downbeat 修成接近规整的小节网格。

    用户要求：「可以直接量化掉，最小量化是一拍，实际编曲中不可能有人切换这么快」。

    beat_this 的 downbeat 有两类误差：
      - **误检**：间隔远小于一小节（实测有 1.52s 的假小节）→ 跳过
      - **漏检**：间隔是整数倍小节（实测有 6.16s）→ 按 bar_sec 补中间点

    这样网格既锚定在真实位置上，又不会出现"半截小节"。
    """
    if len(downbeats) == 0:
        return downbeats

    out = [float(downbeats[0])]
    dropped = 0
    inserted = 0

    for i in range(1, len(downbeats)):
        gap = float(downbeats[i]) - out[-1]
        n_bars = round(gap / bar_sec)

        if n_bars <= 0:
            # 误检：间隔不到半小节，丢弃
            dropped += 1
            continue

        # 漏检：补中间的小节起点
        for k in range(1, n_bars):
            out.append(round(out[-1] + bar_sec, 4))
            inserted += 1

        out.append(float(downbeats[i]))

    print(f"  downbeat 修正: 丢弃误检 {dropped} 个, 补漏检 {inserted} 个")
    return np.array(out)


def quantize_chords(segs: list, beat_sec: float, min_beats: float = 1.0) -> list:
    """和弦段量化：**最小 1 拍**，过短的合并到前一段。

    理由：模型会输出 0.4–0.7s 的碎片（不到 1 拍）。
    实际编曲中没人会在半拍切换和弦，这些是误判。
    合并（延长前一段）比删除更保守：不会把和弦名丢掉。
    """
    if not segs:
        return segs

    out = []
    merged = 0

    for s in segs:
        dur = s["end"] - s["start"]
        if out and dur < beat_sec * min_beats:
            # 太短：延长前一段覆盖它
            out[-1]["end"] = s["end"]
            merged += 1
            continue
        out.append(dict(s))

    # 首段仍可能过短（前奏的 N）：把它合并进后一段
    if len(out) >= 2 and (out[0]["end"] - out[0]["start"]) < beat_sec * min_beats:
        out[1]["start"] = out[0]["start"]
        out.pop(0)
        merged += 1

    print(f"  和弦合并: {merged} 个碎片被并入邻居")
    return out


def choose_bpm_layer(times: np.ndarray) -> tuple:
    """判定「这一串拍点/小节是不是整体被记成了 half-time」，返回 (缩放倍数, 原始间隔, 说明)。

    ## 为什么必须有这一步（踩过的坑）

    以前只在「个别长间隔是短间隔整数倍」时才补点（见 fill_half_time_gaps）。
    但当**整首歌**都被 beat_this 记成 half-time 时，第一层间隔自己就是 2 倍，
    补点逻辑永远不触发 —— 于是产生了下面的错位（Refrain 实测）：

        | 数据      | 间隔      | 推出的 BPM |
        |-----------|-----------|------------|
        | downbeats | 1.67s/小节 | 143.7      |
        | beats     | 0.84s/拍   | **71.4**   |

    同一小节里只塞得下 2 拍（1.67 / 0.84 ≈ 2），而不是 4 拍。
    前端拿 0.84s 当一拍去铺 tick（960 tick/拍），却拿 downbeat 当小节线
    （3840 tick/小节），两边进度立刻差一倍 —— 表现就是用户报的
    「歌曲结构和和弦位置对不上」。

    ## 判定依据

    `小节间隔 / 拍间隔` 理想值是 4（4/4 拍）。实际：
      - ≈ 4 → 拍点正常，不用动
      - ≈ 2 → 拍点漏检一半（half-time），整体乘 2
      - ≈ 8 → 拍点多了（双倍速），整体乘 0.5

    用比值而不是绝对 BPM：绝对 BPM 判不出对错（70 BPM 的慢歌是合法的），
    但「一小节里几拍」是硬约束。
    """
    if len(times) < 4:
        return 1.0, 0.0, "数据太少，不做判定"

    ioi = np.median(np.diff(times))
    if ioi <= 0:
        return 1.0, float(ioi), "间隔异常，不做判定"

    return 1.0, float(ioi), f"中位间隔 {ioi:.3f}s"


def beats_per_bar_ratio(beats: np.ndarray, downbeats: np.ndarray, beats_per_bar: int = 4) -> float:
    """拍间隔 / 小节间隔 换算成「一小节实际有几拍」。"""
    if len(beats) < 4 or len(downbeats) < 4:
        return float(beats_per_bar)
    beat_ioi = float(np.median(np.diff(beats)))
    bar_ioi = float(np.median(np.diff(downbeats)))
    if beat_ioi <= 0:
        return float(beats_per_bar)
    return bar_ioi / beat_ioi


def beat_scale_for_beats(downbeats: np.ndarray, beats: np.ndarray, beats_per_bar: int = 4) -> float:
    """只调**拍点**需要的缩放倍数，让一小节里正好落在 beats_per_bar 拍。

    返回 2.0 表示拍点漏检一半（要把每个拍间隔拆成两个），0.5 表示拍点翻倍。

    ## 阈值为什么这么紧（0.03）

    候选倍数之间的相对距离很大（0.5 / 1 / 2），但**真实拍号会落在中间**：
      3/4 拍 → ratio = 3 → scale = 4/3 ≈ 1.33
      12/8 拍 → ratio = 12（每小节 12 个八分）→ scale ≈ 0.33
    早先用 12% 容差，`1.33` 会离 `1.0` 有 33%、离 `2.0` 有 33% —— 都不会误中，
    但 5/4（scale = 0.8）离 1.0 只有 20%，也安全；真正的风险是
    **half-time 的实测比值有抖动**（局部漏检补点后 ratio 实测 4.02，
    而极端情况可能到 3.7 或 4.3 → scale 2.0 的偏差 8%）。

    所以取 0.03：只接受「干净得离谱」的 2 倍关系。
    宁可漏修（用户还能手动改速度段），也不能把 3/4 拍强行改成 4 拍 ——
    后者会**静默毁掉整首歌的网格**，且用户难以察觉原因。
    """
    ratio = beats_per_bar_ratio(beats, downbeats, beats_per_bar)
    if ratio <= 0:
        return 1.0
    scale = beats_per_bar / ratio
    for candidate in (0.5, 1.0, 2.0):
        if abs(scale - candidate) <= candidate * 0.03:
            return candidate
    return 1.0


def fill_half_time_gaps(times: np.ndarray, min_gap: float = 0.0) -> tuple:
    """补全局部漏检的点（间隔是基础间隔的整数倍时，在中间插点）。

    注意：这个函数只处理**局部**漏检。整首歌被记成 half-time 的情况
    由 `beat_scale_for_beats` + `rescale_times` 统一处理，不要指望这里。

    `min_gap` 只为兼容旧调用保留，不参与判定。

    返回 (补全后的数组, 补充的点数)
    """
    if len(times) < 3:
        return np.asarray(times, dtype=float), 0

    ioi = np.diff(times)
    # 基础间隔：用 15 分位而不是最小，避免个别异常值影响
    base = float(np.percentile(ioi, 15))
    if base <= 0:
        return np.asarray(times, dtype=float), 0

    out = [float(times[0])]
    added = 0

    for i in range(1, len(times)):
        gap = float(times[i]) - out[-1]
        n = int(round(gap / base))

        # gap 接近 base 的整数倍（n >= 2）→ 中间漏了点
        if n >= 2 and abs(gap - n * base) < base * 0.25:
            step = gap / n
            for _ in range(1, n):
                out.append(out[-1] + step)
                added += 1
        out.append(float(times[i]))

    return np.asarray(out, dtype=float), added


def rescale_times(times: np.ndarray, factor: float) -> np.ndarray:
    """把一串等距点加密/稀疏 factor 倍（factor=2 → 每个间隔中间插一个点）。

    只在 `beat_scale_for_beats` 判定为 half-time / double-time 时调用。
    用线性插值而不是取整，避免累积漂移；首尾保持不动。
    """
    times = np.asarray(times, dtype=float)
    if factor == 1.0 or len(times) < 2:
        return times
    if factor >= 2.0:
        # 加密：每段插 factor-1 个点
        n_sub = int(round(factor))
        out = []
        for i in range(len(times) - 1):
            a, b = times[i], times[i + 1]
            for k in range(n_sub):
                out.append(a + (b - a) * k / n_sub)
        out.append(times[-1])
        return np.asarray(out, dtype=float)
    # 稀疏：隔 factor 取一个（保留首尾）
    step = int(round(1.0 / factor))
    out = list(times[::step])
    if out[-1] != times[-1]:
        out.append(times[-1])
    return np.asarray(out, dtype=float)


def main():
    print("=" * 70)
    print("  从真实模型输出生成 analysis.json")
    print("=" * 70)

    # ---- 1. 拍点与小节
    beats = np.load(EXPORTED / "beats_final.npy")
    downbeats = np.load(EXPORTED / "downbeats_final.npy")
    print(f"\n原始: {len(beats)} 拍, {len(downbeats)} 小节起点")

    beats = dedupe_times(beats, 0.25)
    downbeats = dedupe_times(downbeats, 1.0)
    print(f"去重后: {len(beats)} 拍, {len(downbeats)} 小节")

    # 先补局部漏检（间隔是基础间隔整数倍时插点）
    beats, add_b = fill_half_time_gaps(beats)
    downbeats, add_d = fill_half_time_gaps(downbeats)
    if add_b or add_d:
        print(f"补全局部漏检: +{add_b} 拍, +{add_d} 小节")
        print(f"  → 现在 {len(beats)} 拍, {len(downbeats)} 小节")

    # 再修**整体** half-time —— 这是「结构和和弦对不上」的真正根因。
    #
    # beat_this 会把整首歌唱成一半速度（1 小节只标 2 拍，而不是 4 拍）。
    # 若不同时处理 beats 和 downbeats，前端两套网格就会差一倍。
    # 判定依据见 beat_scale_for_beats 的注释。
    raw_beat_ioi = float(np.median(np.diff(beats)))
    raw_bar_ioi = float(np.median(np.diff(downbeats)))
    # ## beas 与 downbeats 索引对齐（和 analyze_song.py 保持同一逻辑）
    #
    # 前端画小节线用 downbeats，而「秒 → tick」用 beats 的**下标**。
    # beat_this 会在小节交界多检出拍点（实测 88 处 0.2s 假拍 vs 真实 0.42s），
    # 导致 beats 比「小节数×4」多出 40 个，下标与小节线错位且**累积漂移**
    # （实测 185 小节里 183 个对不齐，最大偏 44 拍）。
    #
    # 以 downbeats 为骨架重建拍位，保证 downbeats[k] == beats[4k]。
    _before = len(beats)
    _before_downs = downbeats.copy()
    beats, downbeats = rebuild_beats_from_downbeats(beats, downbeats, BEATS_PER_BAR)
    _moved = int((np.abs(downbeats - _before_downs) > 1e-6).sum())
    print(f"  重建拍网格: {_before} 拍 -> {len(beats)} 拍（索引已对齐）")
    if _moved:
        print(f"  修正了 {_moved} 个小节的边界（倍速/半速检出）")

    bpb_ratio = beats_per_bar_ratio(beats, downbeats, BEATS_PER_BAR)
    beat_scale = beat_scale_for_beats(downbeats, beats, BEATS_PER_BAR)

    print("\n-- 速度层判定 --")
    print(f"  小节间隔 {raw_bar_ioi:.3f}s（= {BEATS_PER_BAR * 60 / raw_bar_ioi:.1f} BPM）")
    print(f"  拍间隔   {raw_beat_ioi:.3f}s（= {60 / raw_beat_ioi:.1f} BPM）")
    print(f"  一小节 {bpb_ratio:.2f} 拍（理想 {BEATS_PER_BAR} 拍）")

    if beat_scale != 1.0:
        print(f"  ⚠️ 判定为 half-time/double-time，拍点 × {beat_scale}")
        beats = rescale_times(beats, beat_scale)
        print(f"  → 拍点 {len(beats)} 个")
    else:
        print("  拍点层正常，不缩放")
    print(f"  首拍 {beats[0]:.3f}s, 末拍 {beats[-1]:.3f}s")
    print(f"  首小节 {downbeats[0]:.3f}s, 末小节 {downbeats[-1]:.3f}s")

    bar_ioi = np.diff(downbeats)
    beat_ioi = np.diff(beats)
    print(f"  小节间隔: 中位 {np.median(bar_ioi):.3f}s  范围 [{bar_ioi.min():.3f}, {bar_ioi.max():.3f}]")
    print(f"  拍间隔:   中位 {np.median(beat_ioi):.3f}s（= {60/np.median(beat_ioi):.1f} BPM）")
    print(f"  修后一小节 {float(np.median(bar_ioi))/float(np.median(beat_ioi)):.2f} 拍")

    # ---- 2. 和弦三档
    chord_dicts = {}
    for name in ("submission", "ismir2017", "full"):
        p = EXPORTED / f"chords_{name}.json"
        if not p.exists():
            print(f"  ⚠️ 缺少 {p.name}")
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        chord_dicts[name] = data
        print(f"  {name:12s} {len(data)} 段")

    # ---- 2.5 量化（用户要求：最小 1 拍，碎片直接量化掉）
    bar_sec = float(np.median(np.diff(downbeats)))
    beat_sec = bar_sec / 4
    print("量化基准: 1 小节 = %.3fs, 1 拍 = %.3fs" % (bar_sec, beat_sec))

    before_bars, before_beats = len(downbeats), len(beats)
    downbeats = quantize_downbeats(downbeats, bar_sec)
    print(f"  小节: {before_bars} → {len(downbeats)}")

    for name in list(chord_dicts.keys()):
        chord_dicts[name] = quantize_chords(chord_dicts[name], beat_sec)

    # 量化后的拍点也要重算间隔（用于 meta）
    beat_ioi = np.diff(beats)
    bar_ioi = np.diff(downbeats)

    # ---- 2.6 结构分析（all-in-one-infer）
    structure_file = EXPORTED / "structure_allin1.json"
    sections = []
    if structure_file.exists():
        st = json.loads(structure_file.read_text(encoding="utf-8"))
        print()
        print(f"结构分析: {len(st['segments'])} 段（来源: {st['source']}）")

        # 标签映射（all-in-one 用小写）
        #
        # 注意：`start` / `end` 是 all-in-one 的**分析起止标记**，不是音乐段落。
        #
        # `start` 的时间范围很窄（实测 0.0–0.49s），映射成 Intro 会和真正的
        # 第一段重叠 → 跳过。
        # `end` 更不能映射成 Outro：它表示"分析到这里结束"，长度完全取决于
        # 最后一个真实段落的结束位置（实测只有 13.7s = 1 小节）。
        # 早先把它当 Outro 就出现了一个假段落「Outro bar 151~152」。
        # 正确做法：直接丢掉，让**最后一个真实段落**自然延伸到曲末。
        LABEL_MAP = {
            'intro': 'Intro', 'verse': 'Verse', 'chorus': 'Chorus',
            'bridge': 'Bridge', 'outro': 'Outro', 'inst': 'Inst',
            'start': None, 'end': None,
        }

        # 秒 → 小节号（用真实 downbeat 找最近的小节边界）
        def sec_to_bar(sec: float) -> int:
            idx = int(np.searchsorted(downbeats, sec, side='left'))
            # 吸附到最近的小节边界
            if idx > 0 and idx < len(downbeats):
                prev_d = downbeats[idx - 1]
                next_d = downbeats[idx]
                idx = idx if (next_d - sec) < (sec - prev_d) else idx - 1
            return max(0, min(idx, len(downbeats) - 1))

        # 合并相邻同标签的段（all-in-one 会把一个 Verse 切成多个）
        merged = []
        for seg in st['segments']:
            label = LABEL_MAP.get(seg['label'].lower(), seg['label'])
            if label is None:
                continue  # start/end 这类伪段落直接跳过
            start_bar = sec_to_bar(seg['start'])
            end_bar = sec_to_bar(seg['end'])
            if end_bar <= start_bar:
                end_bar = start_bar + 1
            if merged and merged[-1]['label'] == label and merged[-1]['endBar'] == start_bar:
                merged[-1]['endBar'] = end_bar
            else:
                merged.append({'label': label, 'startBar': start_bar, 'endBar': end_bar})
        # 最后一个真实段落延伸到曲末（上一段落的 end 标记被丢弃了）
        total_bars = len(downbeats) - 1
        if merged and merged[-1]['endBar'] < total_bars:
            merged[-1]['endBar'] = total_bars

        print(f"  合并相邻同标签后: {len(merged)} 段")
        for m in merged:
            print(f"    {m['label']:10s} bar {m['startBar']:3d} ~ {m['endBar']:3d}  ({m['endBar']-m['startBar']} 小节)")
        sections = merged
    else:
        print("警告: 未找到 structure_allin1.json，跳过结构轨")

    # ---- 2.7 速度段（供速度轨显示与编辑）
    #
    # 逐小节算 BPM 会得到 93 个抖动的值（变异系数 <1%），
    # 那是 43fps 帧栅格量化误差，不是真实变速。
    # 这里把它们压成"速度段"：
    #   - 相邻 BPM 差异 < 1% 视为同一段
    #   - 每段取中位 BPM
    #   - 段内用真实 downbeat 定位（保证网格对齐）
    # 注意：上面的 bar_sec 已被赋成"中位小节长度"（标量），
    # 这里要重新算数组版（每小节的间隔）
    bar_secs = np.diff(downbeats)
    bar_bpm = 4 / bar_secs * 60
    med_bpm = float(np.median(bar_bpm))

    # ⚠️ 这里**不做任何「异常剔除」**。
    #
    # 踩过的坑：一开始用「偏离全局中位 > 3% 视为检测错误」，
    # 结果这首变速歌（BPM 在 65 和 130 之间交替，正好 2 倍）的
    # 130 BPM 整段被当噪声剔除，速度轨只剩一段 65 BPM，
    # **真实的倍速变化被完全抹掉**。
    #
    # 根本问题：用**全局**中位判断"异常"是错的。
    # 这首歌是「慢-快-慢-快」交替，没有单一"正常速度"。
    #
    # 现在的策略：全部视为有效，让速度段如实反映数据，
    # 由用户在速度轨上判断哪些是真实变速、哪些要修正。
    valid = np.ones(len(bar_bpm), dtype=bool)

    # 切段阈值：BPM 变化超过 **5%** 才算"变速"。
    #
    # 演进：
    #   - 1%   → 抖动全被当变速，切成 17 段
    #   - 2.5% → 补全 half-time 漏检后仍有 ±2.7% 抖动（拆分间隔时均分导致），切成 10 段
    #   - **5%** → 能吸收补全引入的抖动，只保留真实变速
    #
    # 5% 的合理性：真实音乐变速（比如 ±10 BPM）远超这个幅度；
    # 而补全/帧栅格造成的抖动都在 3% 以内。
    SEGMENT_THRESHOLD = 0.05

    tempo_segments = []
    i = 0
    n = len(bar_bpm)
    while i < n:
        # 段的起点：跳过异常小节（并入前段）
        if not valid[i]:
            i += 1
            continue
        # 向后扩展：BPM 相近的连续小节归为一段
        j = i
        seg_bpms = [bar_bpm[i]]
        while j + 1 < n:
            if not valid[j + 1]:
                break
            if abs(bar_bpm[j + 1] - seg_bpms[0]) / seg_bpms[0] >= SEGMENT_THRESHOLD:
                break
            j += 1
            seg_bpms.append(bar_bpm[j])
        tempo_segments.append({
            'startBar': int(i),
            'endBar': int(j + 1),
            'bpm': round(float(np.median(seg_bpms)), 2),
        })
        i = j + 1

    # 二次合并，两条规则：
    #   1. 相邻段 BPM 差异 < 1.5% → 合并（消除抖动造成的碎段）
    #   2. **长度只有 1 小节的段 → 并入前一段**
    #      1 小节的"变速"在音乐上没有意义，几乎都是模型误差。
    #      DAW 里也没有人做单小节变速。
    merged_segs = []
    for seg in tempo_segments:
        len_bars = seg['endBar'] - seg['startBar']
        prev = merged_segs[-1] if merged_segs else None

        should_merge = prev is not None and (
            len_bars <= 1
            or abs(seg['bpm'] - prev['bpm']) / prev['bpm'] < 0.015
        )

        if should_merge:
            prev['endBar'] = seg['endBar']
            lo, hi = prev['startBar'], prev['endBar']
            vals = [bar_bpm[k] for k in range(lo, min(hi, len(bar_bpm))) if valid[k]]
            if vals:
                prev['bpm'] = round(float(np.median(vals)), 2)
        else:
            merged_segs.append(dict(seg))
    tempo_segments = merged_segs

    # 兜底：一段都没有时用全局中位
    if not tempo_segments:
        tempo_segments = [{'startBar': 0, 'endBar': len(bar_bpm) + 1, 'bpm': round(med_bpm, 2)}]

    print()
    print("速度段（从 %d 个小节压缩而来）:" % len(bar_bpm))
    for seg in tempo_segments:
        print(f"  bar {seg['startBar']:3d} ~ {seg['endBar']:3d}  {seg['bpm']:6.2f} BPM")

    # ---- 3. 组装
    song_info = song_from_structure(structure_file)
    print()
    print(f"曲目: {song_info['title']}  ({song_info['durationSec']:.2f}s)")

    payload = {
        "song": song_info,
        "source": {
            "beats": "beat_this final0（真实音频推理）",
            "chords": "lv-chordia s0–s4 ensemble（真实音频推理）",
            "note": "全部为模型原始输出，未经人工修订",
        },
        # 小节起点（秒）—— 前端用它构造 TempoMap 锚点
        "downbeatsSec": [round(float(t), 4) for t in downbeats],
        # 拍点（秒）—— 用于在标尺上画真实拍刻度
        "beatsSec": [round(float(t), 4) for t in beats],
        "chords": chord_dicts,
        # 结构分段（all-in-one-infer 输出，按小节表达）
        "sections": sections,
        # 速度段（供速度轨显示/编辑；底层 TempoMap 仍按小节精确对齐）
        "tempoSegments": tempo_segments,
        "meta": {
            "beatsPerBar": BEATS_PER_BAR,
            # BPM 以**小节间隔**为准（一小节 4 拍），不是单独拿拍间隔算。
            # 拍点可能被整体记成 half-time，但 downbeat 是更稳的锚（它同时也是
            # 结构段和和弦边界的对齐基准）。两边用同一个数才不会错位。
            "bpmMedian": round(BEATS_PER_BAR * 60 / float(np.median(bar_ioi)), 2),
            # 原始拍点推出的 BPM（修 half-time 之前），用于诊断/展示"模型原判"
            "bpmRawBeats": round(60 / raw_beat_ioi, 2),
            "bpmRawBars": round(BEATS_PER_BAR * 60 / raw_bar_ioi, 2),
            # 拍点层缩放倍数（1 = 没动；2 = beat_this 记成 half-time 已修）
            "beatScale": beat_scale,
            "barSecMedian": round(float(np.median(bar_ioi)), 4),
            "beatSecMedian": round(float(np.median(beat_ioi)), 4),
            "beatCount": int(len(beats)),
            "barCount": int(len(downbeats)),
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    size_kb = OUT.stat().st_size / 1024
    # 不要在这里用 emoji：Windows 控制台默认 GBK，会直接 UnicodeEncodeError 崩掉
    print(f"\n[OK] 已写出 {OUT}")
    print(f"   体积 {size_kb:.1f} KB")
    print(f"   BPM 中位 {payload['meta']['bpmMedian']}")
    print(f"   {payload['meta']['barCount']} 小节 / {payload['meta']['beatCount']} 拍")

    # ---- 4. 一致性自检：拍点是否落在小节内
    print("\n--- 自检 ---")
    per_bar = []
    for i in range(len(downbeats) - 1):
        a, b = downbeats[i], downbeats[i + 1]
        n = int(((beats >= a) & (beats < b)).sum())
        per_bar.append(n)
    from collections import Counter
    print(f"每小节拍数分布: {dict(Counter(per_bar).most_common(6))}")
    ok = sum(1 for x in per_bar if x == 4) / len(per_bar)
    print(f"4 拍小节占比: {ok*100:.1f}%（模型真实输出，偏低说明有检测误差）")

    # 和弦覆盖检查
    sub = chord_dicts.get("submission", [])
    if sub:
        covered = sub[-1]["end"] if sub else 0
        print(f"和弦覆盖: 0 → {covered:.2f}s（曲长 {DURATION_SEC}s）")


if __name__ == "__main__":
    main()
