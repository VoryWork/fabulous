/**
 * TempoMap —— 速度（BPM）锚点，Tick ⇄ 秒 的映射。
 *
 * ## 为什么改成 BPM 锚点（而不是原来的 tick/sec 锚点）
 *
 * 原来的 `BeatMap` 存 `(tick, sec)` 对，理论上等价，但：
 *   - 用户看到的是 "BPM 96"，不是 "tick 7680 对应 4.0 秒"
 *   - 编辑时改 `sec` 需要用户自己算 BPM
 *   - 导入模型结果时（原始秒数）反而更自然用 sec
 *
 * 所以本模块内部**同时维护两种表示**：
 *   - 权威：`TempoAnchor { tick, bpm }`（音乐语义）
 *   - 派生：把锚点转换成 `(tick, sec)` 缓存，用于快速投影
 *
 * ## 与拍号的关系（用户确认的模型）
 *
 * - **BPM 指的是「四分音符每分钟」**，与拍号无关
 * - 一小节的实际时长 = `beatsInBar × (60 / bpm)`，其中 beatsInBar 来自拍号
 * - 所以 4/4 变 3/4 时，若 BPM 不变，**一拍时长不变，小节变短**
 * - 变速时，**一小节内所有拍等比拉伸/压缩**
 *
 * ## 严格单调
 *
 * 锚点必须 tick 递增、且相邻锚点导出的 sec 也递增。
 * 若某个 bpm 导致时间倒流（不可能，bpm > 0 恒成立），说明数据错误。
 */

import { PPQ, assertTick } from './Tick';

/** 速度锚点：从 `tick` 起，以 `bpm`（四分音符每分钟）前进 */
export interface TempoAnchor {
  readonly tick: number;
  readonly bpm: number;
}

/** 派生的 (tick, sec) 对，用于投影 */
export interface TickSecPoint {
  readonly tick: number;
  readonly sec: number;
}

export interface TempoMapData {
  readonly anchors: readonly TempoAnchor[];
  /** 音频总时长（秒），用于 clamp */
  readonly durationSec: number;
  /**
   * tick 0 对应的**绝对秒数**。
   *
   * 为什么需要：真实歌曲的第 1 小节通常不在 0s（有前奏）。
   * 实测 Refrain 的第一个 downbeat 在 0.36s，若强行让 tick 0 = 0s，
   * 整条时间轴（网格、和弦块、播放头）都会比音频**早半拍**。
   *
   * 设为 0.36 后：tick 0 === 音频 0.36s === 第 1 小节起点，完全同步。
   */
  readonly startSec: number;
  /**
   * 派生缓存：与 anchors 一一对应的 (tick, sec)。
   * 构造时算好，投影时二分查找，避免每次积分。
   */
  readonly points: readonly TickSecPoint[];
}

/** 由 tick 处的 BPM 求 tick/秒 */
export function ticksPerSecond(bpm: number): number {
  return (bpm / 60) * PPQ;
}

/** 校验并构造 TempoMap */
export function createTempoMap(
  anchors: readonly TempoAnchor[],
  durationSec: number,
  startSec = 0,
): TempoMapData {
  if (anchors.length === 0) {
    throw new RangeError('TempoMap 至少需要一个速度锚点');
  }
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) {
    throw new RangeError(`durationSec 必须为正有限数，收到 ${durationSec}`);
  }

  const sorted = [...anchors].sort((a, b) => a.tick - b.tick);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    assertTick(a.tick, `anchors[${i}].tick`);
    if (!(a.bpm > 0) || !Number.isFinite(a.bpm)) {
      throw new RangeError(`anchors[${i}].bpm 必须为正有限数，收到 ${a.bpm}`);
    }
    if (i > 0 && a.tick <= sorted[i - 1].tick) {
      throw new RangeError(
        `速度锚点 tick 必须严格递增：${sorted[i - 1].tick} >= ${a.tick}`,
      );
    }
  }
  if (sorted[0].tick !== 0) {
    throw new RangeError('第一个速度锚点必须从 tick 0 开始');
  }

  // 预计算每个锚点的绝对秒数（从 startSec 开始积分）
  const points: TickSecPoint[] = [];
  let sec = startSec;
  points.push({ tick: sorted[0].tick, sec: startSec });
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    sec += (cur.tick - prev.tick) / ticksPerSecond(prev.bpm);
    points.push({ tick: cur.tick, sec });
  }

  return { anchors: sorted, durationSec, startSec, points };
}

/** 恒定 BPM 的便捷构造 */
export function createConstantTempoMap(
  bpm: number,
  durationSec: number,
  startSec = 0,
): TempoMapData {
  return createTempoMap([{ tick: 0, bpm }], durationSec, startSec);
}

