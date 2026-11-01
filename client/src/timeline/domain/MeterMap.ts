/**
 * MeterMap —— 拍号（拍子签名）与小节分组。
 *
 * ## 核心设计（与用户确认的模型）
 *
 * **以 beat 为最原始单位，格子间隔恒为「1 个四分音符」。**
 *
 * 拍号只改变**分组方式**，不改变最小格子的宽度：
 *
 * ```
 * 4/4:  |· · · ·|· · · ·|     bar = 4 格
 * 3/4:  |· · ·|· · ·|         bar = 3 格
 * 6/8:  |· · ·|· · ·|         bar = 3 格（6 个八分 = 3 个四分）
 * 7/8:  |· · ·|· · · ·|       bar = 3.5 格
 * ```
 *
 * 为什么这样做：
 *   - 若格子间隔随拍号变（旧做法），变拍后网格密度突变，视觉上很乱
 *   - 格子恒定则缩放/吸附行为稳定，拍号只是"画多粗的分组线"
 *
 * ## 与音符时值的关系
 *
 * `CELL_TICKS = 960`（1 个四分音符）是**视觉与吸附的格子**。
 * 但真正的拍（beat）可能是八分（6/8 中），所以：
 *   - `beatTicks()` 返回该拍号下「一拍」的 tick 数（可能 < 960）
 *   - `cellTicks()` 返回网格格子，恒为 960
 *
 * 二者分开，才能在 6/8 里既画 960 的格子、又标明"一拍是八分"。
 */

import { PPQ, assertTick } from './Tick';

/** 网格格子的固定宽度：1 个四分音符 */
export const CELL_TICKS = PPQ;

/**
 * 拍号事件。`startTick` 是该拍号生效的第一个 tick。
 *
 * 注意：拍号事件**不要求**对齐小节起点。若不对齐，说明数据有误，
 * 由 UI 提示用户修正（见 `validateMeterAlignment`）。
 */
export interface MeterEvent {
  readonly startTick: number;
  readonly numerator: number;
  readonly denominator: number;
}

export interface MeterMapData {
  /** 按 startTick 严格递增 */
  readonly events: readonly MeterEvent[];
  /**
   * 弱起：第 0 小节只有这么多 tick。
   * 0 表示无弱起。
   */
  readonly pickupTicks: number;
}

/** 该拍号下「一拍」是多少 tick */
export function beatTicks(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || numerator <= 0) {
    throw new RangeError(`numerator 必须是正整数，收到 ${numerator}`);
  }
  if (!Number.isInteger(denominator) || denominator <= 0) {
    throw new RangeError(`denominator 必须是正整数，收到 ${denominator}`);
  }
  const perBeat = (PPQ * 4) / denominator;
  if (!Number.isInteger(perBeat)) {
    throw new RangeError(`${numerator}/${denominator} 的一拍无法表示为整数 tick`);
  }
  return perBeat;
}

/** 一小节多少 tick */
export function barTicks(numerator: number, denominator: number): number {
  return numerator * beatTicks(numerator, denominator);
}

/** 网格格子宽度（恒为 960，与拍号无关） */
export function cellTicks(): number {
  return CELL_TICKS;
}

export function createMeterMap(
  events: readonly MeterEvent[],
  pickupTicks = 0,
): MeterMapData {
  if (events.length === 0) {
    throw new RangeError('MeterMap 至少需要一个拍号事件');
  }
  if (!Number.isInteger(pickupTicks) || pickupTicks < 0) {
    throw new RangeError(`pickupTicks 必须是非负整数，收到 ${pickupTicks}`);
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    assertTick(e.startTick, `events[${i}].startTick`);
    beatTicks(e.numerator, e.denominator);
    if (i > 0 && e.startTick <= events[i - 1].startTick) {
      throw new RangeError(
        `拍号事件必须严格递增：events[${i - 1}].startTick=${events[i - 1].startTick} >= ${e.startTick}`,
      );
    }
  }
  if (events[0].startTick !== 0) {
    throw new RangeError('第一个拍号事件必须从 tick 0 开始');
  }
  if (pickupTicks > 0) {
    const firstBar = barTicks(events[0].numerator, events[0].denominator);
    if (pickupTicks >= firstBar) {
      throw new RangeError(`弱起(${pickupTicks}) 必须短于第一个完整小节(${firstBar})`);
    }
  }
  return { events, pickupTicks };
}

export function createMeterMap4_4(pickupTicks = 0): MeterMapData {
  return createMeterMap([{ startTick: 0, numerator: 4, denominator: 4 }], pickupTicks);
}

