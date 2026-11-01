"""单曲分析脚本 —— 被 Rust 后端以子进程方式调用。

## 协议（stdout，每行一个 JSON）

    {"type":"progress","stage":"beats","pct":0.2,"message":"识别拍点…"}
    {"type":"partial","stage":"beats","json":"<目前拿到的部分结果>"}
    {"type":"result","json":"<analysis.json 的完整内容>"}
    {"type":"error","message":"..."}

`partial` 让前端能**边分析边渲染**（拍点出来先画网格，和弦出来再摆和弦）。
它不是最终产物，字段可能不全（比如还没有 sections），前端必须能接受缺失。

**必须用 `python -u` 启动**，否则 stdout 是块缓冲，Rust 读不到实时进度。

## 为什么 stdio 而不是 HTTP

- 零端口占用（本地应用不该抢端口）
- 进程生命周期完全由 Rust 掌控（kill 一句就行）
- 模型库的日志往 stderr 走，不污染协议

## 生产环境替换

这个脚本只用于**开发期**。生产版应改走 ONNX（M7）或纯 Rust 信号处理（M4）。
Rust 侧的 `Analyzer` trait 已经为此留了接口。

用法：
    python neural/analyze_song.py <audio_path>
"""

import json
import sys
import traceback
from pathlib import Path

# 关掉第三方库的日志噪音（它们往 stderr 写，但太多会拖慢）
import os
import warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("PYTHONWARNINGS", "ignore")

# 拍号：4/4。前端 TempoMap 按这个铺网格，两边必须一致
BEATS_PER_BAR = 4


