/**
 * 真实分析数据 —— 来自模型实际推理结果。
 *
 * 数据来源（见 neural/build_analysis_json.py）：
 *   beats/downbeats  beat_this final0
 *   chords           lv-chordia s0–s4 ensemble（三档）
 *
 * ## 为什么用真实拍点构造 TempoMap
 *
 * 单锚点恒速 BPM 会和真实音频错开：这首歌第一拍在 0.36s（前奏），
 * 而恒速映射下 tick 0 = 0s，网格线会比真实拍点早 0.36s。
 *
 * 所以**每个小节起点都作为一个锚点**：
 *   tick = i × 3840（4/4）
 *   sec  = downbeats[i]（模型检出的小节起点）
 *
 * 这样网格线与真实拍点严格重合，变速/误拍区域也自动吸收。
 */

import type { TempoMapData } from '../domain/TempoMap';
import { createTempoMap } from '../domain/TempoMap';
import type { MeterMapData } from '../domain/MeterMap';
import { createMeterMap } from '../domain/MeterMap';
import { PPQ } from '../domain/Tick';
import { STRUCTURE_SEGMENTS, STRUCTURE_COVERED_BARS, type StructureSegment } from './structure';
import type { TrackKind } from '../design/tokens';

/** analysis.json 的结构 */
export interface AnalysisFile {
  song: { title: string; artist: string; durationSec: number };
  source: { beats: string; chords: string; note: string };
  downbeatsSec: number[];
  beatsSec: number[];
  chords: Record<string, ChordSegment[]>;
  /**
   * 结构分段。
   *
   * ⚠️ 有**两种格式**，必须都支持：
   *   - `{ label, startBar, endBar }`  ← build_analysis_json.py 的输出（已转小节）
   *   - `{ label, start, end }`        ← analyze_song.py 的原始输出（**秒**）
   *
   * 踩过的坑：只处理了第一种，把第二种的 `startBar` 当 undefined 用，
   * `undefined * 3840 = NaN` → 前端 `assertTick` 抛「必须是整数，收到 NaN」→ 整页白屏。
   */
  sections?: Array<
    | { label: string; startBar: number; endBar: number }
    | { label: string; start: number; end: number }
  >;
  /** 速度段（压缩后的 BPM 变化，供速度轨显示与编辑） */
  tempoSegments?: TempoSegment[];
  meta: {
    beatsPerBar: number;
    bpmMedian: number;
    barSecMedian: number;
    beatCount: number;
    barCount: number;
  };
  /**
   * 调音校正信息（分析前自动检测）。
   *
   * 这首歌实测整体偏低 34.7 音分，分析前已被 pitch_shift 校正到 A=440。
   * 用户必须知道这件事——否则他会困惑「软件说 A 调，我弹 Ab 才对」。
   */
  tuning?: {
    /** 实测偏差（音分，负 = 偏低） */
    deviationCents: number;
    /** 是否做了校正 */
    corrected: boolean;
    /** 三种检测方法的结果 */
    methods?: { librosa: number; cqtPeaks: number; harmonicPeaks: number };
    /** 分段极差（大 = 可能有转调） */
    segmentSpread?: number;
    /** 跳过校正的原因 */
    reason?: string;
  };
}

/** 速度段：从 startBar 到 endBar（不含），以 bpm 前进 */
export interface TempoSegment {
  startBar: number;
  endBar: number;
  bpm: number;
}

/**
 * 一个备选和弦。
 *
 * `source` 缺省 = 来自 lv-chordia 自己的概率分布；`'madmom'` = 由第二个
 * 独立引擎（madmom，DeepChroma + CRF）交叉验证补进来的。
 *
 * ## 为什么需要区分来源
 *
 * madmom 只能输出 maj/min，没有七和弦/挂留/转位。它给出的候选是
 * **粒度更粗的另一种解释**，不是"更准的答案"。前端据此显示
 * 「另一引擎认为是 F#:min」，让用户知道这是不同层面的判断。
 *
 * 另外 madmom 有个已知倾向：把调内的一切都听成主和弦。后端已过滤掉
 * 这类"调性泛化"候选（见 `_tonic_chord`），所以能留下的都是真实分歧。
 */
export interface ChordAlternative {
  chord: string;
  prob: number;
  source?: 'madmom';
}

export interface ChordSegment {
  start: number;
  end: number;
  chord: string;
  /**
   * 被选中和弦的**平均概率**（0~1）。
   *
   * 来自 `analyze_song.py` 的 `_segment_alternatives`：把该段覆盖的所有帧
   * 概率平均后归一化。低置信度是很有用的信号 —— 实测《満ちてゆく》
   * 正常段落 0.3~0.6，而模型犹豫的地方只有 0.1 左右。
   */
  confidence?: number;
  /**
   * 备选和弦（按概率降序，最多 4 个，含被选中的那个）。
   *
   * 模型输出的是**逐帧概率分布**（301 类 × 1.3 万帧），后端按段聚合后
   * 只传 top-k，所以每段只多出几十字节。
   */
  alternatives?: Array<ChordAlternative>;
}

export interface RealClip {
  id: string;
  startTick: number;
  endTick: number;
  label: string;
  sublabel?: string;
  state?: 'draft' | 'confirmed' | 'rejected';
  confidence?: number;
  parentId?: string;
  /** 备选和弦（来自模型的概率分布，最多 5 个，含当前选中的） */
  alternatives?: Array<ChordAlternative>;
  /**
   * **结构段**这段的调性（可选）。
   *
   * 只对 `kind === 'section'` 的轨道有意义，其他轨道忽略。
   *
   * ## 它不参与任何计算，只做「提示」
   *
   * 用户标注「这段转调了，是 G 大调」之后，级数轨上**这一段范围内的块**
   * 如果调性对得上就高亮、对不上就变淡 —— 传达的是
   * 「这段得按 G 大调那条轨来理解」。
   *
   * 级数的数字本身**仍然按轨道自己的调性算**（用户明确要求模式 A），
   * 因为自动改调性会让级数块在段边界突然跳变，用户反而看不懂。
   */
  key?: { tonic: string; mode: 'major' | 'minor' };
}

export interface RealTrack {
  id: string;
  kind: TrackKind;
  name: string;
  layer?: string;
  visible: boolean;
  /**
   * 级数轨**自己的**主音（如 `G` / `D`）。
   *
   * ## 为什么必须存在轨道上，而不是用全局 keyTonic
   *
   * 用户可以加多条级数轨、每条指定不同调性（比如用「G 大调」对照
   * 「D 小调」看同一段和声的两种读法）。如果渲染时统一读全局
   * keyTonic，所有级数轨都会算出同一套级数 —— 用户报的
   * 「级数轨根本没单独计算，换全曲主调时自定义轨跟着变」。
   *
   * 全局 keyTonic 只用于「自动推断」那条轨和轨道头徽章，
   * 每条轨的级数换算一律以这里的值为准。
   */
  degreeTonic?: string;
  /** 级数轨自己的调式，与 `degreeTonic` 成对使用。 */
  degreeMode?: 'major' | 'minor';
  clips: RealClip[];
}

