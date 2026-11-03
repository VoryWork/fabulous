/**
 * useClipEditing —— 片段编辑的响应式封装。
 *
 * 把「手势 + 约束 + 吸附 + 历史」串起来，给 TimelineView 一个干净的接口。
 *
 * 分层关系：
 *   GestureStateMachine  纯函数：算预览、出命令
 *   EditCommands         纯函数：造命令、撤销栈
 *   ConstraintEngine     纯函数：校验
 *   → 本 composable     有状态：持有当前预览、历史栈、选中项
 *   → TimelineView      渲染
 *
 * 关键约定：
 *   - **拖动中只改 `preview`，不改真实数据**（PRD §4.4 第 4 条）
 *   - 松手才 `commit()` → 写历史 + 改真实数据
 *   - Escape / cancel → 直接丢弃 preview，什么都不动
 */

import { computed, ref, shallowRef } from 'vue';
import type { TickRange } from '../domain/Tick';
import { PPQ } from '../domain/Tick';
import {
  applyPreview,
  beginGesture,
  commitGesture,
  computePreview,
  crossedThreshold,
  activate,
  hitTest,
  reset,
  IDLE_CONTEXT,
  type GestureContext,
  type GesturePreview,
  type HitTarget,
} from './GestureStateMachine';
import {
  DEFAULT_SNAP_CONFIG,
  collectEventTicks,
  collectBarTicks,
  type SnapConfig,
} from '../domain/SnapEngine';
import type { TrackKindC } from '../domain/ConstraintEngine';
import { canCreate, canDelete, constraintFor } from '../domain/ConstraintEngine';
import {
  commit as commitHistory,
  createHistory,
  canRedo,
  canUndo,
  makeCreateCommand,
  makeDeleteManyCommand,
  makeSetLabelCommand,
  makeSetStateCommand,
  redo as redoHistory,
  undo as undoHistory,

  cascadeDelete,
  type ClipState,
  type HistoryState,
} from '../domain/EditCommands';

export interface UseClipEditingOptions {
  /** 初始片段（按轨道分组） */
  tracks: { id: string; kind: TrackKindC; clips: ClipState[] }[];
  /** tick → 像素 */
  toX: (tick: number) => number;
  /** 像素 → tick */
  xToTick: (x: number) => number;
  /** 当前缩放 */
  pixelsPerTick: () => number;
  /** 当前横向滚动（tick） */
  scrollTick: () => number;
  /** 小节起点（吸附候选） */
  barStarts: () => number[];
  /**
   * 只读模式（歌曲正在分析时）。
   *
   * **必须在编辑层拦，不能只靠 UI 禁用**：编辑有 5 条入口
   * （双击空白新建、拖拽移动、边缘拖拽改长、Delete 删除、右键菜单），
   * 只灰掉按钮会漏。这里在**写操作入口**统一拦，一条都进不来。
   *
   * 只读是**动态**的：分析完成后传 false，编辑立刻恢复，
   * 不需要重建编辑层（那会丢掉撤销历史）。
   */
  readonly?: () => boolean;
}

