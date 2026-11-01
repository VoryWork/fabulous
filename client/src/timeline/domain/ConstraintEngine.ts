/**
 * ConstraintEngine —— 轨道约束。
 *
 * 规格（PRD §4.7）：
 *
 * | 轨道 | 可移动 | 双端缩放 | 同轨重叠 | 特殊规则 |
 * |---|---|---|---|---|
 * | 绝对和弦 | 是 | 是 | 默认禁止 | `N` 无和弦亦视为事件；移动不得破坏已确认相邻事件 |
 * | 段落结构 | 是（边界操作） | 是 | 同一结构层默认禁止 | 相邻边界可联动；段首附属 Meter Event 需协同更新 |
 * | 调性上下文 | 是 | 是 | 跨分析层允许 | 同一层默认一个主解释；并列假说放不同层 |
 * | 和声级数解释 | 不直接作为独立音响移动 | 有效范围取决于父事件 | 允许多个层同时显示 | 修改解释文本不会移动父和弦 |
 * | 歌词 | 是 | 按句可选 | 可允许 | 不能强制粗量化 |
 * | Tempo/Beat Anchor | 受限 | 不适用 | 不允许时间倒序 | 严格单调 |
 *
 * **本模块是唯一裁决者** —— 组件层不得散落一套相互矛盾的检查规则。
 */

import { PPQ, intersects as intersectsRange, type TickRange } from './Tick';

/** 轨道类型 */
export type TrackKindC =
  | 'chord'
  | 'section'
  | 'key'
  | 'degree'
  | 'lyric'
  | 'tempo';

/** 约束配置 */
export interface TrackConstraint {
  /** 是否可整体移动 */
  readonly movable: boolean;
  /** 左边界可拖 */
  readonly resizableLeft: boolean;
  /** 右边界可拖 */
  readonly resizableRight: boolean;
  /** 同轨允许重叠 */
  readonly allowOverlap: boolean;
  /** 最小长度（tick）；0 表示只要求 end > start */
  readonly minLengthTicks: number;
}

/** 最小长度默认值：1 拍（960 tick） */
export const MIN_LENGTH_TICKS = PPQ;

const TABLE: Record<TrackKindC, TrackConstraint> = {
  chord: {
    movable: true,
    resizableLeft: true,
    resizableRight: true,
    allowOverlap: false,
    minLengthTicks: PPQ,
  },
  section: {
    movable: true,
    resizableLeft: true,
    resizableRight: true,
    allowOverlap: false,
    minLengthTicks: PPQ,
  },
  key: {
    movable: true,
    resizableLeft: true,
    resizableRight: true,
    // 跨分析层允许重叠：同层不许，跨层允许（由 layerId 决定）
    allowOverlap: true,
    minLengthTicks: PPQ,
  },
  degree: {
    // PRD：不直接作为独立音响移动
    movable: false,
    resizableLeft: false,
    resizableRight: false,
    allowOverlap: true,
    minLengthTicks: 0,
  },
  lyric: {
    movable: true,
    resizableLeft: true,
    resizableRight: true,
    allowOverlap: true,
    minLengthTicks: 1,
  },
  tempo: {
    movable: false,
    resizableLeft: false,
    resizableRight: false,
    allowOverlap: false,
    minLengthTicks: 0,
  },
};

export function constraintFor(kind: TrackKindC): TrackConstraint {
  return TABLE[kind];
}

/** 校验结果 */
export interface ValidationResult {
  readonly ok: boolean;
  /** 不通过的原因（用于 UI 提示） */
  readonly reason?: string;
  /** 若不通过，给出建议的修正值 */
  readonly suggested?: TickRange;
}

export const OK: ValidationResult = { ok: true };

/** 校验一次移动/缩放后的区间是否合法 */
export function validateRange(
  kind: TrackKindC,
  next: TickRange,
  siblings: readonly { id: string; startTick: number; endTick: number }[],
  selfId: string,
): ValidationResult {
  const cfg = constraintFor(kind);

  // 1) 基本合法性
  if (next.start < 0) {
    return { ok: false, reason: '不能早于音频起点' };
  }
  if (next.end <= next.start) {
    return { ok: false, reason: '长度必须为正' };
  }
  if (next.end - next.start < cfg.minLengthTicks) {
    const suggested = { start: next.start, end: next.start + cfg.minLengthTicks };
    return {
      ok: false,
      reason: `最短需要 ${cfg.minLengthTicks / PPQ} 拍`,
      suggested,
    };
  }

  // 2) 重叠检查
  if (!cfg.allowOverlap) {
    for (const s of siblings) {
      if (s.id === selfId) continue;
      const other = { start: s.startTick, end: s.endTick };
      if (intersectsRange(next, other)) {
        return {
          ok: false,
          reason: '与同轨其他事件重叠',
        };
      }
    }
  }

  return OK;
}