const TICKS_PER_BAR = 4 * PPQ;

/**
 * 长于这个长度（小节）的 `N` 段视为「模型没识别出来」，而不是「真的没有和弦」。
 *
 * ## 为什么需要这个区分
 *
 * `N` 在音乐语义上是「无可识别和弦」。实测《満ちてゆく》里 5 个 `N`：
 *
 *   0.00~0.51s   (0.5s)  ← 起音前，合理
 *   31.00~38.68s (7.7s)  ← 可疑
 *   215.46~233.94s (18.5s) ← 可疑
 *   238.68~240.37s (1.7s) ← 合理（短促停顿）
 *   295.85~315.40s (19.6s) ← 淡出尾巴，合理
 *
 * 后两个长的都跨越了段落边界（intro→verse、bridge→verse 的交界后），
 * 而且**音频 RMS 与前后段落一致**（不是静音），三个词典档位也一致判 N ——
 * 说明是模型在和弦识别上失效了，不是真的「这里没有和弦」。
 *
 * 混着显示会让用户以为「这首歌这段就是无和弦」（错误信息），
 * 所以超过 2 小节的 `N` 单独标成「未识别」：
 *   - 不猜内容（不假装知道和弦是什么）
 *   - 也不假装是模型判断正确
 *   - 一眼能看出「这里需要人工补」
 */
const UNRECOGNIZED_MIN_BARS = 2;

/** 未识别段的显示标签（不用 `N`，避免和真实的「无和弦」混淆） */
export const UNRECOGNIZED_LABEL = '未识别';


/** 导入量化的最小单位：八分音符（480 tick） */
const IMPORT_QUANTUM = PPQ / 2;

/**
 * 把秒 → tick 并**量化到八分音符**。
 *
 * 为什么是八分音符而不是整拍：
 *   有些歌的和弦会「抢拍」（切分），变化点落在半拍位置。
 *   量化到整拍会把这些真实的和声变化抹掉。
 *
 * 实测 Refrain 的和弦边界有落在 X.5 拍位置的，说明模型确实检出了切分。
 */
function toTickQuantized(sec: number, toTick: (s: number) => number): number {
  const raw = toTick(sec);
  return Math.round(raw / IMPORT_QUANTUM) * IMPORT_QUANTUM;
}

/**
 * 由真实 downbeat 构造 TempoMap。
 *
 * 每个小节一个锚点，保证网格与音频严格同步。
 */
/**
 * 由**速度段**构造 TempoMap。
 *
 * 与旧版的区别：旧版是「每个真实 downbeat 一个锚点」，能精确贴合音频，
 * 但会把 43fps 帧栅格的抖动（±0.7%）也当成速度变化 —— 速度轨上就是 90 多个碎值。
 *
 * 新版按「速度段」排：段内 BPM 恒定（抖动被均摊），段间按各段 BPM 变速。
 * 代价是与真实 downbeat 有微小偏差（均摊误差），换来的是：
 *   - 速度轨干净可编辑
 *   - **支持真实变速**（不同段不同 BPM）
 */
export function makeTempoMapFromSegments(
  a: AnalysisFile,
  segments: TempoSegment[],
): TempoMapData {
  const startSec = a.downbeatsSec[0] ?? 0;
  const bar = 4 * PPQ;
  const anchors: { tick: number; bpm: number }[] = [];

  /**
   * ⚠️ 必须过滤掉**非法段**，不能让它们进锚点。
   *
   * `anchors.length === 0` 的兜底只在「一个锚点都没有」时生效，
   * 但如果段存在、`bpm` 却是 `undefined`（比如切换曲目瞬间
   * `tempoSegments` 被清成 `[]` 后又被赋了一个半成品），
   * 锚点会被 push 进去但 bpm 无效 —— 兜底不触发，
   * `createTempoMap` 直接抛 `RangeError: anchors[0].bpm 必须为正有限数`，
   * 整个页面白屏。
   *
   * 所以按**有效性**过滤，而不是按「数组是否为空」判断。
   */
  for (const seg of segments) {
    const bpm = seg?.bpm;
    if (!Number.isFinite(bpm) || bpm <= 0) continue;
    const startBar = Math.max(0, Math.floor(seg.startBar ?? 0));
    const endBar = Math.max(startBar, Math.floor(seg.endBar ?? startBar));
    for (let barIdx = startBar; barIdx < endBar; barIdx++) {
      anchors.push({ tick: barIdx * bar, bpm });
    }
  }

  /**
   * 兜底：没有段时用中位 BPM。
   *
   * ⚠️ 空谱面（歌还没分析完）时 `bpmMedian` 是 0，
   * 而 `createTempoMap` 会因为「durationSec 必须为正有限数」抛 RangeError，
   * 把整个页面打白。所以空态必须自己给一个安全的占位：
   * BPM 用 120（不与任何真实值冲突，UI 会显示「—」）、时长至少 1 秒。
   */
  if (anchors.length === 0) {
    anchors.push({ tick: 0, bpm: a.meta.bpmMedian > 0 ? a.meta.bpmMedian : 120 });
  }
  // 末尾补一个，让最后一小节之后能外推
  const last = anchors[anchors.length - 1];
  anchors.push({ tick: last.tick + bar, bpm: last.bpm });

  const durationSec = a.song.durationSec > 0 ? a.song.durationSec : 1;

  return createTempoMap(anchors, durationSec, startSec);
}

/** 旧版：逐 downbeat 锚点（保留给"需要精确贴合音频"的场景） */
export function makeRealTempoMap(a: AnalysisFile): TempoMapData {
  /**
   * TempoMap 的权威是 `{tick, bpm}`，不是 `{tick, sec}`。
   *
   * 这里把每个小节的**实际时长**换算成该小节的 BPM：
   *   bpm = 4 拍 / barSec × 60
   * 这样网格锚定在真实 downbeat 位置上，同时保持 BPM 语义。
   *
   * 逐小节换算而不是用全局中位 BPM，是为了吸收模型的局部误差
   * （实测小节间隔 3.08–3.16s 有 ±2.6% 的抖动）。
   */
  const d = a.downbeatsSec;
  const anchors: { tick: number; bpm: number }[] = [];

  for (let i = 0; i < d.length - 1; i++) {
    const barSec = d[i + 1] - d[i];
    const bpm = barSec > 0 ? (4 / barSec) * 60 : a.meta.bpmMedian;
    anchors.push({ tick: i * TICKS_PER_BAR, bpm });
  }
  // 最后一小节用中位值
  anchors.push({ tick: (d.length - 1) * TICKS_PER_BAR, bpm: a.meta.bpmMedian });
  // 末尾再补一个，让最后一小节之后能外推
  anchors.push({ tick: d.length * TICKS_PER_BAR, bpm: a.meta.bpmMedian });

  /**
   * ⚠️ 关键：tick 0 必须对应**第一个 downbeat 的秒数**，而不是 0。
   *
   * 这首歌第一个小节在 0.36s（前奏），如果让 tick 0 = 0s，
   * 整条时间轴会整体提前 0.36s（约半拍），
   * 表现就是"和弦开始位置飘了"、播放头和音频对不上。
   */
  const startSec = d[0] ?? 0;

  return createTempoMap(anchors, a.song.durationSec, startSec);
}


