/**
 * SnapEngine —— 吸附引擎。
 *
 * 规格（PRD §4.5）：
 *   1. **节拍网格**：1/2、1/3、1/4、1/8 等步长，以整数 Tick 表示
 *   2. **事件边界**：其他和弦/段落/调性区间的起止边界
 *   3. **音乐标记**：小节强拍、循环点、转调标记、人工 Anchor
 *
 * 关键设计：
 *
 * ## 一、像素阈值而非 tick 阈值
 *
 * PRD 原文：「对于"最近对象"的选择必须使用**屏幕像素阈值**，
 * 避免不同 Zoom 下手感发生明显变化」。
 *
 * 所以本模块的输入包含 `pixelsPerTick`，把候选换算成像素距离再比较。
 * 如果按 tick 距离比较，放大后"附近"的候选会变多，手感完全不同。
 *
 * ## 二、优先级可配置
 *
 * 默认：强制网格 > 用户指定辅助线 > 临近事件边界
 * （PRD 建议「强制网格 > 用户指定辅助线 > 临近事件边界」）
 *
 * ## 三、纯函数
 *
 * 输入：候选 tick + 吸附配置 + 视口
 * 输出：吸附后的 tick + 命中的吸附源（用于渲染辅助线）
 * 不持有状态，不在绘制层自行吸附。
 */

import { PPQ, quantize } from './Tick';

/** 吸附源类型 */
export type SnapSource = 'grid' | 'event' | 'marker' | 'none';

/** 吸附结果 */
export interface SnapResult {
  readonly tick: number;
  readonly source: SnapSource;
  /** 命中的原始候选 tick（用于画辅助线） */
  readonly snappedTo: number | null;
  /** 像素距离（调试用） */
  readonly distancePx: number;
}

/** 网格吸附粒度（拍的分母） */
export type GridDivision = 1 | 2 | 3 | 4 | 6 | 8 | 12 | 16;

/**
 * 最小量化单位 = **八分音符**（480 tick）。
 *
 * 演进过程（两版用户反馈）：
 *   1. 「不能无限细分，最少按一拍量化」 → 设为 960（1 拍）
 *   2. 「和声量化以八分音符会好一些，因为有些歌会抢拍」 → 改为 480（八分音符）
 *
 * 为什么八分音符是正确的最小单位：
 *   - 切分和弦（syncopation）真实落在**半拍**位置，量化到整拍会把它抹掉
 *   - 但再细就没有音乐意义了：1/4 拍（240 tick）已超出人耳对和声变化的辨识精度，
 *     而模型的实际时间精度也做不到
 *   - 实测模型碎片是 0.08s ≈ 1/10 拍，八分音符网格天然把它们吸收掉
 *
 * 交互与导入共用这个常量：拖动落点、导入边界都对齐到 480。
 */
export const MIN_QUANTUM_TICKS = PPQ / 2;

/** 吸附配置 */
export interface SnapConfig {
  /** 是否启用吸附（Alt 按住时临时关闭） */
  readonly enabled: boolean;
  /** 网格粒度；null 表示不做网格吸附 */
  readonly gridDivision: GridDivision | null;
  /** 事件边界候选（其他片段的起止 tick） */
  readonly eventTicks: readonly number[];
  /** 音乐标记候选（小节强拍、转调点等） */
  readonly markerTicks: readonly number[];
  /** 吸附的最大像素距离 */
  readonly thresholdPx: number;
  /** 优先级顺序 */
  readonly priority: readonly SnapSource[];
}

/**
 * 强制量化到最小单位（1 拍）。
 *
 * 所有拖动结果在落地前都要过这一层。
 */
export function quantizeToQuantum(
  tick: number,
  quantum = MIN_QUANTUM_TICKS,
): number {
  if (quantum <= 0) return Math.round(tick);
  // `+ 0` 把 -0 归一化为 0，避免 `Object.is(-0, 0) === false` 这类坑
  return Math.round(tick / quantum) * quantum + 0;
}

export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  enabled: true,
  // 默认 1 拍：用户要求「最少按 1 拍量化」
  gridDivision: 1,
  eventTicks: [],
  markerTicks: [],
  thresholdPx: 8,
  // PRD 建议：强制网格 > 用户指定辅助线 > 临近事件边界
  priority: ['grid', 'marker', 'event'],
};

/** 网格一步多少 tick */
export function gridStepTicks(division: GridDivision): number {
  const step = PPQ / division;
  if (!Number.isInteger(step)) {
    throw new RangeError(`1/${division} 拍无法表示为整数 tick`);
  }
  return step;
}

/**
 * 计算吸附结果。
 *
 * @param rawTick     鼠标换算出的原始 tick（浮点，调用方负责 Math.round 前的精度）
 * @param cfg         吸附配置
 * @param pixelsPerTick 当前缩放，用于把 tick 距离换算成像素
 */
