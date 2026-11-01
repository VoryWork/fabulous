/**
 * EditCommands —— 编辑事务与撤销栈。
 *
 * 规格（PRD §4.8）：
 *   - 单一命令：`MoveChord` / `ResizeChord` / `SplitSection` / `SetSectionMeter` …
 *   - 一条命令包含前置校验、受影响实体、`before/after` 快照和可逆操作
 *   - Undo/Redo 保持至少 100 个可用步骤
 *   - 重做链遇到新提交时失效
 *   - **拖动过程中的预览不写历史**，松手才提交一条命令
 *
 * ## 为什么用「全量快照」而不是「增量 patch」
 *
 * 一个拖动可能同时影响多个实体（例如接缝拖动改两个块、移动时触发邻居让位）。
 * 增量 patch 需要精确记录每个字段的新旧值，一旦漏了某个字段，Undo 就会
 * 留下脏数据。而快照只要存前后两份，`applySnapshot` 一次性恢复，
 * 不会有一致性问题。代价是内存，但一首歌几百个和弦事件 × 每次命令几条，
 * 完全可以接受。
 *
 * ## 与其他层的边界
 *
 * - 本模块**不碰存储**：只维护内存态与撤销栈
 * - 提交到后端（SQLite）由 M3 的命令通道负责，届时 `revision` 乐观锁在这里透传
 * - 拖动中的预览由调用方自己管，不经过本模块
 */

import type { TickRange } from './Tick';

/** 单个实体的状态快照 */
export interface ClipState {
  readonly id: string;
  readonly trackId: string;
  readonly startTick: number;
  readonly endTick: number;
  readonly label: string;
  readonly sublabel?: string;
  readonly state?: 'draft' | 'confirmed' | 'rejected';
  /** 分析层（多重解释用） */
  readonly layer?: string;
  /**
   * 级数解释的父和弦事件 id。
   *
   * **这是「级数跟随和弦」的全部实现**：级数解释不拥有自己的时间范围，
   * 它声明"我解释的是哪个和弦"，渲染时从父和弦实时投影出区间。
   *
   * 为什么不在级数上存 startTick/endTick 然后同步：
   *   - 拖动、Resize、接缝、拆分、合并、撤销 —— 每条路径都要写同步代码
   *   - 漏掉任何一条，级数块就会"飘在原地"
   *   - 而投影方案下，撤销父和弦时级数自动跟着回退，**零额外代码**
   *
   * PRD §5.1 的 `DegreeInterpretation { chordEventId }` 就是这个意思。
   */
  readonly parentId?: string;
  /** 被选中和弦的平均概率（只读，来自模型输出，编辑不改变它） */
  readonly confidence?: number;
  /** 备选和弦（只读，按概率降序，含当前选中的） */
  readonly alternatives?: ReadonlyArray<{ readonly chord: string; readonly prob: number }>;
}

/** 一次编辑涉及的完整快照 */
export interface Snapshot {
  /** 受影响的片段（按 id 索引） */
  readonly clips: Readonly<Record<string, ClipState>>;
}

/** 命令类型 */
export type CommandKind =
  | 'MoveClip'
  | 'ResizeLeft'
  | 'ResizeRight'
  | 'SeamDrag'
  | 'CreateClip'
  | 'DeleteClip'
  | 'SetLabel'
  | 'SetState'
  | 'SetLayer';

/** 一条可撤销命令 */
export interface EditCommand {
  readonly id: string;
  readonly kind: CommandKind;
  /** 人类可读的描述，用于撤销提示 */
  readonly description: string;
  readonly before: Snapshot;
  readonly after: Snapshot;
  /** 创建时间戳（调试用） */
  readonly at: number;
  /** 后端乐观锁版本号（M3 使用；前端阶段为 0） */
  readonly revision: number;
}

/** 撤销栈 */
export interface HistoryState {
  readonly undoStack: readonly EditCommand[];
  readonly redoStack: readonly EditCommand[];
  readonly maxSteps: number;
}

export const DEFAULT_MAX_STEPS = 100;

export function createHistory(maxSteps = DEFAULT_MAX_STEPS): HistoryState {
  return { undoStack: [], redoStack: [], maxSteps };
}

/**
 * 提交一条命令。
 *
 * 规则（PRD §4.8）：
 *   - 新提交清空 redo 链
 *   - undo 栈超过上限时丢弃最老的一条
 */