/**
 * 修正倍速/半速检出的异常小节边界。
 *
 * ## 症状（用户报的「强拍和小节线偏移」）
 *
 * beat_this 在歌曲**开头/结尾**会倍速或半速地检出拍点。实测《何なんw》：
 *
 *   beat[0] 2.760  gap=0.340  <-DOWNBEAT
 *   beat[1] 3.100  gap=0.340
 *   ...            gap 全是 0.340（正常 0.665，正好一半）
 *   beat[4] 4.120  gap=0.835  <-DOWNBEAT   ← 突然跳到 0.835
 *
 * 于是 downbeat[0]=2.760 到 downbeat[1]=4.120 只差 1.36s（约 2 拍），
 * 而一首歌正常一小节是 2.66s。按「4 拍均分」重建时第 2 小节被压成
 * 1.36s，后面所有小节线全部前移。
 *
 * ## 为什么不丢弃异常小节
 *
 * 丢弃会让小节数凭空变少，拍号和「第 N 小节」对不上（用户按小节号找位置，
 * 少一个就全错）。这里**只挪位置、不改数量**。
 *
 * ## 阈值 0.55 / 1.8
 *
 * 倍速/半速正好是 0.5x / 2x，取 0.55 / 1.8 留出容差。
 * 实测这种歌的正常小节波动在 0.77x~1.02x（第 2 小节 2.04s vs 中位 2.66s
 * 是真实的引子变化），不会被误伤。
 */
export function fixDownbeats(downbeatsSec: readonly number[]): number[] {
  const d = [...downbeatsSec];
  if (d.length < 3) return d;

  const spans: number[] = [];
  for (let i = 1; i < d.length; i++) spans.push(d[i] - d[i - 1]);
  const sorted = [...spans].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  if (!(med > 0)) return d;

  const out: number[] = [d[0]];
  for (let i = 1; i < d.length; i++) {
    let span = d[i] - out[out.length - 1];
    const ratio = span / med;
    if (ratio < 0.55 || ratio > 1.8) {
      // 按中位时长的整数倍推进（倍速/半速正好 0.5x / 2x）
      span = med * Math.max(1, Math.round(ratio));
    }
    out.push(out[out.length - 1] + span);
  }
  return out;
}

/**
 * **把开头没被网格覆盖的那段补成一个小节。**
 *
 * ## 问题
 *
 * 模型的第一个 downbeat 往往是「音乐真正进入」的位置。《何なんw》是 2.76s，
 * 而音频 0.28s 起就有前奏音乐了。于是 tick 0 = 第 2.76 秒：
 *
 *   - 谱面第一次出现小节线在 2.76s，前面 2.76s 是**完全空白**
 *   - 播放 0~2.76s 时播放头只能卡在最左端不动
 *   - 用户看到的像是「第一拍跑到第二拍去了」
 *
 * ## 做法
 *
 * 在第一个 downbeat 前面补一个虚拟小节起点（`d[0] - 中位小节时长`，
 * 不足 0 就取 0），让前奏也被网格覆盖。
 *
 * 补出来的那一小节内部拍点是**均分**的，只是为了让谱面连续、播放头能动；
 * 前奏如果是散板，这些拍点本来也不代表真实节拍。
 *
 * ## 幂等性（重要）
 *
 * 只在 `d[0]` 离 0 超过半个小节时才补。补完之后 `d[0]` 已经接近 0。
 * 所以后端已经补过的数据再走一遍这里**不会补第二次**。
 */
export function padLeadingBar(downbeatsSec: readonly number[]): number[] {
  const d = [...downbeatsSec];
  if (d.length < 3 || !(d[0] > 0)) return d;

  const spans: number[] = [];
  for (let i = 1; i < d.length; i++) spans.push(d[i] - d[i - 1]);
  const sorted = [...spans].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  if (!(med > 0)) return d;

  // 第一个 downbeat 已经贴近 0（或只差半个小节以内）→ 有网格覆盖，不补
  if (d[0] < med * 0.5) return d;

  const pad = Math.max(0, d[0] - med);
  return [pad, ...d];
}
/** 4/4 拍号（真实数据里 96.8% 的小节是 4 拍） */
export function makeRealMeterMap(): MeterMapData {
  return createMeterMap([{ startTick: 0, numerator: 4, denominator: 4 }]);
}

/** 内容总 tick（小节数 × 3840） */
export function totalTicksOf(a: AnalysisFile): number {
  return a.downbeatsSec.length * TICKS_PER_BAR;
}

/**
 * 从和弦名推断调性（用于生成级数解释）。
 *
 * ⚠️ 这是**启发式**，不是模型输出。真实调性需要 all-in-one-infer 或人工标注。
 * UI 上必须标明"自动推断"。
 *
 * 做法：统计各调的大三和弦出现时长，取最长者为主调。
 */