/** 找最后一个 tick <= 给定 tick 的锚点索引 */
function findAnchorIndex(map: TempoMapData, tick: number): number {
  const { points } = map;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Tick → 秒。
 *
 * 在锚点之间线性插值；超出最后锚点时用最后一段 BPM 外推
 * （用户可能把视口滚到音频结尾之后继续编辑）。
 */
export function tickToSec(map: TempoMapData, tick: number): number {
  const { points, anchors } = map;
  if (points.length === 1) {
    // 必须加 points[0].sec：tick 0 对应的不是一个绝对秒数，
    // 而是「第一个小节起点」（`startSec`）。《何なんw》补了开头
    // 虚拟小节后 startSec = 0.10，漏了这一项就会整体错 0.10s。
    return points[0].sec + tick / ticksPerSecond(anchors[0].bpm);
  }

  if (tick <= points[0].tick) {
    return points[0].sec + (tick - points[0].tick) / ticksPerSecond(anchors[0].bpm);
  }

  const i = findAnchorIndex(map, tick);
  const p = points[i];
  const a = anchors[i];
  return p.sec + (tick - p.tick) / ticksPerSecond(a.bpm);
}

/**
 * 秒 → Tick（四舍五入到整数）
 */
export function secToTick(map: TempoMapData, sec: number): number {
  const { points, anchors } = map;
  if (points.length === 1) {
    return Math.round((sec - points[0].sec) * ticksPerSecond(anchors[0].bpm));
  }

  if (sec <= points[0].sec) {
    // 同理：`startSec` 之前的秒数是**负 tick**（谱面外），
    // 不能直接拿绝对秒数乘。调用方会 clamp 到 [0, totalTicks]。
    return Math.round((sec - points[0].sec) * ticksPerSecond(anchors[0].bpm));
  }

  // 反向二分
  let lo = 0;
  let hi = points.length - 1;
  if (sec >= points[hi].sec) {
    const p = points[hi];
    return Math.round(p.tick + (sec - p.sec) * ticksPerSecond(anchors[hi].bpm));
  }
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].sec <= sec) lo = mid;
    else hi = mid - 1;
  }
  const p = points[lo];
  return Math.round(p.tick + (sec - p.sec) * ticksPerSecond(anchors[lo].bpm));
}

/** 某 tick 处的瞬时 BPM */
export function bpmAt(map: TempoMapData, tick: number): number {
  const i = findAnchorIndex(map, tick);
  return map.anchors[i].bpm;
}

/**
 * 某区间的平均 BPM（用于显示"这一段的速度"）。
 */
export function averageBpm(
  map: TempoMapData,
  startTick: number,
  endTick: number,
): number {
  if (endTick <= startTick) throw new RangeError('区间必须非空');
  const secStart = tickToSec(map, startTick);
  const secEnd = tickToSec(map, endTick);
  const tps = (endTick - startTick) / (secEnd - secStart);
  return (tps * 60) / PPQ;
}

/** 插入或替换锚点 */
export function upsertTempoAnchor(
  map: TempoMapData,
  anchor: TempoAnchor,
): TempoMapData {
  const next = map.anchors.filter((a) => a.tick !== anchor.tick);
  next.push(anchor);
  return createTempoMap(next, map.durationSec, map.startSec);
}

/** 删除锚点（不能删 tick 0 的，且至少保留一个） */
export function removeTempoAnchor(map: TempoMapData, tick: number): TempoMapData {
  if (tick === 0) throw new RangeError('不能删除 tick 0 的初始速度');
  const next = map.anchors.filter((a) => a.tick !== tick);
  return createTempoMap(next, map.durationSec, map.startSec);
}

/**
 * 计算某小节的时长（秒）。
 *
 * 这是「BPM 用于对齐音频和游标前进」的具体体现：
 *   小节时长 = 拍数 × 每拍秒数
 *   每拍秒数 = 60 / bpm
 */
export function barDurationSec(
  tempo: TempoMapData,
  barStartTick: number,
  beatsInBar: number,
): number {
  return beatsInBar * (60 / bpmAt(tempo, barStartTick));
}

/**
 * 播放头前进：给定当前 tick 和经过的时间，算出新 tick。
 *
 * 用于播放条的时间推进（M2 接入真实音频后由后端驱动，
 * 这里先给前端预览用）。
 */
export function advanceTick(
  map: TempoMapData,
  tick: number,
  deltaSec: number,
): number {
  const bpm = bpmAt(map, tick);
  return tick + deltaSec * ticksPerSecond(bpm);
}

/** 区间内的速度锚点（用于渲染速度轨） */
export function anchorsInRange(
  map: TempoMapData,
  startTick: number,
  endTick: number,
): TempoAnchor[] {
  return map.anchors.filter((a) => a.tick >= startTick && a.tick <= endTick);
}