export function commit(history: HistoryState, cmd: EditCommand): HistoryState {
  const nextUndo = [...history.undoStack, cmd];
  // 超过上限丢最老的
  const trimmed =
    nextUndo.length > history.maxSteps
      ? nextUndo.slice(nextUndo.length - history.maxSteps)
      : nextUndo;
  return { ...history, undoStack: trimmed, redoStack: [] };
}

/** 能否撤销 / 重做 */
export function canUndo(h: HistoryState): boolean {
  return h.undoStack.length > 0;
}
export function canRedo(h: HistoryState): boolean {
  return h.redoStack.length > 0;
}

/**
 * 撤销。
 *
 * 返回新的历史状态 + 需要应用的快照（= 命令的 before）。
 */
export function undo(h: HistoryState): {
  history: HistoryState;
  snapshot: Snapshot | null;
  command: EditCommand | null;
} {
  if (!canUndo(h)) return { history: h, snapshot: null, command: null };
  const cmd = h.undoStack[h.undoStack.length - 1];
  return {
    history: {
      ...h,
      undoStack: h.undoStack.slice(0, -1),
      redoStack: [...h.redoStack, cmd],
    },
    snapshot: cmd.before,
    command: cmd,
  };
}

export function redo(h: HistoryState): {
  history: HistoryState;
  snapshot: Snapshot | null;
  command: EditCommand | null;
} {
  if (!canRedo(h)) return { history: h, snapshot: null, command: null };
  const cmd = h.redoStack[h.redoStack.length - 1];
  return {
    history: {
      ...h,
      undoStack: [...h.undoStack, cmd],
      redoStack: h.redoStack.slice(0, -1),
    },
    snapshot: cmd.after,
    command: cmd,
  };
}

// ---------------------------------------------------------------- 命令构造器

let seq = 0;
function nextId(): string {
  seq += 1;
  return `cmd-${Date.now().toString(36)}-${seq}`;
}

function cloneClips(clips: readonly ClipState[]): Record<string, ClipState> {
  const out: Record<string, ClipState> = {};
  for (const c of clips) out[c.id] = { ...c };
  return out;
}

/** 构造一条命令 */
export function makeCommand(
  kind: CommandKind,
  description: string,
  beforeClips: readonly ClipState[],
  afterClips: readonly ClipState[],
  revision = 0,
): EditCommand {
  return {
    id: nextId(),
    kind,
    description,
    before: { clips: cloneClips(beforeClips) },
    after: { clips: cloneClips(afterClips) },
    at: Date.now(),
    revision,
  };
}

/** 移动一个片段 */
export function makeMoveCommand(
  before: ClipState,
  nextRange: TickRange,
  revision = 0,
): EditCommand {
  const after: ClipState = { ...before, startTick: nextRange.start, endTick: nextRange.end };
  return makeCommand('MoveClip', `移动 ${before.label}`, [before], [after], revision);
}

/** 单边 Resize */
export function makeResizeCommand(
  side: 'left' | 'right',
  before: ClipState,
  nextRange: TickRange,
  revision = 0,
): EditCommand {
  const after: ClipState = { ...before, startTick: nextRange.start, endTick: nextRange.end };
  return makeCommand(
    side === 'left' ? 'ResizeLeft' : 'ResizeRight',
    `调整 ${before.label} 的${side === 'left' ? '左' : '右'}边界`,
    [before],
    [after],
    revision,
  );
}

/**
 * 接缝拖动（同时影响左右两个块）。
 *
 * 这是用户最常用的操作：拖两个和弦之间的立缝，左块变长、右块变短。
 */
export function makeSeamCommand(
  beforeLeft: ClipState,
  beforeRight: ClipState,
  nextLeft: TickRange,
  nextRight: TickRange,
  revision = 0,
): EditCommand {
  const afterLeft: ClipState = {
    ...beforeLeft,
    startTick: nextLeft.start,
    endTick: nextLeft.end,
  };
  const afterRight: ClipState = {
    ...beforeRight,
    startTick: nextRight.start,
    endTick: nextRight.end,
  };
  return makeCommand(
    'SeamDrag',
    `调整 ${beforeLeft.label} / ${beforeRight.label} 的接缝`,
    [beforeLeft, beforeRight],
    [afterLeft, afterRight],
    revision,
  );
}

/** 新建 */
export function makeCreateCommand(clip: ClipState, revision = 0): EditCommand {
  return makeCommand('CreateClip', `新建 ${clip.label}`, [], [clip], revision);
}

/** 删除单个 */
export function makeDeleteCommand(clip: ClipState, revision = 0): EditCommand {
  return makeCommand('DeleteClip', `删除 ${clip.label}`, [clip], [], revision);
}