function findEventIndex(map: MeterMapData, tick: number): number {
  const { events } = map;
  let lo = 0;
  let hi = events.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (events[mid].startTick <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 小节信息。
 *
 * `barLengthTicks` 是这一小节的实际长度，
 * `beatsInBar` 是这一小节有几拍（拍号分子）。
 */
export interface BarInfo {
  /** 小节序号（0 起）。有弱起时弱起小节是第 0 小节 */
  readonly index: number;
  /** 小节起点 tick */
  readonly startTick: number;
  /** 小节长度 tick */
  readonly lengthTicks: number;
  /** 该小节生效的拍号 */
  readonly meter: MeterEvent;
  /** 该小节的拍数（= meter.numerator） */
  readonly beatsInBar: number;
  /** 是否是弱起小节 */
  readonly isPickup: boolean;
}

/**
 * 查询某 tick 所在小节。
 *
 * 实现要点：变拍使小节长度不固定，必须**逐段累加**，不能用除法。
 * 段数通常很少（一首歌 2–5 段），O(段数) 足够。
 */
export function barInfoAt(map: MeterMapData, tick: number): BarInfo {
  assertTick(tick, 'tick');
  const { events, pickupTicks } = map;

  let barsBefore = 0;
  for (let i = 0; i < events.length; i++) {
    const cur = events[i];
    const nxt = events[i + 1];
    const segStart = cur.startTick;
    const segEnd = nxt ? nxt.startTick : Number.POSITIVE_INFINITY;
    const pickup = i === 0 ? pickupTicks : 0;

    if (tick < segEnd) {
      // 落在这一段内
      // 弱起小节
      if (pickup > 0 && tick < segStart + pickup) {
        return {
          index: barsBefore,
          startTick: segStart,
          lengthTicks: pickup,
          meter: cur,
          beatsInBar: cur.numerator,
          isPickup: true,
        };
      }
      const fullBar = barTicks(cur.numerator, cur.denominator);
      const base = segStart + pickup;
      const after = Math.max(0, tick - base);
      const idx = Math.floor(after / fullBar);
      return {
        index: barsBefore + (pickup > 0 ? 1 : 0) + idx,
        startTick: base + idx * fullBar,
        lengthTicks: fullBar,
        meter: cur,
        beatsInBar: cur.numerator,
        isPickup: false,
      };
    }

    // 走完整段，累加小节数
    const pickupCount = pickup > 0 ? 1 : 0;
    const span = segEnd - segStart - pickup;
    if (span <= 0) {
      barsBefore += pickupCount;
      continue;
    }
    const fullBar = barTicks(cur.numerator, cur.denominator);
    const barsInSeg = Math.ceil(span / fullBar);
    barsBefore += pickupCount + barsInSeg;
  }

  throw new Error(`无法定位 tick ${tick}`);
}

export function barAt(map: MeterMapData, tick: number): number {
  return barInfoAt(map, tick).index;
}

export function barStartTick(map: MeterMapData, tick: number): number {
  return barInfoAt(map, tick).startTick;
}

export function barLengthAt(map: MeterMapData, tick: number): number {
  return barInfoAt(map, tick).lengthTicks;
}

export function meterAt(map: MeterMapData, tick: number): MeterEvent {
  return map.events[findEventIndex(map, tick)];
}

/** tick 属于小节内的第几拍（0 起） */
export function beatInBar(map: MeterMapData, tick: number): number {
  const info = barInfoAt(map, tick);
  const beat = beatTicks(info.meter.numerator, info.meter.denominator);
  return Math.floor((tick - info.startTick) / beat);
}

/** 是否是强拍（小节第一拍） */
export function isDownbeat(map: MeterMapData, tick: number): boolean {
  return barInfoAt(map, tick).startTick === tick;
}

/** 某小节序号的起点 tick */
export function tickOfBar(map: MeterMapData, barIndex: number): number {
  if (!Number.isInteger(barIndex) || barIndex < 0) {
    throw new RangeError(`barIndex 必须是非负整数，收到 ${barIndex}`);
  }
  const { events, pickupTicks } = map;

  let remaining = barIndex;
  for (let i = 0; i < events.length; i++) {
    const cur = events[i];
    const nxt = events[i + 1];
    const segStart = cur.startTick;
    const pickup = i === 0 ? pickupTicks : 0;

    if (pickup > 0) {
      if (remaining === 0) return segStart;
      remaining -= 1;
    }

    const fullBar = barTicks(cur.numerator, cur.denominator);
    if (!nxt) {
      return segStart + pickup + remaining * fullBar;
    }

    const span = nxt.startTick - segStart - pickup;
    const barsInSeg = Math.ceil(span / fullBar);
    if (remaining < barsInSeg) {
      return segStart + pickup + remaining * fullBar;
    }
    remaining -= barsInSeg;
  }
  throw new RangeError(`barIndex ${barIndex} 超出范围`);
}

/** 小节线 */
export interface BarLine {
  readonly tick: number;
  readonly barIndex: number;
  /** 该小节起点同时是拍号变更点 */
  readonly isMeterChange: boolean;
  /** 该小节长度（用于渲染变宽/变窄的格子数） */
  readonly lengthTicks: number;
  /** 该小节的拍数 */
  readonly beatsInBar: number;
}

export function barLinesInRange(
  map: MeterMapData,
  startTick: number,
  endTick: number,
  maxBars = 4000,
): BarLine[] {
  const lines: BarLine[] = [];
  const changeTicks = new Set(map.events.map((e) => e.startTick));

  let barIndex = barAt(map, Math.max(0, startTick));
  let guard = 0;

  while (guard++ < maxBars) {
    const info = barInfoAt(map, tickOfBar(map, barIndex));
    if (info.startTick > endTick) break;
    lines.push({
      tick: info.startTick,
      barIndex,
      isMeterChange: changeTicks.has(info.startTick),
      lengthTicks: info.lengthTicks,
      beatsInBar: info.beatsInBar,
    });
    barIndex += 1;
  }
  return lines;
}

/**
 * 某小节内的拍线（不含小节起点本身）。
 *
 * 这就是「尺子上画多少个刻度」的来源：
 * 4/4 → 3 条；3/4 → 2 条；6/8 → 5 条（每拍是八分）。
 */
export function beatLinesInBar(map: MeterMapData, barIndex: number): number[] {
  const start = tickOfBar(map, barIndex);
  const info = barInfoAt(map, start);
  const beat = beatTicks(info.meter.numerator, info.meter.denominator);
  const end = start + info.lengthTicks;

  const out: number[] = [];
  for (let t = start + beat; t < end; t += beat) {
    out.push(t);
  }
  return out;
}

/**
 * 网格格子线（恒为 CELL_TICKS 间隔）。
 *
 * 与 `beatLinesInBar` 的区别：
 *   - 本函数产生**所有** 960 的倍数（视觉网格）
 *   - `beatLinesInBar` 产生该拍号下的**拍**（可能是 480）
 *
 * 渲染时：
 *   - 淡线用格子线（密度恒定）
 *   - 深线用拍线 + 小节线（随拍号变）
 */
export function cellLinesInRange(
  startTick: number,
  endTick: number,
): number[] {
  const first = Math.ceil(startTick / CELL_TICKS) * CELL_TICKS;
  const out: number[] = [];
  for (let t = first; t <= endTick; t += CELL_TICKS) out.push(t);
  // 弱起小节要排除掉不属于任何小节的格子？不需要——格子是纯视觉参考
  return out;
}

/** 追加/替换拍号事件 */
export function withMeterEvent(map: MeterMapData, event: MeterEvent): MeterMapData {
  const next = map.events.filter((e) => e.startTick !== event.startTick);
  next.push(event);
  next.sort((a, b) => a.startTick - b.startTick);
  return createMeterMap(next, map.pickupTicks);
}

export function withoutMeterEvent(map: MeterMapData, startTick: number): MeterMapData {
  if (startTick === 0) {
    throw new RangeError('不能移除 tick 0 的初始拍号');
  }
  const next = map.events.filter((e) => e.startTick !== startTick);
  return createMeterMap(next, map.pickupTicks);
}

/**
 * 校验拍号事件是否都落在小节起点上。
 *
 * 若拍号变在那小节中间，说明数据异常——Viterbi 式的「段内半小节变拍」
 * 会让后续所有小节号的推导变得无法解释。UI 应提示用户修正。
 */
export function validateMeterAlignment(map: MeterMapData): MeterEvent[] {
  const bad: MeterEvent[] = [];
  for (const e of map.events) {
    if (e.startTick === 0) continue;
    // 用「前一事件之后的小节网格」判断
    const prev = meterAt(map, e.startTick - 1);
    // 如果 e.startTick 正好是 prev 的小节起点，则合法
    // 构造一个不含本事件的临时 map 来算
    const temp = createMeterMap(
      map.events.filter((x) => x.startTick < e.startTick),
      map.pickupTicks,
    );
    const info = barInfoAt(temp, e.startTick);
    if (info.startTick !== e.startTick) bad.push(e);
    void prev;
  }
  return bad;
}