/**
 * 接缝拖动的约束检查。
 *
 * 用户拖「左块右边缘 / 右块左边缘」这条接缝时：
 *   - 左块变长、右块变短（时间守恒）
 *   - 右块被压缩到 `minLengthTicks` 时，不能再往左拖（或者提示合并）
 *
 * 返回新的两个区间，或者拒绝原因。
 */
export function validateSeamDrag(
  left: TickRange,
  right: TickRange,
  newSeamTick: number,
  minLengthTicks = MIN_LENGTH_TICKS,
): {
  ok: boolean;
  left?: TickRange;
  right?: TickRange;
  reason?: string;
  /** 再拖就会导致合并 */
  willMerge?: boolean;
} {
  // 接缝必须在左块起点之后、右块终点之前
  if (newSeamTick <= left.start) {
    return { ok: false, reason: '左块会被压到 0 长度' };
  }
  if (newSeamTick >= right.end) {
    return { ok: false, reason: '右块会被压到 0 长度' };
  }
  // 最小长度
  if (newSeamTick - left.start < minLengthTicks) {
    return {
      ok: false,
      reason: '左块太短',
      left: { start: left.start, end: left.start + minLengthTicks },
      right: { start: left.start + minLengthTicks, end: right.end },
    };
  }
  if (right.end - newSeamTick < minLengthTicks) {
    return {
      ok: false,
      reason: '右块太短，继续拖动会合并',
      willMerge: true,
      left: { start: left.start, end: right.end - minLengthTicks },
      right: { start: right.end - minLengthTicks, end: right.end },
    };
  }
  return {
    ok: true,
    left: { start: left.start, end: newSeamTick },
    right: { start: newSeamTick, end: right.end },
  };
}

/**
 * 单边 Resize 时，右块的让位策略。
 *
 * 两种语义（由 UI 的修饰键决定）：
 *   - `keep`  ：右块不动，可能与左块重叠 → 由 allowOverlap 决定是否允许
 *   - `push`  ：右块整体右移，腾出空间（不改变右块长度）
 *   - `shrink`：右块变短（就是接缝拖动）
 */
export type NeighborPolicy = 'keep' | 'push' | 'shrink';

export function applyNeighborPolicy(
  left: TickRange,
  right: TickRange,
  policy: NeighborPolicy,
): { left: TickRange; right: TickRange; ok: boolean; reason?: string } {
  switch (policy) {
    case 'keep':
      return { left, right, ok: left.end <= right.start };
    case 'push': {
      const rightLen = right.end - right.start;
      const newStart = Math.max(left.end, right.start);
      return {
        left,
        right: { start: newStart, end: newStart + rightLen },
        ok: true,
      };
    }
    case 'shrink': {
      if (left.end >= right.end) {
        return { left, right, ok: false, reason: '右块会被压到 0 长度' };
      }
      return { left, right: { start: Math.max(left.end, right.start), end: right.end }, ok: true };
    }
  }
}

/**
 * 判断某轨道能否接受"新建"
 */
export function canCreate(kind: TrackKindC): boolean {
  return kind !== 'degree' && kind !== 'tempo';
}

/** 判断某轨道能否删除 */
export function canDelete(kind: TrackKindC): boolean {
  return kind !== 'degree';
}

/**
 * 级数解释的可编辑性。
 *
 * PRD §4.7：「修改解释文本不会移动父和弦；事件调整后投影重算」
 * 所以级数解释是「时间只读、文本可编辑」。
 */
export interface DegreeEditability {
  readonly canEditText: boolean;
  readonly canMoveTime: boolean;
  readonly canChangeLayer: boolean;
  readonly canDelete: boolean;
}

export const DEGREE_EDITABILITY: DegreeEditability = {
  canEditText: true,
  canMoveTime: false,
  canChangeLayer: true,
  canDelete: true,
};
