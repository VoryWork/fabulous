/**
 * GestureStateMachine —— 指针手势状态机。
 *
 * 规格（PRD §4.4）：
 *
 * ```
 * Idle
 *   ├─ pointerdown on clip body ──► PendingMove
 *   ├─ pointerdown on left handle ► PendingResizeLeft
 *   ├─ pointerdown on right handle ► PendingResizeRight
 *   ├─ pointerdown on seam        ► PendingSeam
 *   └─ pointerdown on empty space ► PendingSelection/Pan
 * Pending
 *   ├─ crossed drag threshold ────► ActiveGesture
 *   ├─ pointerup ────────────────► SelectOnly / Idle
 *   └─ cancel/Escape ────────────► Idle
 * ActiveGesture
 *   ├─ pointermove ─► Calculate → Snap → Validate → Preview
 *   ├─ pointerup ───► Commit One Transaction → Idle
 *   └─ cancel/Escape/blur ─► Restore Snapshot → Idle
 * ```
 *
 * ## 三条硬性要求（PRD §4.4）
 *
 * 1. **不累积增量**：每次 pointermove 都从「按下时快照 + 当前指针 + 当前滚动」
 *    重新计算。累积增量会让慢速拖动漂移。
 * 2. **拖动中不写历史**：预览是临时态，pointerup 才提交一条命令。
 * 3. **必须处理** pointercancel / lostpointercapture / Escape / 窗口失焦。
 *
 * ## 为什么接缝（Seam）是独立的手势
 *
 * 用户拖两个块之间的立缝时，语义是「左块变长、右块变短」——
 * 同时改两个实体。这和单边 Resize 是不同的事务，所以单独一种手势。
 */

import type { TickRange } from '../domain/Tick';
import {
  snapRange,
  quantizeToQuantum,
  MIN_QUANTUM_TICKS,
  type SnapConfig,
  type SnapSource,
} from '../domain/SnapEngine';
import {
  validateRange,
  validateSeamDrag,
  type TrackKindC,
} from '../domain/ConstraintEngine';
import {
  makeMoveCommand,
  makeResizeCommand,
  makeSeamCommand,
  type ClipState,
  type EditCommand,
} from '../domain/EditCommands';

/** 手柄宽度（像素）——用于命中测试 */
export const HANDLE_PX = 6;
/** 判定为"拖动"而非"点击"的阈值（像素） */
export const DRAG_THRESHOLD_PX = 3;

export type GestureKind =
  | 'none'
  | 'move'
  | 'resizeLeft'
  | 'resizeRight'
  | 'seam'
  | 'pan'
  | 'select';

export type Phase = 'idle' | 'pending' | 'active';

/** 一次手势的上下文（按下时冻结） */
export interface GestureContext {
  readonly kind: GestureKind;
  readonly phase: Phase;
  /** 按下时的指针 x（相对内容区） */
  readonly startX: number;
  readonly startY: number;
  /** 按下时的指针 x（屏幕坐标，用于跨元素计算） */
  readonly startClientX: number;
  /** 按下时的 scrollTick 快照 */
  readonly startScrollTick: number;
  /** 按下时的像素/ tick */
  readonly startPixelsPerTick: number;
  /** 主片段（move/resize 时是它；seam 时是左块） */
  readonly primary: ClipState | null;
  /** seam 手势的右块 */
  readonly secondary: ClipState | null;
  /** 是否按住了 Alt（取消吸附） */
  readonly altKey: boolean;
  /** 是否按住 Alt（单边模式，不联动邻居） */
  readonly altMode: boolean;
}

/** 拖动中的预览 */
export interface GesturePreview {
  /** 受影响的片段 id → 新的 tick 区间 */
  readonly ranges: Readonly<Record<string, TickRange>>;
  /** 命中的吸附源（画辅助线用） */
  readonly snapSource: SnapSource;
  readonly snapTicks: readonly number[];
  /** 约束拒绝原因（有值时预览显示为"不可放置"） */
  readonly blocked: string | null;
}

export const IDLE_CONTEXT: GestureContext = {
  kind: 'none',
  phase: 'idle',
  startX: 0,
  startY: 0,
  startClientX: 0,
  startScrollTick: 0,
  startPixelsPerTick: 1,
  primary: null,
  secondary: null,
  altKey: false,
  altMode: false,
};

// ---------------------------------------------------------------- 命中测试

/** 命中测试结果 */
export type HitTarget =
  | { type: 'body'; clip: ClipState }
  | { type: 'leftHandle'; clip: ClipState }
  | { type: 'rightHandle'; clip: ClipState }
  | { type: 'seam'; left: ClipState; right: ClipState }
  | { type: 'empty' };

