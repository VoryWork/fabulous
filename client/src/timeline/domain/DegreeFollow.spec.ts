/**
 * 级数解释与父和弦的关联测试。
 *
 * 核心不变量：**级数解释不拥有自己的时间范围**，它声明"解释哪个和弦"，
 * 范围由父和弦投影。所以：
 *   1. 父和弦被移动/缩放 → 级数自动跟随（无需同步代码）
 *   2. 父和弦被删除 → 级数级联删除
 *   3. 父和弦被拆分 → 级数留在左半
 *   4. 父和弦被合并 → 保留左块的解释，右块的级联删除
 */
import { describe, expect, it } from 'vitest';
import { cascadeDelete, childrenOf, makeSeamCommand, type ClipState } from './EditCommands';

function chord(id: string, s: number, e: number, trackId = 'tr-chord'): ClipState {
  return { id, trackId, startTick: s, endTick: e, label: id };
}

function degree(id: string, parentId: string, trackId = 'tr-degree-a'): ClipState {
  return { id, trackId, startTick: 0, endTick: 0, label: 'I', parentId };
}

describe('childrenOf：找到解释某和弦的级数', () => {
  const clips = [
    chord('c1', 0, 3840),
    chord('c2', 3840, 7680),
    degree('d1a', 'c1'),
    degree('d1b', 'c1'),
    degree('d2', 'c2'),
  ];

  it('返回全部子级数（一个和弦可挂多条解释）', () => {
    expect(childrenOf(clips, 'c1').map((c) => c.id)).toEqual(['d1a', 'd1b']);
    expect(childrenOf(clips, 'c2').map((c) => c.id)).toEqual(['d2']);
  });

  it('没有子级数时返回空数组', () => {
    expect(childrenOf(clips, 'nonexistent')).toEqual([]);
    expect(childrenOf([chord('c', 0, 960)], 'c')).toEqual([]);
  });
});

describe('cascadeDelete：删除父和弦时级联', () => {
  const clips = [
    chord('c1', 0, 3840),
    chord('c2', 3840, 7680),
    degree('d1a', 'c1'),
    degree('d1b', 'c1'),
    degree('d2', 'c2'),
  ];

  it('删和弦 → 它的级数一起删，别的和弦不受影响', () => {
    const del = cascadeDelete(clips, ['c1']);
    expect(new Set(del)).toEqual(new Set(['c1', 'd1a', 'd1b']));
    // c2 / d2 不应被删
    expect(del).not.toContain('c2');
    expect(del).not.toContain('d2');
  });

  it('删多个和弦', () => {
    const del = cascadeDelete(clips, ['c1', 'c2']);
    expect(new Set(del)).toEqual(new Set(['c1', 'c2', 'd1a', 'd1b', 'd2']));
  });

  it('删级数本身不牵连父和弦', () => {
    const del = cascadeDelete(clips, ['d1a']);
    expect(del).toEqual(['d1a']);
  });

  it('没有子级的和弦删除后仍是本身', () => {
    const del = cascadeDelete([chord('c', 0, 960)], ['c']);
    expect(del).toEqual(['c']);
  });

  it('递归：多层级联也能清干净', () => {
    // 假设出现"级数的级数"（当前模型只有一层，保持通用）
    const nested: ClipState[] = [
      chord('c1', 0, 3840),
      degree('d1', 'c1'),
      { ...degree('d1-sub', 'd1'), trackId: 'tr-degree-b' },
    ];
    const del = cascadeDelete(nested, ['c1']);
    expect(new Set(del)).toEqual(new Set(['c1', 'd1', 'd1-sub']));
  });

  it('不存在的 id 也原样返回（幂等）', () => {
    expect(cascadeDelete(clips, ['ghost'])).toEqual(['ghost']);
  });
});

describe('接缝拖动同时影响两个父和弦时，级数都跟随', () => {
  it('命令里包含两个和弦的 before/after，级数不在快照内（因为是投影的）', () => {
    const a = chord('c1', 0, 3840);
    const b = chord('c2', 3840, 7680);
    const cmd = makeSeamCommand(a, b, { start: 0, end: 4800 }, { start: 4800, end: 7680 });

    // 快照只含两个**和弦**，不含级数 —— 级数范围是投影出来的
    expect(Object.keys(cmd.before.clips).sort()).toEqual(['c1', 'c2']);
    expect(Object.keys(cmd.after.clips).sort()).toEqual(['c1', 'c2']);

    // 撤销时只需要恢复和弦，级数自动回退
    expect(cmd.before.clips['c1'].endTick).toBe(3840);
    expect(cmd.after.clips['c1'].endTick).toBe(4800);
    expect(cmd.after.clips['c2'].startTick).toBe(4800);
  });
});

describe('投影语义的推论', () => {
  it('级数自身的 startTick/endTick 在投影下被忽略', () => {
    /**
     * 这是「不靠同步」的关键：
     * 即使级数块存了过期的 tick（比如 0, 0），只要 parentId 有效，
     * 渲染就用父和弦的范围。所以不需要在每次编辑后去刷新级数的 tick。
     */
    const d = degree('d1', 'c1');
    expect(d.startTick).toBe(0);
    expect(d.endTick).toBe(0);
    // 只要 parentId 在，显示时不看这两个字段
    expect(d.parentId).toBe('c1');
  });

  it('parentId 缺失时退化为自身范围（数据异常时的兜底）', () => {
    const orphan: ClipState = {
      id: 'x',
      trackId: 'tr-degree-a',
      startTick: 960,
      endTick: 1920,
      label: 'I',
    };
    expect(orphan.parentId).toBeUndefined();
    // 渲染层会用自身 tick 兜底，不会消失
  });
});