export function inferKey(a: AnalysisFile, dict = 'submission'): { tonic: string; mode: string } {
  const segs = a.chords[dict] ?? [];

  /**
   * 空谱面（歌还没分析完）→ 返回空调性。
   *
   * 不能走到下面的打分：`segs` 为空时每个候选调都是 0 分，
   * `bestScore` 停在 -1，`bestTonic` 保持初始值 `C` ——
   * 于是顶栏会显示「C major」，看起来像真的分析出了一个调。
   * 返回空串让 UI 显示「—」，语义才正确。
   */
  if (segs.length === 0) return { tonic: '', mode: '' };

  /**
   * 评分法：对每个候选主音，统计「该调内的主要和弦占比」。
   *
   * 之前用「大三和弦总时长最多的根音」是错的：
   * 实测 Refrain 的进行是 G:maj → D:maj/3 → E:min7 → C:maj/5 → D:maj → G:maj，
   * 明显是 G 大调的 I–V–vi–IV，但 D:maj 出现次数多，把 D 推上了第一。
   *
   * 现在按「调内功能」打分：I / IV / V 权重高，vi / ii / iii 权重次之，
   * 调外和弦不给分。这样 G 大调会同时收到 G(I)、C(IV)、D(V)、E:min(vi) 四份分。
   */
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const MAJOR = [0, 2, 4, 5, 7, 9, 11]; // 大调音阶
  /**
   * 各音级的功能权重。
   *
   * I 必须显著高于其他（实测教训）：
   *   藤井風《満ちてゆく》的和弦是 Ab / C# / Eb / Bb:min，明显是 **Ab 大调**
   *   （Ab=I, C#=IV, Eb=V, Bb:min=ii）。但因为 E:maj 也频繁出现，
   *   在 Ab 大调里 E 是调外音，在 A 大调里却是 V（权重 2.0），
   *   结果 A 大调靠"E=V"刷分反超了。
   *
   *   把 I 提到 5.0 后，Ab=maj（大量出现）的得分压过 A 大调的 V，
   *   符合"主和弦最能标识调性"的音乐常识。
   */
  const DEGREE_WEIGHT = new Map<number, number>([
    [0, 5.0], // I  ← 主和弦权重最高
    [7, 2.0], // V
    [5, 2.0], // IV
    [9, 1.2], // vi
    [2, 1.0], // ii
    [4, 0.8], // iii
  ]);

  let bestTonic = 'C';
  let bestScore = -1;

  for (const tonic of NAMES) {
    /**
     * ⚠️ 必须用 `PITCH[tonic]` 取音高，**不能**用 `NAMES.indexOf(tonic)`。
     *
     * 踩过的坑：`NAMES` 只有升号写法，`NAMES.indexOf('Ab')` 返回 **-1**。
     * 于是所有降号和弦（Ab / Bb / Eb）在 `if (r < 0) continue` 处被静默跳过，
     * 完全不参与打分。这首歌的和弦大多是降号，结果主调 Ab 一分没拿到，
     * 靠 E:maj / A:maj 得分的 A 大调反超。
     *
     * 这个 bug 很隐蔽：不报错、结果看起来"也挺合理"，只是调性错了一个音。
     */
    const t = PITCH[tonic];
    let score = 0;

    for (const s of segs) {
      const root = s.chord.split(':')[0]?.split('/')[0];
      if (!root || root === 'N') continue;
      const r = PITCH[root]; // ← 必须用音高表，不能用 NAMES.indexOf
      if (r == null) continue;

      const interval = (r - t + 12) % 12;
      const ditonic = MAJOR.indexOf(interval);
      if (ditonic < 0) continue; // 调外和弦不计分

      // 大三和弦权重更高（副属/借用和弦的干扰更小）
      const isMajor = !/:min|:m/.test(s.chord);
      const w = DEGREE_WEIGHT.get(interval) ?? 0.3;
      score += (s.end - s.start) * w * (isMajor ? 1 : 0.85);
    }

    /**
     * 该调的主和弦完全没出现过 → 基本不可能是这个调。
     *
     * ⚠️ 必须**按音高比较**，不能按字符串！
     * 踩过的坑：候选表是升号（C# D# F# G# A#），而和弦用的是降号（Ab Bb Eb）。
     * 用 `root === tonic` 比较时，G# 永远匹配不到数据里的 Ab：
     *   - 藤井風《満ちてゆく》真实调性是 **Ab 大调**，候选列表里对应的是 **G#**
     *   - 但和弦全写成 `Ab:maj`，`'Ab' === 'G#'` 为 false
     *   - 于是 G# 被当作"没有主和弦"排除，最后误判成 A 大调
     */
    const tonicPitch = PITCH[tonic];
    let hasTonicChord = false;
    for (const seg of segs) {
      const root = seg.chord.split(':')[0]?.split('/')[0];
      if (root && PITCH[root] === tonicPitch) {
        hasTonicChord = true;
        break;
      }
    }
    if (!hasTonicChord) continue;

    if (score > bestScore) {
      bestScore = score;
      bestTonic = tonic;
    }
  }

  /**
   * 输出时用**数据里实际出现的写法**（降号优先）。
   *
   * 候选表只有升号，但流行乐谱习惯写 Ab 而不是 G#。
   * 如果和弦里出现过同音高的降号写法，就沿用它。
   */
  const bestPitch = PITCH[bestTonic];
  const written = segs
    .map((s) => s.chord.split(':')[0]?.split('/')[0])
    .find((root) => root && PITCH[root] === bestPitch || root && PITCH[root] === bestPitch);
  // 优先选降号写法（长度 2 且第二个字符是 b）
  const flatForm = FLAT_NAMES[bestPitch];
  const displayTonic = flatForm ?? written ?? bestTonic;

  return { tonic: displayTonic, mode: 'major' };
}

/** 音名 → 半音数（相对 C） */
const PITCH: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

/** 音高 → 降号写法（流行乐谱更常用降号：Ab 而非 G#） */
const FLAT_NAMES: Record<number, string> = {
  1: 'Db', 3: 'Eb', 6: 'Gb', 8: 'Ab', 10: 'Bb',
};

/** 和弦性质里"第几音"对应的半音数（用于把 /3 /5 /7 换算成实际音高） */
const CHORD_DEGREE_SEMITONES: Record<string, number> = {
  '2': 2, b3: 3, '3': 4, '4': 5, '5': 7, b7: 10, '7': 11,
  b9: 13, '9': 14, '11': 17, '13': 21,
};

/**
 * 音名 → 相对主音的**阿拉伯数字级数**（1–7，带 b/# 变音）。
 *
 * 例如 G 大调下：G→1, A→2, B→3, C→4, D→5, E→6, F#→7, F→b7。
 */
function noteToNumber(note: string, tonic: string): string | null {
  const r = PITCH[note];
  const t = PITCH[tonic];
  if (r == null || t == null) return null;

  const interval = (r - t + 12) % 12;
  const idx = MAJOR_SCALE.indexOf(interval);
  if (idx >= 0) return String(idx + 1);

  /**
   * 不在大调音阶内（变化音）。
   *
   * ⚠️ 方向必须算对：
   *   - **降号 bn**：interval 比第 n 级**低**半音
   *       即 (MAJOR_SCALE[n-1] - interval + 12) % 12 === 1
   *   - **升号 #n**：interval 比第 n 级**高**半音
   *       即 (interval - MAJOR_SCALE[n-1] + 12) % 12 === 1
   *
   * 之前写反了：把"高半音"判成降号，结果 A 大调下 Bb（interval=1）
   * 算成 `b1`（降一度 = 原音，无意义），正确的是 `b2`。
   *
   * 惯例优先降号（b2 比 #1 更常见于功能和声分析）。
   */
  // 先找降号：比某个音级低半音
  for (let i = 0; i < MAJOR_SCALE.length; i++) {
    if ((MAJOR_SCALE[i] - interval + 12) % 12 === 1) return `b${i + 1}`;
  }
  // 再找升号：比某个音级高半音
  for (let i = MAJOR_SCALE.length - 1; i >= 0; i--) {
    if ((interval - MAJOR_SCALE[i] + 12) % 12 === 1) return `#${i + 1}`;
  }
  return null;
}

/**
 * 和弦 → **数字级数**（用户要求：用阿拉伯数字替换音名，且不简化信息）。
 *
 * 记法规则：
 *   `G:maj`      → `1:maj`
 *   `E:min7`     → `6:min7`
 *   `D:maj/3`    → `5:maj/7`   （3 音在低音 → 低音是 7 级音）
 *   `C:maj/5`    → `4:maj/1`
 *   `N`          → `N`（无和弦，保留原样）
 *
 * **不简化**：`:maj` / `:min7` / `:7` / `:sus4` 等性质全部保留，
 * 因为 `6:min7` 和 `6` 在功能和声上是两回事。
 */