/**
 * 在一条轨道上做命中测试。
 *
 * 优先级：接缝 > 手柄 > 块体 > 空白
 *
 * 为什么接缝优先于手柄：用户明确说"按住标注的部位往左右拖，
 * 使一边更长、一边更短"——那个部位就是两个块的交界处。
 * 如果手柄优先，用户永远命中不了接缝。
 */
export function hitTest(
  clips: readonly ClipState[],
  x: number,
  toX: (tick: number) => number,
  opt: { seamPreferred?: boolean } = {},
): HitTarget {
  // 按起点排序
  const sorted = [...clips].sort((a, b) => a.startTick - b.startTick);

  // 1) 接缝：两个块首尾相接处
  if (opt.seamPreferred !== false) {
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a.endTick !== b.startTick) continue;
      const seamX = toX(a.endTick);
      if (Math.abs(x - seamX) <= HANDLE_PX) {
        return { type: 'seam', left: a, right: b };
      }
    }
  }

  // 2) 手柄 / 块体
  for (const c of sorted) {
    const lx = toX(c.startTick);
    const rx = toX(c.endTick);
    if (x < lx - HANDLE_PX || x > rx + HANDLE_PX) continue;

    if (Math.abs(x - lx) <= HANDLE_PX) return { type: 'leftHandle', clip: c };
    if (Math.abs(x - rx) <= HANDLE_PX) return { type: 'rightHandle', clip: c };
    if (x >= lx && x <= rx) return { type: 'body', clip: c };
  }

  return { type: 'empty' };
}

// ---------------------------------------------------------------- 状态迁移

/** 按下 */
export function beginGesture(
  target: HitTarget,
  opt: {
    x: number;
    y: number;
    clientX: number;
    scrollTick: number;
    pixelsPerTick: number;
    altKey: boolean;
    altMode: boolean;
  },
): GestureContext {
  const base = {
    phase: 'pending' as Phase,
    startX: opt.x,
    startY: opt.y,
    startClientX: opt.clientX,
    startScrollTick: opt.scrollTick,
    startPixelsPerTick: opt.pixelsPerTick,
    altKey: opt.altKey,
    altMode: opt.altMode,
  };

  switch (target.type) {
    case 'body':
      return { ...base, kind: 'move', primary: target.clip, secondary: null };
    case 'leftHandle':
      return { ...base, kind: 'resizeLeft', primary: target.clip, secondary: null };
    case 'rightHandle':
      return { ...base, kind: 'resizeRight', primary: target.clip, secondary: null };
    case 'seam':
      return { ...base, kind: 'seam', primary: target.left, secondary: target.right };
    case 'empty':
      return { ...base, kind: 'select', primary: null, secondary: null };
  }
}

/** 是否已越过拖动阈值 */
export function crossedThreshold(ctx: GestureContext, x: number): boolean {
  return Math.abs(x - ctx.startX) > DRAG_THRESHOLD_PX;
}

/** 进入 active */
export function activate(ctx: GestureContext): GestureContext {
  return { ...ctx, phase: 'active' };
}

/** 回到 idle */
export function reset(): GestureContext {
  return IDLE_CONTEXT;
}

// ---------------------------------------------------------------- 计算预览

/**
 * 把一个区间强制量化到最小单位（1 拍）。
 *
 * 保证：结果 start/end 都是 960 的整数倍，且长度至少 1 拍。
 */
function quantizeRange(r: TickRange): TickRange {
  const start = quantizeToQuantum(r.start);
  let end = quantizeToQuantum(r.end);
  if (end <= start) end = start + MIN_QUANTUM_TICKS;
  return { start, end };
}

/**
 * 根据当前指针位置计算预览。
 *
 * **每次都从 startX + startScrollTick 重新算**，不累积增量（PRD §4.4 第 2 条）。
 */