export function useClipEditing(opt: UseClipEditingOptions) {
  // ---- 数据 ----
  const clipsByTrack = ref<Record<string, ClipState[]>>(
    Object.fromEntries(opt.tracks.map((t) => [t.id, t.clips.map((c) => ({ ...c }))])),
  );
  const trackKindById = Object.fromEntries(opt.tracks.map((t) => [t.id, t.kind]));
  /**
   * 当前存在于编辑层的级数轨 id。
   *
   * 用于 `syncDerivedTracks` 判断哪些轨是「被删掉了」——
   * 不能靠 `trackKindById`，那是 setup 时快照，新增的级数轨不在里面。
   */
  let previousDegreeIds = new Set(
    // 派生轨 = 级数轨 + 歌词轨（用户新建的附加轨），增删走 syncDerivedTracks
    opt.tracks
      .filter((t) => t.kind === 'degree' || t.kind === 'lyric')
      .map((t) => t.id),
  );

  // ---- 选择 ----
  const selectedId = ref<string | null>(null);

  // ---- 手势 ----
  const gesture = shallowRef<GestureContext>(IDLE_CONTEXT);
  const preview = shallowRef<GesturePreview | null>(null);
  /** 拖动开始时的数据快照，用于 Escape 恢复 */
  let dragSnapshot: ClipState[][] = [];

  // ---- 历史 ----
  const history = ref<HistoryState>(createHistory(100));

  // ---- 吸附配置 ----
  const snapConfig = ref<SnapConfig>(DEFAULT_SNAP_CONFIG);

  /**
   * 是否允许写入。分析中一律 false。
   *
   * 用函数而不是布尔值：`readonly` 是外部 state 的读取器，
   * 每次调用取最新值，编辑层不需要自己在 watch 里同步。
   */
  const canWrite = () => !(opt.readonly?.() ?? false);

  // ---- 渲染用的有效片段（预览优先） ----
  const effectiveClips = computed<Record<string, ClipState[]>>(() => {
    const p = preview.value;
    if (!p) return clipsByTrack.value;
    const out: Record<string, ClipState[]> = {};
    for (const [tid, clips] of Object.entries(clipsByTrack.value)) {
      out[tid] = applyPreview(clips, p);
    }
    return out;
  });

  /** 某个片段的当前有效区间 */
  function rangeOf(clip: ClipState): TickRange {
    const p = preview.value;
    const r = p?.ranges[clip.id];
    return r ?? { start: clip.startTick, end: clip.endTick };
  }

  /**
   * 级数解释的**有效时间范围** —— 从父和弦投影。
   *
   * 这是「级数跟随和弦编辑」的核心：
   *   - rangeOf(parent) 已经包含了拖动中的**预览**值
   *   - 所以拖动父和弦时，级数块实时跟着动
   *   - 撤销时父和弦回退，级数自动回退（零额外代码）
   *
   * 父和弦不存在时（数据异常），退化为级数自身存的 tick，避免整块消失。
   */
  function projectedRange(clip: ClipState): TickRange {
    if (!clip.parentId) return rangeOf(clip);
    const parent = clipById(clip.parentId);
    if (!parent) return rangeOf(clip);
    return rangeOf(parent);
  }

  /** 找到片段所属轨道 id */
  function trackIdOf(clipId: string): string | null {
    for (const [tid, clips] of Object.entries(clipsByTrack.value)) {
      if (clips.some((c) => c.id === clipId)) return tid;
    }
    return null;
  }

  function clipById(id: string): ClipState | null {
    for (const clips of Object.values(clipsByTrack.value)) {
      const c = clips.find((x) => x.id === id);
      if (c) return c;
    }
    return null;
  }

  // ---------------------------------------------------------------- 指针按下

  function onPointerDown(
    trackId: string,
    x: number,
    y: number,
    clientX: number,
    mods: { alt: boolean; shift: boolean },
  ) {
    // 只读时**根本不开手势**：开了之后 onPointerMove 会持续改 preview，
    // 屏幕上会出现「拖得动但松手弹回」的假象，比不能拖更让人困惑。
    if (!canWrite()) return;
    const clips = clipsByTrack.value[trackId] ?? [];
    const target: HitTarget = hitTest(clips, x, opt.toX);

    // shift = 单边模式（不联动邻居，只改自己）
    const altMode = mods.shift;

    gesture.value = beginGesture(target, {
      x,
      y,
      clientX,
      scrollTick: opt.scrollTick(),
      pixelsPerTick: opt.pixelsPerTick(),
      altKey: mods.alt,
      altMode,
    });

    if (target.type === 'body' || target.type === 'leftHandle' || target.type === 'rightHandle') {
      selectedId.value = target.clip.id;
    } else if (target.type === 'seam') {
      selectedId.value = target.left.id;
    } else {
      selectedId.value = null;
    }

    // 拍快照，供 Escape 恢复
    dragSnapshot = Object.values(clipsByTrack.value).map((arr) => arr.map((c) => ({ ...c })));

    return gesture.value;
  }

  // ---------------------------------------------------------------- 指针移动

  function onPointerMove(x: number, mods: { alt: boolean }) {
    const g = gesture.value;
    if (g.phase === 'idle') return;

    // pending → active
    if (g.phase === 'pending') {
      if (!crossedThreshold(g, x)) return;
      gesture.value = activate({ ...g, altKey: mods.alt });
    } else {
      // 更新 alt（用户可能在拖动中按下/松开 Alt）
      if (gesture.value.altKey !== mods.alt) {
        gesture.value = { ...gesture.value, altKey: mods.alt };
      }
    }

    const ctx = gesture.value;
    if (!ctx.primary) return;

    const trackId = trackIdOf(ctx.primary.id);
    if (!trackId) return;
    const kind = trackKindById[trackId] ?? 'chord';
    const siblings = clipsByTrack.value[trackId] ?? [];

    // 事件边界候选（排除自己）
    const eventTicks = collectEventTicks(
      siblings.map((c) => ({ id: c.id, startTick: c.startTick, endTick: c.endTick })),
      ctx.kind === 'seam' ? null : ctx.primary.id,
    );

    const cfg: SnapConfig = {
      ...snapConfig.value,
      eventTicks,
      markerTicks: collectBarTicks(opt.barStarts()),
    };

    preview.value = computePreview(ctx, {
      x,
      pixelsPerTick: opt.pixelsPerTick(),
      scrollTick: opt.scrollTick(),
      toX: opt.toX,
      xToTick: opt.xToTick,
      snapCfg: cfg,
      siblings,
      trackKind: kind,
    });
  }

  // ---------------------------------------------------------------- 指针抬起

  function onPointerUp(): { committed: boolean; description?: string } {
    const g = gesture.value;
    const p = preview.value;

    if (g.phase === 'active' && p && g.primary) {
      const cmd = commitGesture(g, p);
      if (cmd) {
        // 写历史
        history.value = commitHistory(history.value, cmd);
        // 落实数据
        const txId = trackIdOf(cmd.after.clips[Object.keys(cmd.after.clips)[0]]?.id ?? '');
        // 逐条应用（可能跨 track，但实际只会是同轨）
        for (const after of Object.values(cmd.after.clips)) {
          for (const [tid, arr] of Object.entries(clipsByTrack.value)) {
            const idx = arr.findIndex((c) => c.id === after.id);
            if (idx >= 0) {
              const next = [...arr];
              next[idx] = { ...after };
              clipsByTrack.value = { ...clipsByTrack.value, [tid]: next };
              break;
            }
          }
        }
        void txId;
        cleanupGesture();
        return { committed: true, description: cmd.description };
      }
    }

    cleanupGesture();
    return { committed: false };
  }

  /** Escape / pointercancel / 失焦 */
  function cancelGesture() {
    if (gesture.value.phase === 'active' && dragSnapshot.length) {
      // 恢复快照
      clipsByTrack.value = Object.fromEntries(
        dragSnapshot.map((arr) => [trackIdOf(arr[0]?.id ?? '') ?? '', arr]).filter(([k]) => k),
      );
    }
    cleanupGesture();
  }

  function cleanupGesture() {
    gesture.value = reset();
    preview.value = null;
    dragSnapshot = [];
  }

  // ---------------------------------------------------------------- 撤销 / 重做

  function undo() {
    if (!canWrite()) return false;
    const r = undoHistory(history.value);
    if (!r.snapshot || !r.command) return false;
    history.value = r.history;
    // 撤销 = 恢复 before；after 有而 before 没有的 id 需要删除（CreateClip 的情况）
    applyTransition(r.command.after.clips, r.command.before.clips);
    return true;
  }

  function redo() {
    if (!canWrite()) return false;
    const r = redoHistory(history.value);
    if (!r.snapshot || !r.command) return false;
    history.value = r.history;
    // 重做 = 恢复 after；before 有而 after 没有的 id 需要删除（DeleteClip 的情况）
    applyTransition(r.command.before.clips, r.command.after.clips);
    return true;
  }

  /**
   * 从 `from` 状态过渡到 `to` 状态。
   *
   * 关键：`from` 里有、`to` 里没有的 id → **删除**（这就是 Create 的撤销）；
   *      `to` 里有的 → 覆盖或新增。
   *
   * 之前这里写错了（只做覆盖不做删除），导致撤销「新建」无效、
   * 撤销「删除」也恢复不回来。
   */
  function applyTransition(
    from: Record<string, ClipState>,
    to: Record<string, ClipState>,
  ) {
    const next: Record<string, ClipState[]> = {};
    for (const [tid, arr] of Object.entries(clipsByTrack.value)) {
      next[tid] = [...arr];
    }

    // 1) 删除：from 有、to 没有
    for (const id of Object.keys(from)) {
      if (to[id]) continue;
      for (const tid of Object.keys(next)) {
        const i = next[tid].findIndex((c) => c.id === id);
        if (i >= 0) {
          next[tid].splice(i, 1);
          break;
        }
      }
    }

    // 2) 覆盖 / 新增
    for (const state of Object.values(to)) {
      let placed = false;
      for (const tid of Object.keys(next)) {
        const i = next[tid].findIndex((c) => c.id === state.id);
        if (i >= 0) {
          next[tid][i] = { ...state };
          placed = true;
          break;
        }
      }
      if (!placed) {
        const tid = state.trackId;
        if (next[tid]) next[tid] = [...next[tid], { ...state }];
      }
    }

    clipsByTrack.value = next;
  }

  // ---------------------------------------------------------------- CRUD

  let crudSeq = 0;
  function newId(prefix: string) {
    crudSeq += 1;
    return `${prefix}-${Date.now().toString(36)}-${crudSeq}`;
  }

  /** 在空白处新建（默认 1 小节） */
  /**
   * 在某处新建一个块。
   *
   * `lengthTicks` 默认 1 小节（4 拍）。结构段要传更大的值 ——
   * 一段 Bridge 只有 1 小节毫无意义，用户还得再拖半天。
   */
  function createAt(
    trackId: string,
    startTick: number,
    label = 'N',
    lengthTicks?: number,
  ): ClipState | null {
    if (!canWrite()) return null;
    const kind = trackKindById[trackId];
    if (!kind || !canCreate(kind)) return null;

    /**
     * **新建也必须满足不重叠**。
     *
     * 拖动手势有 `validateClipChange` 把关，但新建这条路原来是直接
     * 往数组里 push —— 于是可以在一块中间再插一块，结构段就叠起来了。
     *
     * 这里的策略不是「重叠就拒绝」（用户点了没反应很困惑），而是
     * **往后找最近的空位**并自动收缩长度。
     */
    const cfg = constraintFor(kind);
    const list = clipsByTrack.value[trackId] ?? [];
    let start = Math.round(startTick / PPQ) * PPQ;
    const wantLen = lengthTicks && lengthTicks > 0 ? lengthTicks : 4 * PPQ;
    let end = start + wantLen;

    if (!cfg.allowOverlap) {
      const sorted = [...list].sort((a, b) => a.startTick - b.startTick);
      // 1) 起点落在某个块内部 → 挪到那个块的末尾
      let moved = true;
      while (moved) {
        moved = false;
        for (const c of sorted) {
          if (start >= c.startTick && start < c.endTick) {
            start = c.endTick;
            moved = true;
          }
        }
      }
      // 2) 长度不超过「到下一个块起点」的距离
      const next = sorted.find((c) => c.startTick >= start);
      if (next) end = Math.min(end, next.startTick);
      // 3) 剩下的空隙连最短长度都放不下 → 放弃（不制造重叠）
      if (end - start < Math.max(cfg.minLengthTicks, PPQ)) return null;
    }
    const clip: ClipState = {
      id: newId('clip'),
      trackId,
      startTick: start,
      endTick: end,
      label,
      state: 'draft',
    };
    const cmd = makeCreateCommand(clip);
    history.value = commitHistory(history.value, cmd);
    clipsByTrack.value = {
      ...clipsByTrack.value,
      [trackId]: [...(clipsByTrack.value[trackId] ?? []), clip],
    };
    selectedId.value = clip.id;
    return clip;
  }

  /** 删除（留下空隙，不回填邻居） */
  function deleteClip(id: string): boolean {
    if (!canWrite()) return false;
    const tid = trackIdOf(id);
    if (!tid) return false;
    const kind = trackKindById[tid];
    if (!kind || !canDelete(kind)) return false;

    const clip = clipsByTrack.value[tid].find((c) => c.id === id);
    if (!clip) return false;

    /**
     * 删除和弦时**级联删除**它的级数解释。
     * 理由：级数脱离父事件就没有时间锚点，留下只能显示孤儿。
     */
    const all = Object.values(clipsByTrack.value).flat();
    const toDelete = new Set(cascadeDelete(all, [id]));
    // 快照必须包含级联删除的全部实体，否则撤销只能恢复和弦、级数丢失
    const deleted = all.filter((c) => toDelete.has(c.id));

    const nextTracks: Record<string, ClipState[]> = {};
    for (const [key, arr] of Object.entries(clipsByTrack.value)) {
      nextTracks[key] = arr.filter((c) => !toDelete.has(c.id));
    }
    clipsByTrack.value = nextTracks;

    const cmd = makeDeleteManyCommand(deleted);
    history.value = commitHistory(history.value, cmd);
    if (selectedId.value && toDelete.has(selectedId.value)) selectedId.value = null;
    return true;
  }

  /** 改文本（和弦名 / 级数解释） */
  function setLabel(id: string, label: string, sublabel?: string): boolean {
    if (!canWrite()) return false;
    const tid = trackIdOf(id);
    if (!tid) return false;
    const clip = clipsByTrack.value[tid].find((c) => c.id === id);
    if (!clip) return false;
    const cmd = makeSetLabelCommand(clip, label, sublabel);
    history.value = commitHistory(history.value, cmd);
    return applyEditSnapshotAndReturn(cmd.after);
  }

  /**
   * 给结构段设置调性（`undefined` = 清除）。
   *
   * ## 为什么不走撤销历史
   *
   * 撤销栈存的是 `EditCommands` 的增删改快照（`ClipState`），而调性是
   * 结构段独有的附加字段。为了一个字段把整套命令格式扩宽不划算 ——
   * 它是一次性标注动作，误操作重标一遍即可。
   *
   * 直接改 `clipsByTrack` 而不是走 `applyEditSnapshotAndReturn`，
   * 也是因为后者只认 `ClipState` 的字段。
   */
  function setSectionKey(id: string, key?: { tonic: string; mode: 'major' | 'minor' }): boolean {
    if (!canWrite()) return false;
    const tid = trackIdOf(id);
    if (!tid) return false;
    const list = clipsByTrack.value[tid];
    if (!list) return false;
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    const next = [...list];
    next[idx] = { ...next[idx], key } as ClipState;
    clipsByTrack.value = { ...clipsByTrack.value, [tid]: next };
    return true;
  }

  /** 改校对状态 */
  function setState(id: string, state: 'draft' | 'confirmed' | 'rejected'): boolean {
    if (!canWrite()) return false;
    const tid = trackIdOf(id);
    if (!tid) return false;
    const clip = clipsByTrack.value[tid].find((c) => c.id === id);
    if (!clip) return false;
    const cmd = makeSetStateCommand(clip, state);
    history.value = commitHistory(history.value, cmd);
    return applyEditSnapshotAndReturn(cmd.after);
  }

  function applyEditSnapshotAndReturn(snapshot: { clips: Record<string, ClipState> }): boolean {
    applyTransition({}, snapshot.clips);
    return true;
  }

  /** 拆分到某个 tick */
  function splitAt(id: string, tick: number): boolean {
    const tid = trackIdOf(id);
    if (!tid) return false;
    const clip = clipsByTrack.value[tid].find((c) => c.id === id);
    if (!clip) return false;
    if (tick <= clip.startTick || tick >= clip.endTick) return false;

    const left: ClipState = { ...clip, endTick: tick };
    const right: ClipState = {
      ...clip,
      id: newId('clip'),
      startTick: tick,
      state: 'draft',
    };

    /**
     * 拆分后级数解释归谁？
     *
     * 决定：**留在左半**（原 id 保留给左半）。
     * 理由：拆分通常是"前半仍属于原和弦，后半是新的"，
     * 把解释留给前半符合直觉；后半变成 draft 让模型重新给建议。
     */
    const nextTracks: Record<string, ClipState[]> = {};
    for (const [key, arr] of Object.entries(clipsByTrack.value)) {
      nextTracks[key] = arr.flatMap((c) => (c.id === id ? [left, right] : [c]));
    }
    clipsByTrack.value = nextTracks;
    return true;
  }

  /**
   * 合并到下一个和弦。
   *
   * 级数解释归属：**保留左块（cur）的解释，右块（nxt）的级联删除**。
   * 理由：合并是"把右边并进左边"，左边解释继续有效；
   * 右边那条解释失去父事件，必须清掉否则变孤儿。
   */
  function mergeWithNext(id: string): boolean {
    const tid = trackIdOf(id);
    if (!tid) return false;
    const arr = [...clipsByTrack.value[tid]].sort((a, b) => a.startTick - b.startTick);
    const idx = arr.findIndex((c) => c.id === id);
    if (idx < 0 || idx >= arr.length - 1) return false;

    const cur = arr[idx];
    const nxt = arr[idx + 1];
    // 只允许紧邻合并（中间有空隙时合并会产生语义歧义）
    if (cur.endTick !== nxt.startTick) return false;

    const merged: ClipState = { ...cur, endTick: nxt.endTick };

    // 右块及其级数子项一起删
    const all = Object.values(clipsByTrack.value).flat();
    const drop = new Set(cascadeDelete(all, [nxt.id]));

    const nextTracks: Record<string, ClipState[]> = {};
    for (const [key, track] of Object.entries(clipsByTrack.value)) {
      nextTracks[key] = track.filter((c) => !drop.has(c.id));
    }
    // 用合并后的块替换 cur
    nextTracks[tid] = nextTracks[tid].map((c) => (c.id === cur.id ? merged : c));

    clipsByTrack.value = nextTracks;
    selectedId.value = merged.id;
    return true;
  }

  /**
   * 换一批片段（切歌 / 分析结果更新时用）。
   *
   * ## 为什么必须有这个
   *
   * `clipsByTrack` 是**一次性快照**：`useClipEditing()` 在组件 setup 时
   * 用 `opt.tracks` 初始化后就再也不会读了。切歌时 `props.tracks` 变了，
   * 但这里的快照还是上一首歌的 —— 于是时间轴继续画着上一首的和弦，
   * 顶栏却已经是新歌的统计（「737 拍 / 110 和弦段」但一个块都看不见）。
   *
   * 这个 bug 特别难发现：数据完全正常，只是没被用上。
   *
   * 换数据时顺手清掉：
   *   - 选中态（旧的 clipId 在新数据里不存在，留着会让检查器显示错误内容）
   *   - 手势预览（拖到一半切歌，预览会指向已消失的块）
   *   - 撤销历史（跨曲目撤销毫无意义，还会把旧块写回来）
   */
  function resetTracks(tracks: { id: string; kind: TrackKindC; clips: ClipState[] }[]) {
    clipsByTrack.value = Object.fromEntries(
      tracks.map((t) => [
        t.id,
        t.clips.map<ClipState>((c) => ({
          ...c,
          trackId: t.id,
          layer: c.layer ?? t.kind,
        })),
      ]),
    );
    selectedId.value = null;
    preview.value = null;
    gesture.value = IDLE_CONTEXT;
    history.value = createHistory(100);
    previousDegreeIds = new Set(
      tracks
        .filter((t) => t.kind === 'degree' || t.kind === 'lyric')
        .map((t) => t.id),
    );
  }

  /**
   * 只同步**派生轨道**（级数轨），保留主轨道的编辑和撤销历史。
   *
   * ## 为什么不能直接用 resetTracks
   *
   * 级数轨是纯派生数据：每个块的时间范围从父和弦投影、标签从父和弦算，
   * 自身不承载任何用户编辑。而用户在**和弦轨**上的编辑（改名、拖动、
   * 删除）只存在本层里、不回写 props —— 所以一旦 resetTracks：
   *
   *   改一次级数轨调性 → 之前所有和弦编辑 + 撤销历史全部丢失
   *
   * 这跟「会话级」正好相反：会话里的编辑没能活过会话内的操作。
   *
   * ## 判定依据
   *
   * 只有「基础轨道」（和弦 / 段落 / 结构）的 id 或 clip 集合变了，
   * 才说明是**换数据**（切歌、分析结果推进），那时必须 resetTracks。
   * 级数轨的增删改一律走这里。
   */
  function syncDerivedTracks(tracks: { id: string; kind: TrackKindC; clips: ClipState[] }[]) {
    const next = { ...clipsByTrack.value };
    const degreeIds = new Set<string>();
    for (const t of tracks) {
      if (t.kind !== 'degree' && t.kind !== 'lyric') continue;
      degreeIds.add(t.id);
      next[t.id] = t.clips.map<ClipState>((c) => ({
        ...c,
        trackId: t.id,
        layer: c.layer ?? t.kind,
      }));
    }
    // 删掉已经不在数据里的级数轨（用户点了 ×）
    for (const id of previousDegreeIds) {
      if (!degreeIds.has(id)) delete next[id];
    }
    previousDegreeIds = degreeIds;
    clipsByTrack.value = next;
  }

  return {
    // 状态
    clipsByTrack,
    resetTracks,
    syncDerivedTracks,
    effectiveClips,
    selectedId,
    gesture,
    preview,
    history,
    snapConfig,
    // 派生
    rangeOf,
    projectedRange,
    clipById,
    trackIdOf,
    canUndo: computed(() => canUndo(history.value)),
    canRedo: computed(() => canRedo(history.value)),
    // 手势
    onPointerDown,
    onPointerMove,
    onPointerUp,
    cancelGesture,
    // 历史
    undo,
    redo,
    // CRUD
    createAt,
    deleteClip,
    setLabel,
    setSectionKey,
    setState,
    splitAt,
    mergeWithNext,
  };
}