/**
 * 删除多个（级联场景）。
 *
 * 快照必须包含**所有**被删实体，否则撤销时只会恢复主实体，
 * 级联删掉的子项就永久丢失了 —— 这是实测踩到的 bug。
 */
export function makeDeleteManyCommand(clips: readonly ClipState[], revision = 0): EditCommand {
  if (clips.length === 0) throw new RangeError('删除命令至少需要一个实体');
  const main = clips[0];
  const extra = clips.length > 1 ? ` 等 ${clips.length} 项` : '';
  return makeCommand('DeleteClip', `删除 ${main.label}${extra}`, clips, [], revision);
}

/** 改文本（和弦名 / 级数） */
export function makeSetLabelCommand(
  before: ClipState,
  label: string,
  sublabel?: string,
  revision = 0,
): EditCommand {
  const after: ClipState = { ...before, label, sublabel: sublabel ?? before.sublabel };
  return makeCommand('SetLabel', `修改 ${before.label} → ${label}`, [before], [after], revision);
}

/** 改校对状态 */
export function makeSetStateCommand(
  before: ClipState,
  state: 'draft' | 'confirmed' | 'rejected',
  revision = 0,
): EditCommand {
  return makeCommand(
    'SetState',
    `标记 ${before.label} 为 ${state}`,
    [before],
    [{ ...before, state }],
    revision,
  );
}

/** 改分析层（级数解释换调性上下文） */
export function makeSetLayerCommand(
  before: ClipState,
  layer: string,
  revision = 0,
): EditCommand {
  return makeCommand(
    'SetLayer',
    `${before.label} 换到 ${layer} 层`,
    [before],
    [{ ...before, layer }],
    revision,
  );
}

// ---------------------------------------------------------------- 应用快照

/**
 * 把快照应用到片段数组。
 *
 * 语义：
 *   - 快照里**有**的 id：覆盖（或新增，若原数组没有）
 *   - 快照里**没有**但 before 里有：表示这条命令删除了它 → 从数组移除
 *
 * 为了区分"删除"和"新增"，调用方需要传入 before 的 id 集合。
 * 更简单的做法：`applySnapshot` 接受 `removedIds`。
 */
export function applySnapshot(
  clips: readonly ClipState[],
  snapshot: Snapshot,
  removedIds: readonly string[] = [],
): ClipState[] {
  const map = new Map(clips.map((c) => [c.id, c]));

  // 删除
  for (const id of removedIds) map.delete(id);

  // 覆盖 / 新增
  for (const [id, state] of Object.entries(snapshot.clips)) {
    map.set(id, { ...state });
  }

  return [...map.values()];
}

/**
 * 找出所有「解释某个父和弦」的级数片段。
 *
 * 删除父和弦时用它做级联删除；拆分时用它决定级数归属。
 */
export function childrenOf(clips: readonly ClipState[], parentId: string): ClipState[] {
  return clips.filter((c) => c.parentId === parentId);
}

/**
 * 父事件被删除时，它的级数解释怎么办？
 *
 * 决定：**级联删除**。
 * 理由：级数解释脱离父和弦就没有时间锚点，留下来只能显示"孤儿"，
 * 而用户删和弦通常就是想清掉这一段的全部信息。
 * （撤销时因为走快照，会一起回来。）
 */
export function cascadeDelete(
  clips: readonly ClipState[],
  deletedIds: readonly string[],
): string[] {
  const set = new Set(deletedIds);
  // 递归：级数可能有子级数？当前只有一层，但保持通用
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of clips) {
      if (c.parentId && set.has(c.parentId) && !set.has(c.id)) {
        set.add(c.id);
        changed = true;
      }
    }
  }
  return [...set];
}

/**
 * 计算两个快照之间的差异（用于 UI 显示"这次改了什么"）
 */
export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
): { added: ClipState[]; removed: ClipState[]; changed: ClipState[] } {
  const added: ClipState[] = [];
  const removed: ClipState[] = [];
  const changed: ClipState[] = [];

  for (const [id, a] of Object.entries(after.clips)) {
    const b = before.clips[id];
    if (!b) added.push(a);
    else if (
      b.startTick !== a.startTick ||
      b.endTick !== a.endTick ||
      b.label !== a.label ||
      b.state !== a.state ||
      b.layer !== a.layer
    )
      changed.push(a);
  }
  for (const [id, b] of Object.entries(before.clips)) {
    if (!after.clips[id]) removed.push(b);
  }
  return { added, removed, changed };
}