export function computePreview(
  ctx: GestureContext,
  opt: {
    x: number;
    pixelsPerTick: number;
    scrollTick: number;
    toX: (tick: number) => number;
    xToTick: (x: number) => number;
    snapCfg: SnapConfig;
    siblings: readonly ClipState[];
    trackKind: TrackKindC;
  },
): GesturePreview | null {
  if (!ctx.primary || ctx.phase !== 'active') return null;

  // 指针位移换算成 tick 位移。
  // 注意用**当前** pixelsPerTick 与 scrollTick，而不是按下时的 —— 因为过程中可能滚动了。
  const deltaPx = opt.x - ctx.startX;
  const deltaTick = deltaPx / opt.pixelsPerTick;

  const p = ctx.primary;
  const cfg: SnapConfig = ctx.altKey ? { ...opt.snapCfg, enabled: false } : opt.snapCfg;

  switch (ctx.kind) {
    case 'move': {
      const rawStart = p.startTick + deltaTick;
      const rawEnd = p.endTick + deltaTick;
      const snapped = snapRange(rawStart, rawEnd, 'start', cfg, opt.pixelsPerTick);
      const next = { start: snapped.start, end: snapped.end };

      const v = validateRange(opt.trackKind, next, opt.siblings, p.id);
      return {
        ranges: { [p.id]: quantizeRange(v.suggested ?? next) },
        snapSource: snapped.source,
        snapTicks: snapped.snappedTo != null ? [snapped.snappedTo] : [],
        blocked: v.ok ? null : (v.reason ?? '不可放置'),
      };
    }

    case 'resizeLeft': {
      const rawStart = p.startTick + deltaTick;
      const snapped = snapRange(rawStart, p.endTick, 'start', cfg, opt.pixelsPerTick);
      const next = { start: snapped.start, end: p.endTick };

      const v = validateRange(opt.trackKind, next, opt.siblings, p.id);
      return {
        ranges: { [p.id]: quantizeRange(v.suggested ?? next) },
        snapSource: snapped.source,
        snapTicks: snapped.snappedTo != null ? [snapped.snappedTo] : [],
        blocked: v.ok ? null : (v.reason ?? '不可放置'),
      };
    }

    case 'resizeRight': {
      const rawEnd = p.endTick + deltaTick;
      const snapped = snapRange(p.startTick, rawEnd, 'end', cfg, opt.pixelsPerTick);
      const next = { start: p.startTick, end: snapped.end };

      const v = validateRange(opt.trackKind, next, opt.siblings, p.id);
      return {
        ranges: { [p.id]: quantizeRange(v.suggested ?? next) },
        snapSource: snapped.source,
        snapTicks: snapped.snappedTo != null ? [snapped.snappedTo] : [],
        blocked: v.ok ? null : (v.reason ?? '不可放置'),
      };
    }

    case 'seam': {
      const s = ctx.secondary;
      if (!s) return null;

      const rawSeam = p.endTick + deltaTick;
      // 吸接缝位置
      const snapped = snapRange(rawSeam, rawSeam, 'start', cfg, opt.pixelsPerTick);
      // 接缝位置强制量化到 1 拍（用户要求：最少按一拍量化）
      const seamTick = quantizeToQuantum(snapped.start);

      const v = validateSeamDrag(
        { start: p.startTick, end: p.endTick },
        { start: s.startTick, end: s.endTick },
        seamTick,
      );

      const leftRange = v.left ?? { start: p.startTick, end: seamTick };
      const rightRange = v.right ?? { start: seamTick, end: s.endTick };

      return {
        ranges: {
          [p.id]: leftRange,
          [s.id]: rightRange,
        },
        snapSource: snapped.source,
        snapTicks: snapped.snappedTo != null ? [snapped.snappedTo] : [],
        blocked: v.ok ? null : (v.reason ?? '不可放置'),
      };
    }

    default:
      return null;
  }
}

/** 提交手势，返回一条编辑命令（或 null 表示无变化） */
export function commitGesture(
  ctx: GestureContext,
  preview: GesturePreview,
  revision = 0,
): EditCommand | null {
  if (!ctx.primary) return null;
  const p = ctx.primary;
  const nextP = preview.ranges[p.id];
  if (!nextP) return null;

  // 无实际变化 → 不产生命令
  const unchanged =
    nextP.start === p.startTick && nextP.end === p.endTick &&
    (!ctx.secondary ||
      (preview.ranges[ctx.secondary.id]?.start === ctx.secondary.startTick &&
        preview.ranges[ctx.secondary.id]?.end === ctx.secondary.endTick));
  if (unchanged) return null;

  switch (ctx.kind) {
    case 'move':
      return makeMoveCommand(p, nextP, revision);
    case 'resizeLeft':
      return makeResizeCommand('left', p, nextP, revision);
    case 'resizeRight':
      return makeResizeCommand('right', p, nextP, revision);
    case 'seam': {
      const s = ctx.secondary;
      const nextS = s ? preview.ranges[s.id] : undefined;
      if (!s || !nextS) return null;
      return makeSeamCommand(p, s, nextP, nextS, revision);
    }
    default:
      return null;
  }
}

/**
 * 把预览应用到片段列表（只改内存态，不写历史）。
 *
 * 用于拖动过程中的实时渲染。
 */
export function applyPreview(
  clips: readonly ClipState[],
  preview: GesturePreview,
): ClipState[] {
  return clips.map((c) => {
    const r = preview.ranges[c.id];
    if (!r) return c;
    return { ...c, startTick: r.start, endTick: r.end };
  });
}

/** 恢复快照（Escape / cancel） */
export function restoreSnapshot(
  clips: readonly ClipState[],
  snapshot: readonly ClipState[],
): ClipState[] {
  const map = new Map(snapshot.map((c) => [c.id, c]));
  return clips.map((c) => map.get(c.id) ?? c);
}