export function chordToNumber(chord: string, tonic: string): string | null {
  if (!chord) return null;
  if (chord === 'N') return 'N';

  /**
   * 解析和弦记号。注意 `/转位` 可能出现在**冒号前后两个位置**：
   *   `D:maj/3`  → root=D, quality=maj, inversion=3
   *   `D/3:maj`  → 少见但也要支持
   *   `C:maj/5`  → root=C, quality=maj, inversion=5
   */
  const [rootPartRaw, qualityRaw] = chord.split(':');

  // 先看 root 侧有没有 /N
  const [rootOnly, rootInv] = rootPartRaw.split('/');

  // 再看 quality 侧有没有 /N
  let quality = qualityRaw ?? '';
  let inversion: string | undefined = rootInv;
  const slash = quality.indexOf('/');
  if (slash >= 0) {
    inversion = quality.slice(slash + 1);
    quality = quality.slice(0, slash);
  }

  const root = rootOnly;
  const rootNum = noteToNumber(root, tonic);
  if (!rootNum) return null;

  let out = rootNum;
  // 性质原样保留（用户要求不简化）
  if (quality) out += `:${quality}`;

  // 转位：把 /3 /5 /7 换算成「低音的实际级数」
  if (inversion) {
    const semis = CHORD_DEGREE_SEMITONES[inversion];
    const rootPitch = PITCH[root];
    if (semis != null && rootPitch != null) {
      const bassPitch = (rootPitch + semis) % 12;
      const bassNote = Object.keys(PITCH).find((k) => PITCH[k] === bassPitch);
      const bassNum = bassNote ? noteToNumber(bassNote, tonic) : null;
      out += `/${bassNum ?? inversion}`;
    } else {
      // 不认识的转位记号（如 /1），原样保留
      out += `/${inversion}`;
    }
  }

  return out;
}

/** 兼容旧名（罗马数字版已弃用，保留导出避免破坏引用） */
export const chordToDegree = chordToNumber;

/**
 * 用**真实拍点**把秒映射成 tick（这是「先对 BPM，再对和声在哪一拍」的落实）。
 *
 * ## 为什么不能直接用 TempoMap 转
 *
 * TempoMap 是由 **BPM 段**派生的。而 BPM 是估计值（从拍点算出来的平均值），
 * 用它做秒→tick 会引入累积误差：一首歌 153 小节，BPM 差 0.5% 就能漂掉半拍。
 *
 * ## 正确做法
 *
 * 拍点是**实测**的（beat_this 检出的每一拍时间），所以：
 *   1. 先建立「拍点秒数 → 拍序号」的映射
 *   2. 和弦的秒 → 找最近拍点 → tick = 拍序号 × 960
 *
 * 这样和弦的**拍位置精确落在真实拍上**，与 BPM 估计无关。
 *
 * 之后用户改 BPM 时：
 *   - 和弦的 tick **不变**（位置不动）
 *   - 只有 tick→秒 的映射变（播放走时速度变）
 *   - 于是"和声对不上"是**预期行为**（用户主动改了速度假设）
 */
export function makeBeatSnapper(
  beatsSec: readonly number[],
  downbeatsSec?: readonly number[],
): (sec: number) => number {
  let beats = [...beatsSec];
  const PPQ_LOCAL = PPQ;

  /**
   * ## 自愈：beatsSec 必须满足「每 4 拍 = 1 小节」
   *
   * 这个函数**用 beatsSec 的下标当拍号**（第 i 个拍点 = tick i×960），
   * 而小节线是拿 `downbeatsSec` 画的。两者必须是同一个网格。
   *
   * 一旦 beatsSec 比「小节数 × 4」多出元素（beat_this 在小节交界
   * 会多检出拍点，实测 88 处 0.2s 假拍 vs 真实 0.42s），下标就和小节线
   * 错位，**且误差随歌曲推进累积** —— 表现为和弦块起点还行、
   * 右边界越过小节线越来越多（实测 185 小节里 183 个对不齐，最大偏 44 拍）。
   *
   * 后端已在 `_rebuild_beats_from_downbeats` 从源头修掉。这里再兜一层，
   * 因为 analysis.json 是磁盘上的历史产物，旧文件不会自动重算 ——
   * 用户打开老歌不该看到飘走的和弦。
   *
   * ## 为什么用 downbeats 重建而不是"删假拍"
   *
   * 删假拍要判断哪个是假的，而 0.20s 和 0.42s 的界限在变速歌里不牢靠。
   * downbeats 的数量可靠（小节数是确定的），拿它当骨架就不需要判断
   * 真假，而且均分**永远不会让后续小节漂移**。
   */
  if (downbeatsSec && downbeatsSec.length > 1 && beats.length > 1) {
    const want = downbeatsSec.length * 4;
    // 差 1 个算正常抖动（首尾边界），差得多就是网格错位
    if (Math.abs(beats.length - want) > 1) {
      const d = downbeatsSec;
      const rebuilt: number[] = [];
      for (let i = 0; i < d.length - 1; i++) {
        const step = (d[i + 1] - d[i]) / 4;
        for (let k = 0; k < 4; k++) rebuilt.push(d[i] + k * step);
      }
      // 末尾：用最后一小节的速度补齐剩余时间
      const lastSpan = d[d.length - 1] - d[d.length - 2];
      const step = lastSpan / 4;
      const tailEnd = Math.max(beats[beats.length - 1], d[d.length - 1] + lastSpan);
      const nTail = Math.max(4, Math.round((tailEnd - d[d.length - 1]) / step));
      for (let k = 0; k <= nTail; k++) rebuilt.push(d[d.length - 1] + k * step);
      beats = rebuilt;
    }
  }

  return (sec: number): number => {
    if (beats.length === 0) return Math.round(sec * 1000) * PPQ_LOCAL;

    // 二分：找第一个 >= sec 的拍
    let lo = 0;
    let hi = beats.length - 1;
    if (sec <= beats[0]) return 0;
    if (sec >= beats[hi]) {
      // 超出末尾：按最后一拍的速度外推
      const lastGap = beats.length > 1 ? beats[hi] - beats[hi - 1] : 0.5;
      const extra = Math.round((sec - beats[hi]) / lastGap);
      return (hi + extra) * PPQ_LOCAL;
    }
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] < sec) lo = mid + 1;
      else hi = mid;
    }
    // 比较 lo 和 lo-1 哪个更近
    const prev = lo - 1;
    const dPrev = Math.abs(sec - beats[prev]);
    const dCur = Math.abs(beats[lo] - sec);
    const nearest = dPrev <= dCur ? prev : lo;
    return nearest * PPQ_LOCAL;
  };
}

/** 安全地把秒转成小节号（用 downbeats 找最近边界） */
function secToBar(downbeatsSec: readonly number[], sec: number): number {
  const n = downbeatsSec.length;
  if (n === 0) return 0;
  if (!Number.isFinite(sec)) return 0;
  if (sec <= downbeatsSec[0]) return 0;
  if (sec >= downbeatsSec[n - 1]) return n - 1;

  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (downbeatsSec[mid] < sec) lo = mid + 1;
    else hi = mid;
  }
  const prev = Math.max(0, lo - 1);
  return Math.abs(sec - downbeatsSec[prev]) <= Math.abs(downbeatsSec[lo] - sec) ? prev : lo;
}