export function snap(
  rawTick: number,
  cfg: SnapConfig,
  pixelsPerTick: number,
): SnapResult {
  const tick = Math.round(rawTick);

  if (!cfg.enabled) {
    // 关闭吸附 ≠ 自由精度：仍然量化到 1 拍，避免拖出无法解释的碎片
    return {
      tick: quantizeToQuantum(tick),
      source: 'none',
      snappedTo: null,
      distancePx: 0,
    };
  }

  // 按优先级逐个尝试
  for (const source of cfg.priority) {
    const result = trySnapTo(source, tick, cfg, pixelsPerTick);
    if (result) return result;
  }

  // 兜底：吸附开启但没命中任何候选。
  // **这里也必须量化** —— 否则会返回 Math.round 后的任意 tick，
  // 拖出 1/3 拍这种无法解释的碎片。这是「最少按 1 拍量化」的最后一道闸。
  return {
    tick: quantizeToQuantum(tick),
    source: 'none',
    snappedTo: null,
    distancePx: 0,
  };
}

function trySnapTo(
  source: SnapSource,
  tick: number,
  cfg: SnapConfig,
  pixelsPerTick: number,
): SnapResult | null {
  if (source === 'grid') {
    if (cfg.gridDivision == null) return null;
    const step = gridStepTicks(cfg.gridDivision);
    const snapped = quantize(tick, step);
    const distPx = Math.abs(snapped - tick) * pixelsPerTick;
    if (distPx > cfg.thresholdPx) return null;
    return { tick: snapped, source: 'grid', snappedTo: snapped, distancePx: distPx };
  }

  // marker / event：在候选里找像素距离最近且小于阈值的
  const candidates = source === 'marker' ? cfg.markerTicks : cfg.eventTicks;
  if (candidates.length === 0) return null;

  let bestTick: number | null = null;
  let bestPx = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const dPx = Math.abs(c - tick) * pixelsPerTick;
    if (dPx < bestPx) {
      bestPx = dPx;
      bestTick = c;
    }
  }
  if (bestTick === null || bestPx > cfg.thresholdPx) return null;
  return { tick: bestTick, source, snappedTo: bestTick, distancePx: bestPx };
}

/**
 * 对「区间」执行吸附。
 *
 * 拖动时可能吸左边界、吸右边界、或两边都吸，取决于哪种组合总偏移最小。
 * 返回的是**整体位移量**，这样调用方可以用同一个 delta 移动整个区间。
 *
 * 语义：
 *   - `grab='start'`：只吸 start（拖左边缘）
 *   - `grab='end'`：只吸 end（拖右边缘）
 *   - `grab='both'`：吸更近的那一侧（拖块体移动时，通常用 start 更直观）
 */
export function snapRange(
  rawStart: number,
  rawEnd: number,
  grab: 'start' | 'end' | 'both',
  cfg: SnapConfig,
  pixelsPerTick: number,
): { start: number; end: number; source: SnapSource; snappedTo: number | null } {
  /**
   * 三种抓法的语义（**关键：另一端不能被带歪**）
   *
   * - `start`：只改左边界，右边界**不动**
   * - `end`  ：只改右边界，左边界**不动**
   * - `both` ：整体平移，长度**不变**（delta 必须是整拍，否则长度会被破坏）
   *
   * 之前写成 `end = rawEnd + delta` 是错的：
   * delta 是吸附产生的非整拍偏移，加到另一端就产生了非整拍边界。
   * 这正是「拖动伸缩不能无限细分」要防的情况。
   */

  if (grab === 'start') {
    const r = snap(rawStart, cfg, pixelsPerTick);
    return {
      start: r.tick,
      // 右边界独立量化，不受左侧 delta 影响
      end: quantizeToQuantum(rawEnd),
      source: r.source,
      snappedTo: r.snappedTo,
    };
  }

  if (grab === 'end') {
    const r = snap(rawEnd, cfg, pixelsPerTick);
    return {
      // 左边界独立量化
      start: quantizeToQuantum(rawStart),
      end: r.tick,
      source: r.source,
      snappedTo: r.snappedTo,
    };
  }

  // both：整体平移，长度保持不变
  const len = quantizeToQuantum(rawEnd - rawStart);
  const r = snap(rawStart, cfg, pixelsPerTick);
  // 兜底：确保 start 也是整拍（snap 在 enabled=false 时已量化）
  const startTick = quantizeToQuantum(r.tick);
  return {
    start: startTick,
    end: startTick + len,
    source: r.source,
    snappedTo: r.snappedTo,
  };
}

/**
 * 收集事件边界候选（供轨道使用）。
 *
 * 排除被拖动的片段自身，否则会吸到自己的原位。
 */
export function collectEventTicks(
  ranges: readonly { startTick: number; endTick: number; id: string }[],
  excludeId: string | null,
): number[] {
  const out: number[] = [];
  for (const r of ranges) {
    if (r.id === excludeId) continue;
    out.push(r.startTick, r.endTick);
  }
  return out;
}

/** 收集小节强拍候选（吸强拍用） */
export function collectBarTicks(
  barStarts: readonly number[],
): number[] {
  return [...barStarts];
}