def emit(obj: dict) -> None:
    """往 stdout 打一行 JSON（协议行）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def progress(stage: str, pct: float, message: str) -> None:
    emit({"type": "progress", "stage": stage, "pct": round(pct, 3), "message": message})


def push_partial(result: dict, stage: str) -> None:
    """把**当前已拿到**的结果推给前端，让它先画出来。

    阶段之间是天然可增量的：
      1. 拍点/小节  → 前端能画网格、标尺、速度轨
      2. 和弦       → 能摆和弦块
      3. 结构       → 能画结构轨

    没有这一步，用户要盯着一个空白窗口等好几分钟，
    完全不知道「到底在跑还是卡住了」。

    失败不该影响主流程：这只是「提前看一眼」，真正的结果在最后一次性给。
    """
    try:
        emit({"type": "partial", "stage": stage, "json": json.dumps(result, ensure_ascii=False)})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"[partial:{stage}] 推送失败（忽略）: {e}\n")


# ---------------------------------------------------------------- 分析步骤


def analyze(audio_path: Path) -> dict:
    """跑完整分析链：拍点 → 和弦 → 结构 → 组装。"""
    import numpy as np

    result: dict = {
        "song": {
            "title": audio_path.stem,
            "artist": "",
            "durationSec": 0.0,
        },
        "downbeatsSec": [],
        "beatsSec": [],
        "chords": {},
        "meta": {},
    }

    # 文件元信息
    import soundfile as sf

    info = sf.info(str(audio_path))
    result["song"]["durationSec"] = float(info.duration)
    # 文件名形如 "Artist - Title" 时拆开
    stem = audio_path.stem
    if " - " in stem:
        artist, _, title = stem.partition(" - ")
        result["song"]["artist"] = artist.strip()
        result["song"]["title"] = title.strip()

    progress("probe", 0.02, f"读取音频 {info.duration:.1f}s")

    # ---- 0. 调音校正（必须在所有模型之前）
    #
    # 实测《満ちてゆく》整体偏低 34.7 音分（三种检测方法一致）。
    # 不校正的后果（同一首歌实测）：
    #   - lv-chordia 判 N 的总时长 33.7s（10.7%）
    #   - 校正到 A=440 后只剩 8.6s（2.7%）—— 模型自己就算出来了
    #   - 而且根音从 C#/Ab/Eb/Bb 回到 A/D/E/B，和 madmom 的调性体系一致
    #
    # 之前以为是"两个引擎差一个半音"，其实根因是这首歌不是 440Hz。
    progress("tuning", 0.03, "检测调音偏差…")
    tune_info = detect_and_correct_tuning(audio_path)
    result["tuning"] = tune_info
    analysis_audio = tune_info["analysisPath"] or audio_path
    if tune_info["corrected"]:
        progress("tuning", 0.04,
                 f"调音偏低 {tune_info['deviationCents']:+.0f} 音分，已校正后再分析")
    else:
        progress("tuning", 0.04,
                 f"调音偏差 {tune_info['deviationCents']:+.0f} 音分（无需校正）")

    # ---- 1. 拍点（beat_this）
    progress("beats", 0.05, "识别拍点与小节…")
    beats, downbeats = run_beats(analysis_audio, result["song"]["durationSec"])
    result["beatsSec"] = [round(float(t), 4) for t in beats]
    result["downbeatsSec"] = [round(float(t), 4) for t in downbeats]
    progress("beats", 0.40, f"检出 {len(beats)} 拍 / {len(downbeats)} 小节")
    # 先把网格推出去：前端可以立刻画标尺/小节线，不用干等
    push_partial(result, "beats")

    # ---- 2. 和弦（lv-chordia 三档）
    progress("chords", 0.42, "识别和弦…")
    chords = run_chords(analysis_audio)

    # ---- 2b. madmom 交叉验证（只补候选，不覆盖 lv-chordia 的结果）
    #
    # lv-chordia 五折在某些段会全部判 N（实测两个可疑区间 18.5s / 7.7s），
    # 换权重和聚合方式都救不回来 —— 是模型本身识别不了。
    # madmom 架构完全不同，它的判断并进备选列表，用户可在检查器里选用。
    progress("chords", 0.78, "交叉验证和弦…")
    try:
        mad = run_madmom(analysis_audio)
        result["madmomChords"] = mad
        merge_madmom_candidates(chords, mad)
        n_cross = sum(
            1 for segs in chords.values() for x in segs if x.get("crossEngine")
        )
        progress("chords", 0.80,
                 f"检出 {len(chords.get('submission', []))} 个和弦段"
                 + (f"，{n_cross} 段由 madmom 补充候选" if n_cross else ""))
    except Exception as e:  # noqa: BLE001
        # 交叉验证失败不该阻断分析
        sys.stderr.write(f"[madmom] 交叉验证失败，跳过: {e}\n")

    # ---- 2c. 用和弦边界校正拍点的倍速/半速误判
    #
    # 放在和弦**之后**：判定依据是「和弦起点落在拍点上的比例」，
    # 这是用户真正感知的对齐。没有和弦时无法判定，所以顺序不能反。
    beats, downbeats = _pick_best_scale(
        beats, downbeats, chords.get('submission', [])
    )

    # ---- 2d. 用和弦切换点验证小节线相位（fallback）
    #
    # 修的是「间距完美均匀、但每条线整体偏了几十毫秒」这种错 ——
    # 靠拍点自身完全看不出来。和弦切换点能暴露它。
    # 阈值很保守：只有证据充分才平移（见函数说明）。
    beats, downbeats = _refine_downbeats_with_chords(
        beats, downbeats, chords.get('submission', [])
    )
    result["beatsSec"] = [round(float(t), 4) for t in beats]
    result["downbeatsSec"] = [round(float(t), 4) for t in downbeats]

    result["chords"] = chords
    # 和弦摆上去（这是用户最想先看到的）
    push_partial(result, "chords")

    # ---- 3. 结构（all-in-one-infer）
    progress("structure", 0.82, "分析歌曲结构…")
    try:
        sections = run_structure(analysis_audio)
        result["sections"] = sections
        progress("structure", 0.94, f"识别出 {len(sections)} 个段落")
        push_partial(result, "structure")
    except Exception as e:  # noqa: BLE001
        # 结构分析失败不该让整个分析失败（拍点和和弦已经拿到了）
        sys.stderr.write(f"[structure] 跳过: {e}\n")
        result["sections"] = []
        progress("structure", 0.94, "结构分析跳过（可选）")

    # ---- 4. 组装 meta + 速度段 + 量化
    progress("assemble", 0.95, "整理数据…")
    finalize(result)

    # ---- 5. 鼓组相位体检（只记录，不改网格）
    #
    # 拍点网格可能间距完美、和弦也对得上，但**整条偏了 1 拍** ——
    # 小节线落在军鼓上而不是底鼓上。这种错只有用鼓组编配规律才查得出：
    # 4/4 标准 backbeat 是「底鼓在 1/3 拍、军鼓在 2/4 拍」。
    #
    # **只写进 meta 供前端显示 / 人工核对，不做自动平移** ——
    # 平移网格牵一发动全身（和弦 tick、播放头、结构段全都跟着变），
    # 判据不稳时宁可不修。判据本身见 neural/check_groove.py。
    try:
        groove = _groove_health(
            analysis_audio,
            np.asarray(result["beatsSec"], dtype=float),
            result["song"]["durationSec"],
        )
        if groove:
            result.setdefault("meta", {})["groove"] = groove
            msg = f"[groove] {groove['note']}（置信度 {groove['confidence']:.0%}）"
            if groove["offset"]:
                msg += f" ⚠️ 建议小节起点后移 {groove['offset']} 拍"
            sys.stderr.write(msg + chr(10))
    except Exception as e:  # noqa: BLE001
        # 体检失败不该让整次分析失败
        sys.stderr.write(f"[groove] 跳过: {e}" + chr(10))
    progress("assemble", 1.0, "完成")

    return result



def detect_and_correct_tuning(audio_path: Path) -> dict:
    """检测调音偏差，必要时生成校正到 A=440 的临时音频。

    ## 为什么必须在所有模型之前做

    实测《満ちてゆく》整体偏低 34.7 音分（三种独立方法一致，分段极差仅 4.3），
    这不是噪声，是这首歌真的没按 A=440 录。

    同一首歌跑 lv-chordia 的对比：

        |            | 原始音频     | 校正到 440 后 |
        |------------|--------------|---------------|
        | 段数       | 122          | 160           |
        | N 总时长   | 33.7s (10.7%)| **8.6s (2.7%)** |
        | 根音主项   | C#/Ab/Eb/Bb  | A/D/E/B       |

    校正后模型自己就把绝大部分 N 消掉了 —— 之前以为是模型不行，
    其实是它收到的音频音高就是偏的。

    ## 什么时候跳过校正

      1. |偏差| < 15 音分 —— 正常录音的浮动范围，不值得动
      2. 分段抖动 > 8 音分 —— 可能是转调歌曲（或检测不可靠），
         整体移调会把另一段搞坏，宁可不动

    返回结构见下方 return；`analysisPath` 为 None 表示用原音频。
    """
    import tempfile

    info = {
        "deviationCents": 0.0,
        "corrected": False,
        "analysisPath": None,
        "methods": {},
        "segmentSpread": 0.0,
        "reason": "",
    }

    try:
        from detect_tuning import detect

        r = detect(audio_path)
    except Exception as e:  # noqa: BLE001
        # 检测失败不该阻断整个分析：宁可分析没校正的音频，也不能不分析
        sys.stderr.write(f"[tuning] 检测失败，跳过校正: {e}\n")
        info["reason"] = f"检测失败: {e}"
        return info

    cents = r["librosa"]
    info["deviationCents"] = cents
    info["segmentSpread"] = r["segment_spread"]
    info["methods"] = {
        "librosa": r["librosa"],
        "cqtPeaks": r["cqt_hist"],
        "harmonicPeaks": r["harmonic_peaks"],
    }

    # 三种方法必须一致，否则说明检测本身不可靠。
    #
    # `None` 表示该方法在这段素材上找不到谱峰（纯打击乐/静音/噪声型），
    # 不能当成 0 参与比较 —— 那会把「测不了」误判成「很准」。
    vals = [v for v in (r["librosa"], r["cqt_hist"], r["harmonic_peaks"]) if v is not None]
    if len(vals) < 2:
        info["reason"] = "有效检测方法不足两种，跳过校正"
        sys.stderr.write(f"[tuning] {info['reason']}\n")
        return info
    if max(vals) - min(vals) > 8:
        info["reason"] = "三种检测方法不一致，跳过校正"
        sys.stderr.write(f"[tuning] {info['reason']}: {vals}\n")
        return info

    if r["segment_spread"] > 8:
        info["reason"] = "分段抖动大（可能转调），跳过整体校正"
        sys.stderr.write(f"[tuning] {info['reason']}: {r['segments']}\n")
        return info

    if abs(cents) < 15:
        info["reason"] = "偏差在正常浮动范围内"
        return info

    # 生成校正后的临时音频
    try:
        import librosa
        import soundfile as sf

        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        # 偏差 -34.7 → 需要 +34.7 音分；pitch_shift 的 n_steps 单位是半音
        shifted = librosa.effects.pitch_shift(y, sr=sr, n_steps=-cents / 100.0)
        out = Path(tempfile.gettempdir()) / f"musicanaz_tuned_{abs(hash(str(audio_path)))}.wav"
        sf.write(str(out), shifted, sr)
        info["analysisPath"] = str(out)
        info["corrected"] = True
        sys.stderr.write(
            f"[tuning] 偏差 {cents:+.1f} 音分，已校正 → {out.name}\n"
        )
    except Exception as e:  # noqa: BLE001
        info["reason"] = f"校正失败: {e}"
        sys.stderr.write(f"[tuning] {info['reason']}\n")

    return info



def _refine_downbeats_with_chords(beats, downbeats, chord_segs, min_chords=10):
    """用**和弦切换点**验证并微调小节线位置。

    返回 `(beats, downbeats)`。

    ## 为什么和弦是个好锚点

    它和拍点检测是**完全独立的信号源**：
      - beat_this 看的是音频的节奏律动
      - lv-chordia 看的是和声内容

    而编曲上有一条很稳的规律：**和弦绝大多数在小节起点换**。
    实测三首歌，和弦切换点相对小节线的偏移主峰都在 ±0.15 拍内，
    且 50~60% 的切换点就压在小节线上（其余是真实的第 2/3 拍换和弦）。

    ## 它修的是哪种错

    拍点检测可能**整体相位偏移**（所有小节线一起早/晚了几十毫秒），
    这种错在「间隔是否均匀」的检查里完全看不出来 —— 间距可以完美均匀，
    但每一条线都偏了。和弦切换点能暴露它：主峰不在 0 就说明偏了。

    ## 为什么阈值定得很保守

    平移小节线是**破坏性**操作：如果根据错误的众数平移，
    会把原本对齐的数据弄坏，而且很难察觉（间距依然均匀）。

    所以要求三个条件同时满足才动手：
      1. 最优平移量 |delta| >= 0.2 拍（太小的偏移不值得冒风险）
      2. 平移后「和弦落小节线」的比例提升 >= 8 个百分点（要显著）
      3. 平移后比例本身 >= 45%（平移完仍然很差的说明和弦不可信）

    实测三首歌的最优 delta 都只有 0.05~0.15 拍、提升 0~3 点，
    全部不满足条件 → 保持原样。这正是期望行为：
    **默认不动，只在证据充分时才修**。
    """
    import numpy as np

    b = np.asarray(beats, dtype=float)
    d = np.asarray(downbeats, dtype=float)
    if len(b) < 16 or len(d) < 6 or not chord_segs or len(chord_segs) < min_chords:
        return b, d

    beat = float(np.median(np.diff(b)))
    if not (beat > 0):
        return b, d

    starts = np.asarray([float(s.get("start", 0.0)) for s in chord_segs], dtype=float)
    if len(starts) < min_chords:
        return b, d

    def hit_ratio(shift_sec):
        """和弦切换点落在小节线 ±0.25 拍内的比例。"""
        g = d + shift_sec
        n = 0
        for t in starts:
            k = int(np.argmin(np.abs(g - t)))
            if abs(t - g[k]) < 0.25 * beat:
                n += 1
        return n / len(starts)

    cur = hit_ratio(0.0)

    # 只在半个拍内搜索：更大的偏移说明是别的问题（漏小节、错拍号），
    # 不该靠平移解决
    best_delta, best_ratio = 0.0, cur
    for delta in np.arange(-0.5, 0.501, 0.05):
        r = hit_ratio(delta * beat)
        if r > best_ratio:
            best_delta, best_ratio = float(delta), r

    sys.stderr.write(
        f"[chord-align] 和弦落小节线 {cur * 100:.0f}%，"
        f"最优平移 {best_delta:+.2f} 拍 → {best_ratio * 100:.0f}%" + chr(10)
    )

    improved = (best_ratio - cur) >= 0.08
    significant = abs(best_delta) >= 0.2
    reliable = best_ratio >= 0.45

    if not (improved and significant and reliable):
        return b, d

    shift = best_delta * beat
    sys.stderr.write(
        f"[chord-align] 采用平移 {best_delta:+.2f} 拍（{shift * 1000:+.0f}ms）"
        + chr(10)
    )
    return b + shift, d + shift
def _pick_best_scale(beats, downbeats, chord_segs):
    """检测并纠正拍点的倍速/半速误判。

    返回 `(beats, downbeats)`。

    ## 问题

    beat_this 对「主拍 vs 半拍」的二义性**不稳定**：同一首歌在不同 run、
    不同音频变体（比如调音校正后的重采样版）上，可能给出
    0.42s/拍（143 BPM），也可能给出 0.84s/拍（71 BPM）。后者在音乐上
    也说得通（一个听主拍、一个听半拍），但落到谱面是**完全不同的两套
    小节线** —— 用户看到的就是「强拍和小节线偏移」。

    实测《満ちてゆく》：模型稳定给 0.84s/拍，但和弦边界明显是按 0.42s
    的网格在换（51% 精确落在 0.418s 网格的拍点上，只有 19% 落在 0.84s
    网格上）。

    ## 判据：和弦边界吻合度

    试过两种都不行：

      1. **onset 强度打分** —— 整首算差距只有 5~10%；分片段算更糟，
         1.68s 这种超慢网格反而常常得高分（点少更容易集中命中）。
      2. **librosa tempo** —— 对这首歌能看出来，但实测另外两首里有一首
         偏差 10%（99.4 vs 90.2），阈值不好定。

    最终用：**和弦起点落在拍点上的比例**。这是用户真正感知的对齐 ——
    和弦换在哪，拍就应该在哪。候选只有 3 个（当前 / 一半 / 两倍），
    直接选吻合度最高的。

    ## 为什么要 >1.25 倍才改

    半速/倍速的网格天然会让**一部分**和弦也落在拍上（0.84s 的拍点是
    0.42s 拍点的子集）。所以两个网格的吻合度不会是 0 vs 1，实测是
    51% vs 19%（比值 2.7）。阈值 1.25 留足余量，正常节奏不会被误改。

    而且改的时候是**在中间插拍/抽拍**，不改已有拍点的位置 ——
    即使判错，用户看到的拍点位置仍然正确，只是密度不对，容易手动修。
    """
    import numpy as np

    b = np.asarray(beats, dtype=float)
    d = np.asarray(downbeats, dtype=float)
    if len(b) < 16 or len(d) < 4 or not chord_segs:
        return b, d

    def fit_score(beat_grid, lo=None, hi=None):
        """和弦起点距最近拍点的中位偏移（单位：拍，越小越好）。

        ## 为什么用中位偏移而不是「落点比例」

        半速拍点是原网格拍点的**子集**，所以「落在拍上」的比例天然更高
        （实测这首歌 0.84s 网格 65% vs 0.42s 网格 51%）。用比例判会选错。

        中位偏移度量的是「和弦离最近的拍有多远」，与网格密度无关。

        ## 为什么不整首算，而是分段

        **现场演奏 / 真人录音的 BPM 会漂移**。整首算一个周期再套下去，
        漂移大的歌会在后半段整体错位。所以判定按 30 秒分段投票 ——
        只要有一部分段落明显支持另一套网格，就说明模型判错了倍速。
        """
        gap = float(np.median(np.diff(beat_grid)))
        if not (gap > 0):
            return 9.9
        offs = []
        for seg in chord_segs:
            t = float(seg.get("start", 0.0))
            if lo is not None and not (lo <= t < hi):
                continue
            k = int(np.argmin(np.abs(beat_grid - t)))
            offs.append(abs(t - beat_grid[k]) / gap)
        if not offs:
            return 9.9
        return float(np.median(np.asarray(offs)))

    # ## 合理性边界：先排除不可能的拍速
    #
    # 40~240 BPM（0.25~1.5 秒/拍）之外的基本都是模型判错了。
    # 而且「往更慢的方向选」特别危险：越慢的网格中位偏移天然越小
    # （实测这首歌 0.835s→0.059、1.67s→0.045），会一路往慢选到 35 BPM。
    # 所以只在**合理区间内**比较。
    gap0 = float(np.median(np.diff(b)))
    if not (0.25 <= gap0 <= 1.5):
        return b, d

    cands = [("当前", b)]
    # 一半：在每两拍之间插一拍（模型判成半速时用）
    half = []
    for i in range(len(b) - 1):
        half.append(b[i])
        half.append((b[i] + b[i + 1]) / 2.0)
    half.append(b[-1])
    cands.append(("一半", np.asarray(half)))
    # 「两倍」（抽稀一半）**不加**。
    #
    # 它是「模型把拍检多了」的修正，但这条路很危险：抽稀后拍点变少，
    # 中位偏移天然更小（实测 0.835s→0.059、1.67s→0.045），会一路往慢选，
    # 最终把一首 143 BPM 的歌判成 35 BPM。
    #
    # 而且实际遇到的误判几乎都是**半速**（模型把八分音符当拍），
    # 倍速（把半拍当拍）极少 —— beat_this 倾向于少检而不是多检。
    # 所以只保留「插拍」这一个方向，宁可漏修也不往慢了错。

    # ## 分段投票
    #
    # 不整首一刀切：现场演奏的 BPM 会漂移，整首算一个周期会把后半段带偏。
    # 按 30 秒分段，看每一段里哪套网格让和弦更贴合拍点，多数决定。
    total = float(np.max(b)) if len(b) else 0.0
    seg_lo = 0.0
    votes = {name: 0 for name, _ in cands}
    margins = {name: [] for name, _ in cands}
    while seg_lo < total:
        seg_hi = seg_lo + 30.0
        meds = {name: fit_score(grid, seg_lo, seg_hi) for name, grid in cands}
        # 该段有和弦吗？（没有和弦就跳过，别投空票）
        if any(m < 9.0 for m in meds.values()):
            winner = min(meds, key=lambda k: meds[k])
            votes[winner] += 1
            for name in meds:
                if meds[name] < 9.0:
                    margins[name].append(meds[name])
        seg_lo = seg_hi

    for name, grid in cands:
        ms = margins[name]
        avg = float(np.mean(ms)) if ms else 9.9
        sys.stderr.write(
            f"[beats] 倍速候选 {name}: {len(grid)} 拍, "
            f"分段胜出 {votes[name]}, 平均中位偏移 {avg:.3f} 拍" + chr(10)
        )

    # ## 判定：看投票，不看单段最优
    #
    # `fit_score` 返回的是「和弦离最近拍点的中位偏移」（单位：拍）。
    # 不用「落在拍上的比例」—— 半速拍点是原网格的子集，比例天然更高，
    # 实测这首歌 0.84s 网格 65% vs 0.42s 网格 51%，用比例判会选错。
    #
    # ## swing 节奏
    #
    # 这首歌是 swing（八分音符切成约 2:1，实测短间隔 0.196s / 长 0.453s，
    # 比值 2.31）。swing 歌的「真实拍速」是那个**长周期**，不是二分频，
    # 所以当前网格（更慢的那个）天然占优 —— 除非插拍方向压倒性胜出。
    cur_votes = votes["当前"]
    best_name = max(votes, key=lambda k: votes[k])
    if best_name == "当前" or votes[best_name] <= cur_votes:
        return b, d

    name, grid = best_name, dict(cands)[best_name]
    sys.stderr.write(
        f"[beats] 采用「{name}」网格: {len(b)} -> {len(grid)} 拍 "
        f"(分段投票 {cur_votes} -> {votes[best_name]})" + chr(10)
    )
    # 插拍是在**已有点之间插**，原有 downbeat 的时刻不变，
    # 所以这里不需要重建 downbeats。
    return grid, d
def run_beats(audio_path: Path, duration: float) -> tuple:
    """用 beat_this 识别拍点与小节。"""
    import numpy as np
    import torch

    sys.path.insert(0, str(Path(__file__).parent / "beat_this"))
    from beat_this.inference import load_model, split_predict_aggregate
    from beat_this.preprocessing import LogMelSpect
    import soxr
    import soundfile as sf

    # 5 秒小块读，容忍尾部损坏（同 final_beat_this.py 的经验）
    with sf.SoundFile(str(audio_path)) as f:
        sr0 = f.samplerate
        chunks = []
        while True:
            try:
                d = f.read(sr0 * 5, dtype="float32", always_2d=True)
            except Exception:  # noqa: BLE001
                break
            if len(d) == 0:
                break
            chunks.append(d)
    sig = np.concatenate(chunks, axis=0)
    sig = sig.mean(axis=1) if sig.shape[1] > 1 else sig[:, 0]
    y = soxr.resample(sig, sr0, 22050) if sr0 != 22050 else sig

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = load_model("final0", device=device)

    # 注意：LogMelSpect 内部的 torchaudio.MelSpectrogram 有自己的 buffer（窗函数 +
    # mel filterbank），必须和输入张量在同一个设备上，否则报
    #   "stft input and window must be on the same device"
    # 所以 device 要同时传给 LogMelSpect 和输入张量。
    spect = LogMelSpect(device=device)
    with torch.no_grad():
        sp = spect(torch.tensor(y, dtype=torch.float32, device=device))
        pred = split_predict_aggregate(
            spect=sp, chunk_size=1500, overlap_mode="keep_first",
            border_size=6, model=model,
        )
    from beat_this.model.postprocessor import Postprocessor

    pp = Postprocessor(type="minimal", fps=50)
    mask = torch.ones(sp.shape[0], dtype=torch.bool)
    with torch.no_grad():
        beats, downs = pp(pred["beat"].float().cpu(), pred["downbeat"].float().cpu(), mask)

    def dedupe(times, gap):
        times = np.asarray(times, dtype=float)
        if len(times) == 0:
            return times
        keep = [0]
        for i in range(1, len(times)):
            if times[i] - times[keep[-1]] >= gap:
                keep.append(i)
        return times[keep]

    beats = dedupe(beats, 0.25)
    downs = dedupe(downs, 1.0)

    # ## 修正倍速/半速误判
    #
    # beat_this 对「主拍 vs 半拍」的二义性判断不稳定：同一首歌可能给出
    # 0.42s/拍（143 BPM），也可能给出 0.84s/拍（71 BPM）。后者在音乐上
    # 也说得通，但落到谱面是完全不同的两套小节线。
    #
    # 实测《満ちてゆく》：beat_this 稳定给 0.84s/拍，而 librosa 给 143.6 BPM。
    # 用 onset 命中率客观判定 → 0.418s 网格得分 1.925，0.84s 网格得分 1.345，
    # 所以 143 BPM 是对的，beat_this 判成了半速。
    # ## 修正倍速/半速误判（用和弦边界做客观判定）
    #
    # beat_this 对「主拍 vs 半拍」的二义性不稳定：同一首歌在不同 run、
    # 不同音频变体上可能给出 0.42s/拍（143 BPM）或 0.84s/拍（71 BPM）。
    #
    # 试过两种判据都不行：
    #   1. onset 强度打分 —— 整首算或分片段算，差距都只有 5~10%，
    #      而且 1.68s 这种超慢网格也常常得高分（点少更容易集中命中）。
    #   2. librosa tempo —— 这个对 143.7 vs 71.4 能看出来，但两首歌里
    #      有一首偏差 10%，阈值不好定。
    #
    # 最终判据：**和弦边界落在拍点上的比例**。这是用户真正看到的东西 ——
    # 和弦换在哪，拍就应该在哪。实测这首歌：
    #   0.418s 网格 → 51% 和弦起点精确落在拍上，中位偏移 0.095 拍
    #   0.84s  网格 → 19%，中位偏移 0.275 拍（差近 3 倍）
    # 因为候选只有 2 个（当前 / 一半 / 两倍），直接选吻合度最高的那个。
    # （倍速/半速校正放在 analyze() 里、和弦算完之后做，见 _pick_best_scale）

    # ## 关键：beats 和 downbeats 必须"索引对齐"
    #
    # 踩过的大坑（症状：和弦块越往后越往右漂，最多偏 4 拍）。
    #
    # 前端画小节线用 `downbeatsSec`，而「秒 → tick」用的是 `beatsSec`
    # 的**下标**（第 i 个拍点 = tick i×PPQ）。两者必须是同一个网格：
    # downbeats[k] 必须正好等于 beats[4k]（4/4 拍）。
    #
    # beat_this 在小节交界处会**多检出拍点**（实测 88 处 0.20~0.22s 的假拍，
    # 而真实拍间隔是 0.42s），导致 beats 比"小节数×4"多出 41 个。
    # 于是 beats 的下标和小节线错位，而且**误差随歌曲推进累积** ——
    # 表现为和弦块起点还行、右边界越过小节线越来越多。
    #
    # 修法：以 downbeats 为骨架重建拍位。每个小节内部按该小节的长度
    # 均分出 4 拍。这样：
    #   - downbeats[k] 严格 == beats[4k]，索引对齐
    #   - 小节内的拍位也不再受假拍干扰
    # 代价：小节内部的轻微不均分被抹平（人耳几乎不可闻，而且这种
    # "抢拍"本来也该由用户手动调，不该由模型噪声决定）。
    before = len(beats)
    # 注意：`before_downs` 必须在**补开头小节之后**再取。
    # 拿补之前的那份去和补之后的相减，长度不同会直接抛
    # ValueError: operands could not be broadcast together with shapes (121,) (120,)

    # ## 开头没被网格覆盖的那段，补成一个虚拟小节
    #
    # 模型的第一个 downbeat 通常是「音乐真正进入」的位置（《何なんw》是 2.76s），
    # 而音频 0.28s 起就有前奏了。于是 tick 0 = 2.76s，前奏完全不在网格里：
    # 谱面左边空白、播放 0~2.76s 时光标卡死在最左端。
    #
    # 补一个虚拟小节起点（`d[0] - 中位小节时长`，不足 0 取 0），让前奏也被覆盖。
    # 补出来的小节内部拍点是均分的，只为让谱面连续；前奏若是散板，
    # 这些拍点本来也不代表真实节拍。
    #
    # 幂等：只在小节离 0 超过半小节时补，补完 d[0] 已接近 0，不会补第二次。
    if len(downs) >= 3:
        _spans = np.diff(downs)
        _med_bar = float(np.median(_spans))
        if _med_bar > 0 and downs[0] >= _med_bar * 0.5:
            _pad = max(0.0, float(downs[0]) - _med_bar)
            downs = np.concatenate([[ _pad ], downs])
            sys.stderr.write(
                f"[beats] 开头补一个虚拟小节: 0.00~{downs[1]:.2f}s"
                + chr(10)
            )

    # 到这里 downs 已经补过开头小节了，这才是「重建前」的正式基线
    before_downs = np.asarray(downs, dtype=float)
    beats, downs = _rebuild_beats_from_downbeats(
        beats, downs, BEATS_PER_BAR, duration
    )
    moved = int((np.abs(np.asarray(downs) - before_downs) > 1e-6).sum())
    sys.stderr.write(
        f"[beats] 重建拍网格: {before} 拍 -> {len(beats)} 拍 "
        f"({len(downs)} 小节 x {BEATS_PER_BAR} 拍，索引已对齐)" + chr(10)
    )
    if moved:
        sys.stderr.write(
            f"[beats] 修正了 {moved} 个小节的边界（倍速/半速检出）" + chr(10)
        )

    return beats, downs


def _rebuild_beats_from_downbeats(beats, downs, beats_per_bar: int, duration: float = 0.0):
    """用 downbeats 当骨架重建拍点，保证 `downs[k] == beats[k*beats_per_bar]`。

    返回 `(beats, downbeats)`。

    **downbeats 可能被修正过**（倍速/半速的小节被拉回中位时长），
    所以调用方必须用返回的这份，不能继续用传进来的原值 ——
    否则 `beats` 是新网格、`downbeats` 是旧边界，前端画小节线时又错位。

    ## 为什么不在模型输出上"删假拍"而要重建

    删假拍要先判断哪个是假的 —— 而 0.20s 和 0.42s 之间的界限在变速歌里
    并不牢靠（慢歌一拍可能就 0.6s，快歌 0.25s）。判错一个就少一拍，
    后面全错。

    downbeats 的数量是可靠的（一首歌的小节数是确定的），用它当骨架
    就不需要判断"哪一拍是假的"—— 每小节固定 `beats_per_bar` 拍，
    位置由小节边界决定。

    ## 边界情况

    - 某小节内模型拍数和 `beats_per_bar` 不一致（漏检/多检）：
      仍然均分，因为均分一定不会让**后续小节**漂移。
    - 最后一个小节之后没有 downbeat：用倒数第二到最后一个 downbeat
      的间隔外推，把剩下的拍补出来（否则曲末无拍点，谱面画不满）。
    """
    import numpy as np

    b = np.asarray(beats, dtype=float)
    d = np.asarray(downs, dtype=float)
    if len(d) == 0:
        return b, d
    if len(d) == 1:
        # 只有一个小节：按已有拍的平均间隔外推
        gap = float(np.median(np.diff(b))) if len(b) > 1 else 0.5
        return d[0] + np.arange(max(1, len(b))) * gap, d

    # ## 先修正异常的 downbeat 间隔
    #
    # 踩过的坑（症状：**开头几小节的强拍和小节线错位**）。
    #
    # beat_this 在歌曲开头/结尾会**倍速或半速**地检出拍点。实测《何なんw》：
    #
    #   beat[0] 2.760  gap=0.340  <-DOWNBEAT
    #   beat[1] 3.100  gap=0.340
    #   ...            gap 全是 0.340（正常 0.665，正好一半）
    #   beat[4] 4.120  gap=0.835  <-DOWNBEAT   ← 突然跳到 0.835
    #
    # 于是 downbeat[0]=2.760 到 downbeat[1]=4.120 只差 1.36s（约 2 拍）。
    # 直接按 `beats_per_bar` 均分的话，这一小节被压成 1.36s，
    # 后面的小节线全部前移 —— 用户看到的就是「强拍和小节线偏移」。
    #
    # 判据：某小节时长明显偏离**中位小节时长**（<55% 或 >180%）。
    # 处理方式不是「删掉可疑小节」（那会凭空少一块信息），
    # 而是把该小节的边界**按中位时长的整数倍重算**，保证网格连续。
    med_bar = float(np.median(np.diff(d))) if len(d) > 2 else 0.0
    if med_bar > 0:
        fixed = [d[0]]
        for i in range(1, len(d)):
            span = d[i] - fixed[-1]
            ratio = span / med_bar
            if ratio < 0.55 or ratio > 1.8:
                # 倍速/半速通常正好是 0.5x 或 2x，所以按整数倍推进
                mult = max(1, int(round(ratio)))
                span = med_bar * mult
            fixed.append(fixed[-1] + span)
        d = np.asarray(fixed, dtype=float)

    out = []
    for i in range(len(d) - 1):
        bar_start, bar_end = d[i], d[i + 1]
        step = (bar_end - bar_start) / beats_per_bar
        for k in range(beats_per_bar):
            out.append(bar_start + k * step)

    # 最后一段：用最后一小节的速度外推补齐尾拍。
    #
    # ⚠️ `tail_end` 必须以**音频真实末尾**为上界。
    #
    # 踩过的坑：这里原来写 `max(b[-1], d[-1] + last_span)`，当 d 被上面的
    # 修正逻辑改过（异常小节被拉长）时，`d[-1]` 可能已经远超前于音频末尾，
    # 于是补出一大堆不存在的拍 —— 实测多出 54 秒（末拍 369s vs 曲长 315s），
    # 前端按 totalTicks 截断后表现为「谱面比歌长」。
    # ## 上界必须是**音频真实时长**，不是原始 beats 的末拍
    #
    # beat_this 会往外推几个拍（它不知道音频什么时候结束），
    # 用 `b[-1]` 当上界就会把超界的东西带进来。实测《何なんw》
    # 末拍补到 322.08s，而曲长只有 319.97s —— 前端按 totalTicks
    # 截断后表现为「谱面比歌长」，播放到结尾时播放头跑在音频外面。
    audio_end = float(duration) if duration > 0 else (float(b[-1]) if len(b) else d[-1])
    # 原始 beats 的末拍如果没超界，用它（更贴近真实最后一拍）
    if len(b) and b[-1] <= audio_end:
        audio_end = float(b[-1])
    last_span = d[-1] - d[-2]
    step = last_span / beats_per_bar
    # 补到音频末尾为止
    n_tail = max(0, int(np.ceil((audio_end - d[-1]) / step)))
    for k in range(n_tail + 1):
        t = d[-1] + k * step
        # 硬性截断：绝不产出超过音频末尾的拍点
        if k > 0 and t > audio_end + step:
            break
        out.append(t)
    return np.asarray(out, dtype=float), d



def _segment_alternatives(logprob, names, col, start, end, delta, chosen, top_k=4):
    """给一个和弦段算出「备选和弦」和「置信度」。

    ## 为什么在后端做聚合

    模型输出的是**逐帧**概率（301 个和弦类别 × 13000+ 帧 ≈ 400 万个值，16MB）。
    直接丢给前端既不现实也没意义 —— 用户关心的是「这一小节的第二可能是什么」，
    不是每一帧的分布。所以这里按段取平均，只传 top-k。

    ## 做法

    1. 把该段覆盖的所有帧的概率**取平均**（不是取最后一帧，避免受边界干扰）
    2. 归一化后取概率最高的 k 个
    3. `confidence` = 被选中和弦的平均概率

    这样前端拿到的每个段只多 4 个候选，体积可以忽略。
    """
    import numpy as np

    i0 = max(0, int(round(start / delta)))
    i1 = min(logprob.shape[0], max(i0 + 1, int(round(end / delta))))
    if i1 <= i0:
        return {"confidence": 0.0, "alternatives": []}

    # log 概率 → 概率，再对整段取平均
    frame_probs = np.exp(logprob[i0:i1])
    mean_p = frame_probs.mean(axis=0)
    total = float(mean_p.sum())
    if total <= 0:
        return {"confidence": 0.0, "alternatives": []}
    mean_p = mean_p / total

    order = np.argsort(-mean_p)[:top_k]
    alts = [
        {"chord": names[i], "prob": round(float(mean_p[i]), 4)}
        for i in order
        if mean_p[i] > 1e-4
    ]

    chosen_prob = round(float(mean_p[col[chosen]]), 4) if chosen in col else 0.0
    return {"confidence": chosen_prob, "alternatives": alts}


def run_chords(audio_path: Path) -> dict:
    """用 lv-chordia 5 模型 ensemble 识别和弦（三档词典）。"""
    import importlib.resources

    import librosa
    import numpy as np
    import soxr
    import soundfile as sf
    import torch

    root = Path(__file__).parent / "lv-chordia"
    sys.path.insert(0, str(root))
    from lv_chordia.chordnet_ismir_naive import ChordNet
    from lv_chordia.config import model_names
    from lv_chordia.extractors.xhmm_ismir import XHMMDecoder
    from lv_chordia.mir import DataEntry, io
    from lv_chordia.mir.nn.network import NetworkInterface

    with sf.SoundFile(str(audio_path)) as f:
        sr0 = f.samplerate
        chunks = []
        while True:
            try:
                d = f.read(sr0 * 5, dtype="float32", always_2d=True)
            except Exception:  # noqa: BLE001
                break
            if len(d) == 0:
                break
            chunks.append(d)
    sig = np.concatenate(chunks, axis=0)
    sig = sig.mean(axis=1) if sig.shape[1] > 1 else sig[:, 0]
    y = soxr.resample(sig, sr0, 22050) if sr0 != 22050 else sig

    cqt = np.abs(
        librosa.core.hybrid_cqt(
            y, sr=22050, bins_per_octave=36, n_bins=288,
            fmin=librosa.note_to_hz("F#0"), tuning=None, hop_length=512,
        )
    ).T.astype(np.float32)

    probs = []
    for n in model_names():
        net = ChordNet(cross_subpart_counter=None, use_gpu=False)
        ni = NetworkInterface(net, n)
        probs.append(ni.inference(cqt))

    # ---------------------------------------------------------------- 五折聚合
    #
    # 用**中位数**，不用平均。
    #
    # ## 为什么（实测数据，不是猜的）
    #
    # 《満ちてゆく》有两段模型识别失效的长 N（31~38.68s、215.46~233.94s）。
    # 逐折检查发现五折**分歧极大**，但每一折都给出了有音乐意义的具体和弦：
    #
    #     区间 215~234s：
    #       s0 → F:min7   s1 → C#:min   s3 → F:min/5   s4 → Ab:maj/5
    #       ensemble(mean) → N
    #
    # mean 会把少数派的峰值平均掉，HMM 收到的分布接近均匀 → 退化成一串 N。
    #
    # 同一首歌的对比（N 占总时长）：
    #
    #     mean      N 5 段 / 47.9s (15.2%)   215~234s 仍是整块 18.5s 的 N
    #     median    N 8 段 / 33.7s (10.7%)   拆成 Ab:maj → A:maj → F#:min → Bb:min
    #     trimmed   N 8 段 / 36.5s (11.6%)   同上但略差
    #     max       N 8 段 / 87.8s (27.9%)   过激，别处冒出大量 N
    #
    # 所以选 median：N 总时长降 30%，且**不是拿别处换来的**（其他段落没变差）。
    #
    # 另外试过换 label-reweighting 权重（0.3,10.0 / 1.0,20.0）：
    # N 段反而涨到 14~16 个、占比 28~33%。**权重不用换**。
    #
    # ## 必须重新归一化
    #
    # median 之后各列不一定和为 1，HMM 的发射概率尺度会不对。
    avg = [np.median([p[k] for p in probs], axis=0) for k in range(6)]
    avg = [
        m / np.clip(m.sum(axis=1, keepdims=True), 1e-12, None) for m in avg
    ]

    entry = DataEntry()
    entry.prop.set("sr", 22050)
    entry.prop.set("hop_length", 512)
    entry.append_file(str(audio_path), io.MusicIO, "music")
    entry.cqt = cqt

    delta = entry.prop.hop_length / entry.prop.sr

    out = {}
    for name in ("submission", "ismir2017", "full"):
        with importlib.resources.path("lv_chordia.data", f"{name}_chord_list.txt") as tpl:
            hmm = XHMMDecoder(template_file=str(tpl))
        lab = hmm.decode_to_chordlab(entry, avg, False)

        # 和弦名 → 概率矩阵的列号（同一个 HMM 实例，所以名字顺序一致）
        tag_names, tag_logprob = hmm.get_chord_tag_obs(avg)
        col = {n: i for i, n in enumerate(tag_names)}

        segs = []
        for (s, e, ch) in lab:
            seg = {
                "start": round(float(s), 3),
                "end": round(float(e), 3),
                "chord": str(ch),
            }
            seg.update(
                _segment_alternatives(tag_logprob, tag_names, col, float(s), float(e), delta, str(ch))
            )
            segs.append(seg)
        out[name] = segs
    torch.cuda.empty_cache()
    return out


def run_madmom(audio_path: Path) -> list:
    """用 madmom（DeepChroma + CRF）识别和弦，作为 lv-chordia 的独立第二引擎。

    ## 为什么需要第二引擎

    实测这首歌 lv-chordia 五折在某些段全部判 N（215~234s 那段 18.5 秒、31~39s 那段
    7.7 秒），换权重、换聚合方式都没用 —— 那是模型本身在该处的识别能力不足。
    madmom 架构完全不同（DL 特征 + 条件随机场，不是 ChordNet + HMM），
    它的判断可以拿来对 N 段做交叉验证。

    ## 但它只有 maj/min

    `majmin_targets_to_chord_labels` 是硬编码的 25 类：12 个大三和弦、12 个小三和弦、
    1 个 N。**没有七和弦、挂留和弦、转位**。

    这对我们的用法恰好合适：
      - lv-chordia 仍负责**主输出**（保留 7th / sus / 转位这些细节）
      - madmom 只在 lv 判 N 的地方提供「至少这里是 maj 还是 min」的信息

    ## 输出格式

    统一成 lv-chordia 的写法（`C:maj` / `C:min`），方便前端直接比较和选用。
    音频加载走 librosa：madmom 自带的 Signal 按 wav 解析 RIFF，
    读 flac 会直接在 `_read_riff_chunk` 抛异常，必须先用 librosa 解码成数组传进去。
    """
    import librosa
    from madmom_infer import api

    y, sr = librosa.load(str(audio_path), sr=44100, mono=True)
    segs = api.recognize_chords(y, sample_rate=sr, backend="numpy")

    out = []
    for start, end, chord in segs:
        c = str(chord)
        # madmom 用 "A#" 表示升号；统一成和弦词表里的降号写法（C#, F# 除外）
        root = c.split(":")[0] if ":" in c else c
        if root.endswith("#") and root not in ("C#", "F#"):
            root = FLAT_NAMES.get(root, root)
        out.append({
            "start": round(float(start), 3),
            "end": round(float(end), 3),
            "chord": root if c == "N" else f"{root}:{c.split(':')[1]}",
        })
    return out


# 升号 → 降号（模型/词表混用这两种写法）
FLAT_NAMES = {
    "D#": "Eb", "G#": "Ab", "A#": "Bb",
}


def overlap_seconds(a0: float, a1: float, b0: float, b1: float) -> float:
    """两个区间的重叠秒数。"""
    return max(0.0, min(a1, b1) - max(a0, b0))


def _tonic_chord(madmom: list) -> str | None:
    """猜整首歌的主和弦（madmom 报得最多的那个）。

    ## 为什么要这个

    madmom 只有 maj/min，它有个明显的倾向：**把这首调内的一切都听成主和弦**。
    实测本歌 35 个候选里有 19 个是 `A:maj`（这首歌就是 A 调）。

    这种候选是「调性泛化」而不是「具体和弦判断」—— 它没有提供任何
    区别于「这首是 A 调」的信息，放进候选只会让列表变吵。

    用它做过滤：madmom 报的若是主和弦，就跳过。
    """
    from collections import Counter

    cnt = Counter(m["chord"] for m in madmom if m["chord"] != "N")
    if not cnt:
        return None
    return cnt.most_common(1)[0][0]


def merge_madmom_candidates(chords: dict, madmom: list, min_overlap: float = 0.6) -> None:
    """把 madmom 的判断并入 lv-chordia 的备选列表（原地修改）。

    ## 策略：只做「补充」，不覆盖

    lv-chordia 给出和弦的地方，它的判断是精细的（有 7th / sus / 转位），
    而 madmom 只能报 maj/min —— **拿 majmom 覆盖精细结果一定是退步**。

    所以只在两种情况下把 madmom 加进候选：
      1. 该段 lv 判 `N`（模型放弃识别）
      2. madmom 的根音和 lv 的不同（说明两者有分歧，值得让用户看到）

    第 2 种覆盖整首歌的分歧点，用户可以在检查器里看到「另一个引擎认为是 X」。

    ## 置信度怎么给

    madmom 没有输出概率，所以用**重叠占比**当置信度：madmom 那段和弦
    在这个 lv 段里覆盖了多久。重叠 >90% 给 0.8，否则按比例给。

    `min_overlap` 是阈值：重叠不足 0.6 秒视为无关（短促过渡不值得当候选）。
    """
    if not chords or not madmom:
        return

    # madmom 报得最多的和弦 = 这首歌的主和弦，它出现在哪里都不算新信息
    tonic = _tonic_chord(madmom)

    for dict_name, segs in chords.items():
        for seg in segs:
            s0, s1 = seg["start"], seg["end"]
            # 找与该段重叠最多的 madmom 段
            best, best_ov = None, 0.0
            for m in madmom:
                ov = overlap_seconds(s0, s1, m["start"], m["end"])
                if ov > best_ov:
                    best, best_ov = m, ov
            if best is None or best_ov < min_overlap:
                continue
            if best["chord"] == "N":
                continue
            chosen = seg["chord"]
            # 主和弦 = 调性泛化，不是具体判断（详见 _tonic_chord）
            if best["chord"] == tonic and chosen != "N":
                continue
            # 同一个和弦就不用加了
            if best["chord"] == chosen:
                continue
            # 根音相同（只是精细度不同）也不加：那是 lv 更强的地方
            same_root = (
                chosen != "N"
                and chosen.split(":")[0].split("/")[0]
                == best["chord"].split(":")[0]
            )
            if same_root:
                continue

            seg_len = max(1e-6, s1 - s0)
            ratio = min(1.0, best_ov / seg_len)
            # ## madmom 的概率必须封顶在 lv 自己的置信度之下
            #
            # 踩过：最初给 0.45+0.35*ratio（满重叠 = 0.8），结果 madmom 的候选
            # 排到了 lv 选中结果的前面（lv 的置信度常常只有 0.11~0.45）。
            # 视觉上就是「另一个引擎更可信」，会把人带偏。
            #
            # madmom 只有 maj/min，它报的 A:maj 往往是「这一段属于 A 调」的
            # 泛化感知，不是具体和弦 —— 拿它压过 C#:min7 这种精细判断是退步。
            #
            # 所以：madmom 的概率只表示「它的把握」，且**不超过 lv 选中项**。
            chosen_conf = seg.get("confidence") or 0.0
            ceiling = max(0.10, chosen_conf) * 0.9
            prob = round(min(ceiling, 0.30 + 0.40 * ratio), 4)

            alts = seg.setdefault("alternatives", [])
            names = {a.get("chord") for a in alts}
            if best["chord"] in names:
                continue
            alts.append({
                "chord": best["chord"],
                "prob": prob,
                # 来源标记：前端据此显示「madmom 认为是」
                "source": "madmom",
            })
            # 按概率重排，并截断到 5 个（lv 自己 4 个 + madmom 1 个）
            alts.sort(key=lambda x: -x.get("prob", 0))
            del alts[5:]

            # 记下来源，前端可以标注「此段由另一引擎补充」
            if chosen == "N":
                seg["crossEngine"] = "madmom"


def run_structure(audio_path: Path) -> list:
    """用 all-in-one-infer 识别段落（可选，失败不影响主流程）。"""
    import allin1_infer

    res = allin1_infer.analyze(
        str(audio_path),
        model="harmonix-all",
        device="cuda",
        skip_separation=False,
        multiprocess=False,
        include_activations=False,
    )
    return [
        {"start": round(float(s.start), 3), "end": round(float(s.end), 3), "label": s.label}
        for s in res.segments
    ]


def _groove_health(audio_path, beats, duration):
    """用鼓组编配规律检查小节相位，返回体检结果（不改任何数据）。

    ## 判据

    4/4 流行/摇滚的标准 backbeat：
      第 1、3 拍 → 底鼓（30~110 Hz）
      第 2、4 拍 → 军鼓（鼓皮基频 150~450 Hz）

    如果底鼓主要落在 2/4 拍，说明整条网格偏了奇数拍。

    ## 两个必须注意的点

    1. **先 HPSS 分出打击乐**，否则贝斯的持续音会盖掉底鼓瞬态。
    2. **不能用 2.5~6kHz 判军鼓** —— 那是镲片/响弦，每拍都在响。

    具体实现和阈值见 `neural/check_groove.py`（同一套判据，那个是命令行工具）。
    """
    # 本模块的 librosa 都是函数内 import（启动快），这里也要显式导入
    import librosa
    import numpy as np

    from check_groove import analyze_phase, judge, summarize

    dur = float(duration)
    if dur <= 0 or len(beats) < 16:
        return None

    # 只查中间一段：避开前奏（常常没鼓）和尾奏（常常淡出）
    t0 = dur * 0.15
    t1 = min(dur * 0.75, t0 + 90.0)
    y, sr = librosa.load(str(audio_path), sr=22050, mono=True, offset=t0, duration=t1 - t0)

    mask = (beats >= t0) & (beats < t1)
    sel = beats[mask]
    if len(sel) < 16:
        return None
    # 相位必须基于**全局**拍索引，不能拿子集下标取模（否则相位全错）
    start_index = int(np.argmax(mask))

    rows = analyze_phase(sel - t0, sr, y, start_index)
    if not rows:
        return None
    stats = summarize(rows)
    offset, conf, note = judge(stats)

    return {
        "offset": int(offset),
        "confidence": round(float(conf), 3),
        "note": str(note),
        "kick": [round(float(s["kick"]), 1) for s in stats if s],
        "snare": [round(float(s["snare"]), 1) for s in stats if s],
        "sampledBeats": len(rows),
    }


def finalize(result: dict) -> None:
    """补全 meta、速度段、量化（与 build_analysis_json.py 的逻辑保持一致）。"""
    import numpy as np

    downbeats = np.asarray(result["downbeatsSec"], dtype=float)
    beats = np.asarray(result["beatsSec"], dtype=float)
    if len(downbeats) < 3:
        result["meta"] = {"beatsPerBar": 4, "bpmMedian": 0, "beatCount": len(beats), "barCount": len(downbeats)}
        return

    raw_beat_ioi = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.0
    raw_bar_ioi = float(np.median(np.diff(downbeats)))

    # 补全局部漏检（间隔是基础间隔整数倍时插点）
    downbeats, add_d = fill_half_time_gaps(downbeats)
    beats, add_b = fill_half_time_gaps(beats)
    if add_d or add_b:
        sys.stderr.write(f"[finalize] 补全局部漏检: +{add_d} 小节, +{add_b} 拍\n")

    # 修**整体** half-time —— 和 build_analysis_json.py 同一套判定。
    #
    # 不做这一步会出现：一小节里只标了 2 拍，前端拍网格与小节网格差一倍，
    # 结构段（按小节画）和和弦（按拍画）整体错位。详见
    # `beat_scale_for_beats` 的注释。
    ratio = beats_per_bar_ratio(beats, downbeats, BEATS_PER_BAR)
    beat_scale = beat_scale_for_beats(downbeats, beats, BEATS_PER_BAR)
    if beat_scale != 1.0:
        sys.stderr.write(
            f"[finalize] 拍点判定为 half-time/double-time（一小节 {ratio:.2f} 拍）"
            f"，缩放 × {beat_scale}\n"
        )
        beats = rescale_times(beats, beat_scale)

    result["downbeatsSec"] = [round(float(t), 4) for t in downbeats]
    result["beatsSec"] = [round(float(t), 4) for t in beats]

    bar_secs = np.diff(downbeats)
    bar_bpm = BEATS_PER_BAR / bar_secs * 60
    med_bpm = float(np.median(bar_bpm))

    # 速度段（阈值 5%，吸收补全引入的抖动）
    segments = []
    i, n = 0, len(bar_bpm)
    SEG_THRESHOLD = 0.05
    while i < n:
        j = i
        vals = [bar_bpm[i]]
        while j + 1 < n:
            if abs(bar_bpm[j + 1] - vals[0]) / vals[0] >= SEG_THRESHOLD:
                break
            j += 1
            vals.append(bar_bpm[j])
        segments.append({"startBar": i, "endBar": j + 1, "bpm": round(float(np.median(vals)), 2)})
        i = j + 1

    # 合并：相邻 BPM 接近 或 单小节段
    merged = []
    for seg in segments:
        prev = merged[-1] if merged else None
        should = prev is not None and (
            (seg["endBar"] - seg["startBar"]) <= 1
            or abs(seg["bpm"] - prev["bpm"]) / prev["bpm"] < 0.04
        )
        if should:
            prev["endBar"] = seg["endBar"]
            lo, hi = prev["startBar"], prev["endBar"]
            v = [bar_bpm[k] for k in range(lo, min(hi, len(bar_bpm)))]
            if v:
                prev["bpm"] = round(float(np.median(v)), 2)
        else:
            merged.append(dict(seg))

    result["tempoSegments"] = merged
    result["meta"] = {
        "beatsPerBar": BEATS_PER_BAR,
        # BPM 以**小节间隔**为准（一小节 BEATS_PER_BAR 拍）。
        # 不要单独拿拍间隔算：拍点可能被整体记成 half-time，
        # 而前端的网格/结构段/和弦边界都以小节为基准，两边必须同一个数。
        "bpmMedian": round(med_bpm, 2),
        "bpmRawBeats": round(60 / raw_beat_ioi, 2) if raw_beat_ioi > 0 else 0,
        "bpmRawBars": round(BEATS_PER_BAR * 60 / raw_bar_ioi, 2) if raw_bar_ioi > 0 else 0,
        "beatScale": beat_scale,
        "barSecMedian": round(float(np.median(bar_secs)), 4),
        "beatSecMedian": round(float(np.median(np.diff(beats))), 4) if len(beats) > 1 else 0,
        "beatCount": int(len(beats)),
        "barCount": int(len(downbeats)),
    }


def fill_half_time_gaps(times, min_ratio: float = 0.25):
    """补全 half-time 漏检（与 build_analysis_json.py 同一算法）。"""
    import numpy as np

    if len(times) < 3:
        return np.asarray(times), 0
    ioi = np.diff(times)
    base = float(np.percentile(ioi, 15))
    if base <= 0:
        return np.asarray(times), 0

    out = [float(times[0])]
    added = 0
    for i in range(1, len(times)):
        gap = float(times[i]) - out[-1]
        n = int(round(gap / base))
        if n >= 2 and abs(gap - n * base) < base * min_ratio:
            step = gap / n
            for _ in range(1, n):
                out.append(out[-1] + step)
                added += 1
        out.append(float(times[i]))
    return np.asarray(out), added


def beats_per_bar_ratio(beats, downbeats, beats_per_bar: int = BEATS_PER_BAR) -> float:
    """「一小节实际有几拍」= 小节间隔 / 拍间隔。

    4/4 拍歌理想值是 4；≈2 说明拍点被整体记成 half-time。
    """
    import numpy as np

    if len(beats) < 4 or len(downbeats) < 4:
        return float(beats_per_bar)
    beat_ioi = float(np.median(np.diff(beats)))
    bar_ioi = float(np.median(np.diff(downbeats)))
    if beat_ioi <= 0:
        return float(beats_per_bar)
    return bar_ioi / beat_ioi


def beat_scale_for_beats(downbeats, beats, beats_per_bar: int = BEATS_PER_BAR) -> float:
    """拍点需要的缩放倍数（2.0 = half-time 要拆成两拍；0.5 = 要合并）。

    阈值 3% 的取舍见 build_analysis_json.py 里同名函数的注释：
    宁可漏修也不能把 3/4 拍强行改成 4 拍（会静默毁掉整首歌的网格）。
    """
    ratio = beats_per_bar_ratio(beats, downbeats, beats_per_bar)
    if ratio <= 0:
        return 1.0
    scale = beats_per_bar / ratio
    for candidate in (0.5, 1.0, 2.0):
        if abs(scale - candidate) <= candidate * 0.03:
            return candidate
    return 1.0


def rescale_times(times, factor: float):
    """把等距点加密/稀疏 factor 倍（首尾不动，线性插值）。"""
    import numpy as np

    times = np.asarray(times, dtype=float)
    if factor == 1.0 or len(times) < 2:
        return times
    if factor >= 2.0:
        n_sub = int(round(factor))
        out = []
        for i in range(len(times) - 1):
            a, b = times[i], times[i + 1]
            for k in range(n_sub):
                out.append(a + (b - a) * k / n_sub)
        out.append(times[-1])
        return np.asarray(out, dtype=float)
    step = int(round(1.0 / factor))
    out = list(times[::step])
    if out[-1] != times[-1]:
        out.append(times[-1])
    return np.asarray(out, dtype=float)


def main() -> None:
    if len(sys.argv) < 2:
        emit({"type": "error", "message": "缺少音频路径参数"})
        return
    audio_path = Path(sys.argv[1])
    if not audio_path.is_file():
        emit({"type": "error", "message": f"文件不存在: {audio_path}"})
        return

    try:
        result = analyze(audio_path)
        emit({"type": "result", "json": json.dumps(result, ensure_ascii=False)})
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()
        sys.stderr.write(tb + "\n")
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