/** 段落标签规范化（all-in-one 用小写；start/end 是分析标记而非段落，返回 null 丢弃） */
function normalizeSectionLabel(raw: string): string | null {
  const l = raw.toLowerCase();
  if (l === 'start' || l === 'end') return null;
  const map: Record<string, string> = {
    intro: 'Intro',
    verse: 'Verse',
    chorus: 'Chorus',
    bridge: 'Bridge',
    outro: 'Outro',
    inst: 'Inst',
    solo: 'Solo',
  };
  return map[l] ?? raw;
}

/**
 * 把 analysis 里的 sections 统一成 `{label, startBar, endBar}`。
 *
 * 收口三件事：**排序、去重叠、合并相邻同标签**。
 * 结构段不能叠（用户明确要求），而模型输出既不保证有序也不保证不交叠，
 * 所以必须在这里修掉，不能指望下游各画各的。
 *
 * **必须防御 NaN**：任何非有限值都归 0，否则会一路传到 `assertTick` 导致白屏。
 */
export function normalizeSections(a: AnalysisFile): StructureSegment[] {
  const raw = a.sections ?? [];
  if (raw.length === 0) return [];

  /** 先转成 bar 区间（秒/小节两种格式都认） */
  const barRanges: { label: string; startBar: number; endBar: number }[] = [];
  for (const s of raw) {
    // 两种格式都认
    const startSec = 'start' in s ? s.start : null;
    const endSec = 'end' in s ? s.end : null;
    const startBar =
      'startBar' in s && Number.isFinite(s.startBar)
        ? s.startBar
        : startSec != null
          ? secToBar(a.downbeatsSec, startSec)
          : 0;
    const endBar =
      'endBar' in s && Number.isFinite(s.endBar)
        ? s.endBar
        : endSec != null
          ? secToBar(a.downbeatsSec, endSec)
          : startBar + 1;

    const label = normalizeSectionLabel(s.label);
    if (label == null) continue;

    const safeStart = Math.max(0, Math.min(startBar, a.downbeatsSec.length));
    const safeEnd = Math.max(safeStart + 1, Math.min(endBar, a.downbeatsSec.length));

    barRanges.push({ label, startBar: safeStart, endBar: safeEnd });
  }

  /**
   * ## 排序 + 去重叠 + 合并相邻同标签
   *
   * 结构段**不能叠**（用户明确要求）。模型输出不保证有序，
   * 也不保证不交叠，所以这里统一收口：
   *
   *   1. 按起点排序
   *   2. 起点早于上一段末尾 → 推到上一段末尾（之后的部分仍保留）
   *   3. 被完全吃掉的段丢弃
   *   4. 相邻且同名 → 合并（避免 `Verse` 被切碎成一堆同名段）
   */
  barRanges.sort((x, y) => x.startBar - y.startBar || x.endBar - y.endBar);

  const items: StructureSegment[] = [];
  for (const r of barRanges) {
    const prev = items[items.length - 1];
    let s = r.startBar;
    if (prev && s < prev.endBar) s = prev.endBar;
    if (r.endBar <= s) continue; // 被前一段完全吃掉
    if (prev && prev.label === r.label && prev.endBar === s) {
      prev.endBar = r.endBar;
    } else {
      items.push({ label: r.label, startBar: s, endBar: r.endBar, source: 'model' });
    }
  }
  return items;
}

/**
 * 生成轨道。
 *
 * 只含有真实数据的轨：
 *   - 绝对和弦（lv-chordia submission）
 *   - 级数解释（从和弦 + 推断调性派生，标注"自动推断"）
 *
 * **不生成段落 / 调性 / 歌词轨** —— 这三项没有真实分析结果，
 * 用假数据会误导（用户反馈"和歌本身对不上"）。
/**
 * 按指定调性生成一条级数解释轨。
 *
 * ## 为什么需要「多条级数轨」
 *
 * 一条级数轨只能表达**一种**调性视角。但实际分析里经常要同时看几种：
 *
 *   - 关系大小调对照：A 大调 vs F# 小调，和弦完全相同、级数完全不同
 *     （A 调里 F#:min 是 vi，F# 小调里它是 i）。判断歌曲真正的调中心时
 *     两个视角并排看非常有用。
 *   - 转调段：主歌在某调、副歌转掉，一条轨从和弦名看是对的，
 *     但级数会显得很乱；另开一条按副歌调解释就整齐了。
 *   - 学习对照：同一个进行在 C 调和 G 调下分别是 I-vi-IV-V 和 IV-ii-bVII-I。
 *
 * ## 为什么用 parentId 关联和弦块
 *
 * 级数块不存真实音高信息，它的含义**完全来自父和弦 + 推定调性**。
 * 用 parentId 关联后：
 *   - 用户改和弦名 → 所有级数轨自动跟着变（不用逐条重算）
 *   - 和弦块被删 → 能级联删掉所有子级数块（见 cascadeDelete）
 *
 * @param chords   和弦块（必须是当前实时数据，不是分析快照）
 * @param tonic    这条轨用哪个调性解释
 * @param mode     大调/小调（只影响显示标签，不影响数字计算）
 * @param trackId  轨道 id，多条级数轨靠它区分
 */
export function makeDegreeTrack(
  chords: readonly RealClip[],
  tonic: string,
  mode: 'major' | 'minor',
  trackId: string,
): RealTrack {
  const modeLabel = mode === 'major' ? 'major' : 'minor';
  const clips: RealClip[] = chords.map((c, i) => {
    // 解析不出来的（N / 未识别 / 中文）留空壳，等用户补完和弦自动算出
    const deg = chordToNumber(c.label, tonic);
    return {
      id: trackId + '-c' + i,
      startTick: c.startTick,
      endTick: c.endTick,
      label: deg ?? '',
      sublabel: tonic + ' ' + modeLabel,
      state: 'draft' as const,
      parentId: c.id,
    };
  });
  return {
    id: trackId,
    kind: 'degree',
    name: '级数 · ' + tonic + ' ' + (mode === 'major' ? '大调' : '小调'),
    // 轨道头只有 148px，副标题要和调性徽章同行 —— 必须极短。
    // 原来写「按指定调性解释（手动）」，实测被截成「按指定...」，
    // 反而占地方又没说清。
    layer: '手动指定',
    visible: true,
    // 这条轨的调性存在自己身上 —— 渲染级数时以它为准，
    // 不读全局 keyTonic（否则多条轨会算出同一套级数）。
    degreeTonic: tonic,
    degreeMode: mode,
    clips,
  };
}

