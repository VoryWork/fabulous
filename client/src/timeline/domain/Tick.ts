/**
 * Tick —— 时间轴的基本单位。
 *
 * 规格（PRD §3.1 / §4.2）：
 *   - 960 PPQ（每四分音符 960 tick）
 *   - 整数，禁止浮点
 *   - 区间半开 [start, end)
 *
 * 设计原则：
 *   1. 这是**纯函数模块**，不依赖 DOM、不持有状态、不做 IO。
 *   2. 所有对外暴露的数值都必须是整数（NaN/浮点会被拒绝）。
 *   3. 时间轴的"权威位置"永远是 Tick；秒只在边界处投影。
 */

/** 每四分音符的 tick 数 */
export const PPQ = 960;

/** 合法 tick 上限（约 2^31 / PPQ ≈ 2236962 个四分音符，足够任何作品） */
export const MAX_TICK = 2 ** 31 - 1;

/**
 * 半开区间 [start, end)
 *
 * 用半开而不是闭区间的原因：相邻事件首尾相接时不会重复计入同一个 tick，
 * 统计与渲染都不会出现"边界重叠"。
 */
export interface TickRange {
  readonly start: number;
  readonly end: number;
}

/** 判断是否为合法 tick（整数且在范围内） */
export function isValidTick(t: number): boolean {
  return Number.isInteger(t) && t >= 0 && t <= MAX_TICK;
}

/**
 * 断言 tick 合法，非法时抛错。
 *
 * 这里**故意抛错而不是返回兜底值**：时间轴的坐标错误会一路污染到
 * Snap、约束、存储，越早暴露越好。
 */
export function assertTick(t: number, label = 'tick'): void {
  if (!Number.isInteger(t)) {
    throw new TypeError(`${label} 必须是整数，收到 ${t}`);
  }
  if (t < 0) {
    throw new RangeError(`${label} 不能为负，收到 ${t}`);
  }
  if (t > MAX_TICK) {
    throw new RangeError(`${label} 超出上限 ${MAX_TICK}，收到 ${t}`);
  }
}

/** 创建区间，自动校验 */
export function tickRange(start: number, end: number): TickRange {
  assertTick(start, 'range.start');
  assertTick(end, 'range.end');
  if (end < start) {
    throw new RangeError(`区间 end(${end}) 不能小于 start(${start})`);
  }
  return { start, end };
}

/**
 * 半开区间是否为空。
 * 注意：[a, a) 是空区间，这与"长度为 0 的片段"是等价概念。
 */
export function isEmpty(r: TickRange): boolean {
  return r.end <= r.start;
}

/** 区间长度（tick 数） */
export function length(r: TickRange): number {
  return r.end - r.start;
}

/** 区间是否包含某个 tick（半开：含 start，不含 end） */
export function contains(r: TickRange, t: number): boolean {
  return t >= r.start && t < r.end;
}

/**
 * 两个区间是否**相交**。
 *
 * 半开区间的相交判定：[a,b) 与 [b,c) 不相交。
 * 这一点对"和弦能不能紧挨着摆放"至关重要——紧邻不等于重叠。
 */
export function intersects(a: TickRange, b: TickRange): boolean {
  // 空区间（end === start）不与任何区间相交。
  // 若只写 `a.start < b.end && b.start < a.end`，[500,500) 与 [0,960)
  // 会误判为相交（500<960 && 0<500 两者皆真），所以必须先排除空区间。
  if (a.end <= a.start || b.end <= b.start) return false;
  return a.start < b.end && b.start < a.end;
}

/**
 * 两个区间是否有**重叠部分**（比 intersects 更严格：紧邻不算）。
 *
 * 实际上与 intersects 等价，保留此函数是为了在调用处表达意图。
 */
export function overlaps(a: TickRange, b: TickRange): boolean {
  return intersects(a, b);
}

/** 区间交集；无交集返回 null */
export function intersection(a: TickRange, b: TickRange): TickRange | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

/** 区间并集（取包围盒，不要求相交） */
export function hull(a: TickRange, b: TickRange): TickRange {
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

/** 把 tick 对齐到给定步长的网格（四舍五入） */
export function quantize(tick: number, step: number): number {
  if (step <= 0 || !Number.isInteger(step)) {
    throw new RangeError(`step 必须是正整数，收到 ${step}`);
  }
  return Math.round(tick / step) * step;
}

/** 向下取整到网格 */
export function floorToGrid(tick: number, step: number): number {
  return Math.floor(tick / step) * step;
}

/** 向上取整到网格 */
export function ceilToGrid(tick: number, step: number): number {
  return Math.ceil(tick / step) * step;
}

/** 吸附到最近的目标（用于 SnapEngine 的"最近候选"） */
export function snapToNearest(tick: number, candidates: readonly number[]): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - tick);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** 限制到 [min, max] */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 把区间限制到合法范围 */
export function clampRange(r: TickRange, max: number): TickRange {
  const start = clamp(r.start, 0, max);
  const end = clamp(r.end, 0, max);
  return { start, end: Math.max(start, end) };
}

/** 常见音乐时值的 tick 数（以四分音符为 1） */
export const NOTE_DIVISIONS = {
  whole: PPQ * 4,
  half: PPQ * 2,
  quarter: PPQ,
  eighth: PPQ / 2,
  sixteenth: PPQ / 4,
  tripletEighth: PPQ / 3,
  tripletSixteenth: PPQ / 6,
} as const;

/**
 * 常用吸附步长（以 tick 表示）。
 *
 * PRD §4.5 要求网格吸附支持 1/2、1/3、1/4、1/8 等步长，且用**整数 Tick**。
 * 注意 1/3 拍 = 320 tick（960 / 3），是整数，这正是 960 PPQ 的好处
 * （若用 480 PPQ，1/3 拍 = 160 也是整数；但 960 能同时整除 3、4、6、8）。
 */
export function gridStep(division: 1 | 2 | 3 | 4 | 6 | 8 | 12 | 16): number {
  const step = PPQ / division;
  if (!Number.isInteger(step)) {
    throw new RangeError(`1/${division} 拍无法表示为整数 tick（PPQ=${PPQ}）`);
  }
  return step;
}