/**
 * 一条级数轨该用哪个主音来换算级数。
 *
 * 优先级：轨道自己的 `degreeTonic` > 全局调性 > 空串。
 *
 * ## 为什么这件事要集中在一个函数里
 *
 * 用户可以加多条级数轨、每条指定不同调性（用 G 大调和 D 小调对照看
 * 同一段和声）。渲染层如果各自去读全局 `keyTonic`，所有轨就会算出
 * 同一套级数 —— 用户报的「级数轨根本没单独计算，换全曲主调时自定义
 * 级数轨跟着变」。
 *
 * 只有「级数解释」那条自动轨没有 `degreeTonic`，它本来就该跟随全局
 * 调性；用户追加的轨一律以自己身上存的为准。
 */
export function degreeTonicOf(
  track: { degreeTonic?: string } | null | undefined,
  globalTonic?: string,
): string {
  return track?.degreeTonic || globalTonic || '';
}

/**
 * 级数块要不要高亮 —— 「这段请按我这条轨来理解」。
 *
 * ## 规则（三条，缺一不可）
 *
 * | 段调性 | 主级数轨（自动轨） | 自定义轨 |
 * |---|---|---|
 * | **没标** | ✅ 高亮（它是默认解读） | ❌ 不高亮 |
 * | 标了，且与该轨调性**一致** | ✅ 高亮 | ✅ 高亮 |
 * | 标了，但没有一致的轨 / 调性不符 | ❌ 不高亮 | ❌ 不高亮 |
 *
 * ## 为什么「没标也要高亮主级数轨」
 *
 * 用户的原话：「如果啥都没标，主级数轨（级数解释）要高亮」。
 * 语义是「这段没有特别标注，那就按全局调性理解」—— 主级数轨正是
 * 跟着全局调性的那条，所以它就是默认答案，该被指出来。
 *
 * 而自定义轨（用户为对照加的 D 小调轨）在没标调性的段落里**不该**
 * 抢戏：它只是备选视角，不是这段的结论。
 *
 * ## 为什么标了调性却没有匹配轨时不挑一条
 *
 * 用户明确要求「可以不高亮任何轨道」。硬挑一条会让用户以为
 * 「系统认为这段就是这个调」，而实际上系统只是没有对应的轨而已。
 */
export function shouldHighlightDegree(
  track: { degreeTonic?: string; degreeMode?: 'major' | 'minor' },
  sectionKey: { tonic: string; mode: 'major' | 'minor' } | undefined,
  globalTonic: string,
  globalMode: 'major' | 'minor',
): boolean {
  const isAuto = !track.degreeTonic;
  if (!sectionKey) return isAuto;
  const tone = track.degreeTonic || globalTonic;
  const mode = track.degreeMode ?? globalMode;
  return sectionKey.tonic === tone && sectionKey.mode === mode;
}

export function makeRealTracks(
  a: AnalysisFile,
  opts: {
    dict?: string;
    /**
     * 秒 → tick 的映射。
     *
     * **优先用真实拍点**（`makeBeatSnapper`），而不是 TempoMap。
     * 见 `makeBeatSnapper` 的说明。
     */
    bySecToTick: (sec: number) => number;
    /**
     * 和弦边界吸附到小节线。
     *
     * 模型（lv-chordia）的和弦边界经常落在小节中间（实测 3.56、4.25、6.25 小节），
     * 而实际编曲里和弦几乎都在小节起点变化（对照 Song Master Pro 的结果也是这样）。
     *
     * 开启后：边界距最近小节线 ≤ `snapBars` 小节时吸附过去。
     * 设 0 关闭（保留模型原始边界）。
     */
    snapToBar?: number;
    /** 最小和弦长度（拍），默认 2（半小节） */
    minBeats?: number;
  },
): RealTrack[] {
  const dict = opts.dict ?? 'submission';
  const segs = a.chords[dict] ?? [];
  const key = inferKey(a, dict);
  const toTick = opts.bySecToTick;

  /**
   * 和弦轨 —— **边界独立量化，相邻块共享边界**。
   *
   * ⚠️ 这里踩过一个坑：第一版用
   *     startTick = Math.max(prevEnd, quantize(s.start))
   * 意图是"保证连续"，但会导致**漂移累积**：
   * 前一块量化后如果变长（向上吸附），后一块的起点就被推着走，
   * 一路传下去，到后面块已经完全偏离真实位置，块边界也不落在小节线上了。
   *
   * 正确做法：把所有边界点**各自独立量化**，然后让相邻块共用同一个边界值。
   * 这样每块只受自己两端影响，不会把误差传给下一块。
   */
  const TICKS_PER_BAR_LOCAL2 = 4 * PPQ;

  /** 边界量化 + 可选小节吸附 */
  const q = (sec: number) => {
    let tick = toTickQuantized(sec, toTick);

    // ## 先吸附到整数拍
    //
    // 模型的边界抖动是"亚拍级"的：实测《特にない》后半段有大量
    // -0.49 ~ +0.49 拍的随机偏移（正负都有、大小随机），
    // 那不是系统错位，而是 lv-chordia 输出的边界本身不准。
    //
    // 编曲里和弦不会在半拍上换（swing 的八分音符除外，但那属于
    // 更细的量化，不在这一层处理）。所以先把边界拉回最近的整拍。
    const beatTick = PPQ;
    const nearestBeat = Math.round(tick / beatTick) * beatTick;
    // 阈值 0.4 拍：超过这个值说明真的在切分位置，不该动
    if (Math.abs(nearestBeat - tick) <= 0.4 * beatTick) tick = nearestBeat;

    // ## 再吸附到小节线（只在离小节线很近时）
    const snap = opts.snapToBar ?? 0;
    if (snap > 0) {
      const bar = TICKS_PER_BAR_LOCAL2;
      const nearest = Math.round(tick / bar) * bar;
      if (Math.abs(nearest - tick) <= snap * bar) tick = nearest;
    }
    return tick;
  };

  // 1) 收集并量化所有边界
  const rawBounds: number[] = [];
  for (const s of segs) rawBounds.push(q(s.start));
  if (segs.length) rawBounds.push(q(segs[segs.length - 1].end));

  /**
   * 2) **去重**：吸附到小节后，相邻边界可能变成同一个值。
   * 这时两个和弦应该**合并**（而不是把后一个推后 1 拍产生碎片）。
   *
   * 这一步很关键：第一版没有去重，导致吸附后出现大量 1 拍的碎片块，
   * 视觉上就是"块很碎 / 边界飘"。
   */
  const bounds: number[] = [];
  for (const b of rawBounds) {
    if (bounds.length === 0 || b > bounds[bounds.length - 1]) bounds.push(b);
  }

  /**
   * 3) 最小长度兜底：短于 `minBeats` 拍的块并入前一块。
   *
   * **注意区分「量化粒度」和「最小长度」**：
   *   - 量化粒度 480（八分音符）：边界可以落在半拍位置（抢拍）
   *   - 最小长度 960（1 拍）：和弦本身至少持续 1 拍
   * 两者独立。经过和弦（如 5/7）通常 1–2 拍，不该被合并。
   */
  const minBeats = opts.minBeats ?? 1;
  const minTicks = minBeats * PPQ;
  const cleaned: number[] = [bounds[0] ?? 0];
  for (let i = 1; i < bounds.length; i++) {
    const prev = cleaned[cleaned.length - 1];
    const isLast = i === bounds.length - 1;
    if (!isLast && bounds[i] - prev < minTicks) {
      // 这一段太短：丢弃这个边界（相当于把两块合并）
      continue;
    }
    cleaned.push(bounds[i]);
  }

  // 4) 生成块（label 取该区间起点对应和弦）
  const chordClips: RealClip[] = [];
  let segIdx = 0;
  for (let i = 0; i < cleaned.length - 1; i++) {
    const startTick = cleaned[i];
    const endTick = cleaned[i + 1];
    // 找覆盖 startTick 的和弦段（用起始秒排序后的索引）
    while (
      segIdx < segs.length - 1 &&
      q(segs[segIdx].end) <= startTick
    ) {
      segIdx++;
    }
    const seg = segs[segIdx];
    const rawLabel = seg?.chord ?? 'N';
    /**
     * 长的 `N` 改成「未识别」。
     *
     * 短 `N`（≤2 小节）保留：那通常是真实的短促停顿（比如鼓点 fill、
     * 段落间的单拍留白），模型判 N 是对的。
     * 长 `N` 则几乎一定是识别失效 —— 见 `UNRECOGNIZED_MIN_BARS` 的说明。
     */
    const bars = (endTick - startTick) / TICKS_PER_BAR_LOCAL2;
    /**
     * 延伸到曲末的长 `N` 不算「未识别」。
     *
     * 歌结尾经常是淡出 + 余韵，模型判 N 是对的（实测这首歌最后
     * 12 小节一直延伸到曲末 315.4s）。它和「中间突然一段没识别出来」
     * 性质完全不同，不该用同一个标签。
     *
     * 判据用「是否到曲末」而不是「是否最后一块」：万一以后末尾还多出
     * 别的段落，只跳过最后一块会漏掉真正的问题段。
     */
    const songEndTick = a.downbeatsSec.length * TICKS_PER_BAR_LOCAL2;
    const reachesSongEnd = endTick >= songEndTick - TICKS_PER_BAR_LOCAL2;
    const isLongN =
      rawLabel === 'N' && bars > UNRECOGNIZED_MIN_BARS && !reachesSongEnd;
    chordClips.push({
      id: `chord-${i}`,
      startTick,
      endTick,
      label: isLongN ? UNRECOGNIZED_LABEL : rawLabel,
      sublabel: isLongN ? '模型未识别，可手动补' : undefined,
      state: isLongN ? 'draft' : 'draft',
      confidence: isLongN ? 0 : seg?.confidence,
      alternatives: seg?.alternatives,
    });
  }

  /**
   * 级数解释轨（从和弦派生，父级为和弦）。
   *
   * ## 每个和弦块都要有一条级数块 —— 即使是「未识别」和 `N`
   *
   * 踩过的坑：原来写了 `if (!deg) continue`，把解析不出级数的块直接**跳过**。
   * 后果是：
   *   - 「未识别」段（label 是中文）解析失败 → 级数轨那里是空白
   *   - 用户在右侧把「未识别」改成 `Ab:maj` 之后，**级数块根本不存在**，
   *     所以永远补不上 —— 用户报的「手动补了级数轨没同步」就是这个
   *
   * 正确做法：级数块**一律生成**，标签留空（渲染时显示 `—`）。
   * 这样它和父和弦是稳定的一对一关系，用户改和弦时级数能跟着更新，
   * 时间范围也靠 `parentId` 投影自动跟随。
   *
   * 标签的实时派生在 `TimelineView` / `App` 侧做（见 `degreeLabelFor`）。
   */
  const degreeClips: RealClip[] = [];
  for (let i = 0; i < chordClips.length; i++) {
    const c = chordClips[i];
    const deg = chordToNumber(c.label, key.tonic);
    degreeClips.push({
      id: `deg-${i}`,
      startTick: c.startTick,
      endTick: c.endTick,
      // 解析不出来就留空壳，等用户补完和弦会自动算出级数
      label: deg ?? '',
      sublabel: `${key.tonic} ${key.mode === 'major' ? 'major' : 'minor'}`,
      state: 'draft',
      parentId: c.id,
    });
  }

  /**
   * 结构轨。
   *
   * 优先用 `analysis.sections`（all-in-one-infer 的输出）；
   * **整份分析都没有**时（空谱面，歌还没分析完）**不**回退到手工结构。
   *
   * 踩过的坑：以前无条件 `normalized.length > 0 ? normalized : STRUCTURE_SEGMENTS`，
   * 于是点一首正在分析的歌，结构轨会画出 `STRUCTURE_SEGMENTS` 里的
   * Intro/Verse/B/A/B/C/B 七段 —— 那是**另一首歌**（Refrain）的编排。
   * 用户看到「结构和弦都出来了」，其实和他点的歌毫无关系。
   *
   * 判定方式：整份分析为空 ⇔ 没有小节也没有和弦。此时结构轨必须是空的。
   * （有分析结果但恰好没有结构段时，才回退到手工参考，那种情况是有意义的。）
   */
  const TICKS_PER_BAR_LOCAL = 4 * PPQ;
  const normalized = normalizeSections(a);
  const autoSections = normalized;
  const analysisIsEmpty = a.downbeatsSec.length === 0 && (a.chords['submission'] ?? []).length === 0;
  const structureSource: StructureSegment[] = analysisIsEmpty
    ? []
    : normalized.length > 0
      ? normalized
      : STRUCTURE_SEGMENTS;

  const sectionClips: RealClip[] = structureSource.map((seg, i) => ({
    id: `sec-${i}`,
    startTick: seg.startBar * TICKS_PER_BAR_LOCAL,
    endTick: seg.endBar * TICKS_PER_BAR_LOCAL,
    label: seg.label,
    sublabel: seg.source === 'manual' ? '已校对' : undefined,
    state: 'confirmed',
  }));

  // 结构未覆盖的剩余区间（空谱面时 totalBars 也是 0，这里自然不产生片段）
  const totalBars = a.downbeatsSec.length;
  const coveredBars = structureSource.length
    ? structureSource[structureSource.length - 1].endBar
    : STRUCTURE_COVERED_BARS;
  if (coveredBars < totalBars) {
    sectionClips.push({
      id: 'sec-pending',
      startTick: coveredBars * TICKS_PER_BAR_LOCAL,
      endTick: totalBars * TICKS_PER_BAR_LOCAL,
      label: '待标注',
      state: 'draft',
    });
  }

  return [
    {
      id: 'tr-section',
      kind: 'section',
      name: '歌曲结构',
      layer: autoSections.length > 0 ? 'all-in-one-infer 自动分析' : '人工校对（参考 Song Master Pro）',
      visible: true,
      clips: sectionClips,
    },
    {
      id: 'tr-chord',
      kind: 'chord',
      name: '绝对和弦',
      visible: true,
      clips: chordClips,
    },
    {
      id: 'tr-degree',
      kind: 'degree',
      name: '级数解释',
      layer: `${key.tonic} major（自动推断）`,
      visible: true,
      clips: degreeClips,
    },
  ];
}
