/**
 * 编辑层的数据同步（`resetTracks`）。
 *
 * ## 为什么要有这个测试
 *
 * `useClipEditing` 在 setup 时用 `opt.tracks` 初始化 `clipsByTrack`，
 * 之后**再也不读** `opt.tracks`。这本身是合理的设计（编辑层要有自己的
 * 可变副本），但必须提供一个显式的「换数据」入口。
 *
 * 没有它的时候踩过一个很难查的坑：
 *   歌分析完了（顶栏显示「737 拍 / 110 和弦段」），和弦轨却**一个块都没有**。
 *   因为切歌后 `props.tracks` 已经是新数据，而编辑层快照还停在
 *   「空的」。数据和渲染彻底脱钩，且完全不报错。
 */
import { describe, it, expect } from 'vitest';
import { useClipEditing } from './useClipEditing';
import type { TrackKindC } from '../domain/ConstraintEngine';

function makeEditing(tracks: { id: string; kind: TrackKindC; clips: any[] }[]) {
  return useClipEditing({
    tracks,
    toX: (tick) => tick / 960,
    xToTick: (x) => Math.round(x * 960),
    pixelsPerTick: () => 1 / 960,
    scrollTick: () => 0,
    barStarts: () => [0, 3840, 7680],
  });
}

const chordClip = (id: string, startTick: number, label: string) => ({
  id,
  trackId: 'tr-chord',
  startTick,
  endTick: startTick + 960,
  label,
  state: 'draft' as const,
});

describe('useClipEditing.resetTracks', () => {
  it('初始快照来自 tracks', () => {
    const e = makeEditing([
      { id: 'tr-chord', kind: 'chord', clips: [chordClip('c1', 0, 'C:maj')] },
    ]);
    expect(e.clipsByTrack.value['tr-chord'].length).toBe(1);
    expect(e.clipById('c1')?.label).toBe('C:maj');
  });

  it('换数据后能看到新片段（这是「和弦轨空着」的回归）', () => {
    const e = makeEditing([]);
    // 起初什么都没有（对应"还没分析完"）
    expect(e.clipById('c1')).toBeNull();

    // 分析完成，前端拿到和弦 → 必须调用 resetTracks
    e.resetTracks([
      {
        id: 'tr-chord',
        kind: 'chord',
        clips: [chordClip('c1', 0, 'Ab:maj'), chordClip('c2', 960, 'C#:maj')],
      },
    ]);

    expect(e.clipById('c1')?.label).toBe('Ab:maj');
    expect(e.clipById('c2')?.label).toBe('C#:maj');
    expect(e.clipsByTrack.value['tr-chord'].length).toBe(2);
  });

  it('换数据会清掉选中态（旧 id 在新数据里不存在）', () => {
    const e = makeEditing([
      { id: 'tr-chord', kind: 'chord', clips: [chordClip('c1', 0, 'C:maj')] },
    ]);
    e.selectedId.value = 'c1';
    e.resetTracks([
      { id: 'tr-chord', kind: 'chord', clips: [chordClip('x9', 0, 'G:maj')] },
    ]);
    expect(e.selectedId.value).toBeNull();
  });

  it('换数据会清空撤销历史（跨曲目撤销无意义）', () => {
    const e = makeEditing([
      { id: 'tr-chord', kind: 'chord', clips: [chordClip('c1', 0, 'C:maj')] },
    ]);
    expect(e.canUndo.value).toBe(false);
    e.resetTracks([
      { id: 'tr-chord', kind: 'chord', clips: [chordClip('c2', 0, 'D:maj')] },
    ]);
    expect(e.canUndo.value).toBe(false);
    expect(e.canRedo.value).toBe(false);
  });

  it('逐步换数据（分析中 拍点→和弦）不会残留旧块', () => {
    const e = makeEditing([{ id: 'tr-chord', kind: 'chord', clips: [] }]);
    e.resetTracks([{ id: 'tr-chord', kind: 'chord', clips: [] }]);
    expect(e.clipsByTrack.value['tr-chord'].length).toBe(0);
    e.resetTracks([
      { id: 'tr-chord', kind: 'chord', clips: [chordClip('c1', 0, 'N')] },
    ]);
    expect(e.clipsByTrack.value['tr-chord'].length).toBe(1);
  });
});

/**
 * `syncDerivedTracks` —— 只换级数轨，**保住用户在和弦轨上的编辑**。
 *
 * ## 这个 bug 的由来
 *
 * 原来 `TimelineView` 只有一个 `watch(() => props.tracks, ..., { deep: true })`，
 * 任何 tracks 变化都 `resetTracks`。而 `allTracks` 是 computed：
 * 用户改一次级数轨调性 → `patchCurrentEdits` → `allTracks` 重算 → 触发 watch
 * → **之前所有和弦改名/拖动/删除 + 撤销历史全部丢失**。
 *
 * 用户的原话是「所有可保存的信息都不是全局的，而是会话级的」——
 * 会话里的编辑没能活过会话内的操作，正好违背这条。
 */
describe('useClipEditing.syncDerivedTracks', () => {
  const degreeClip = (id: string, parentId: string) => ({
    id,
    trackId: 'deg-1',
    startTick: 0,
    endTick: 960,
    label: '',
    parentId,
    state: 'draft' as const,
  });

  const baseTracks = () => [
    { id: 'tr-chord', kind: 'chord' as TrackKindC, clips: [chordClip('c1', 0, 'C:maj')] },
    { id: 'deg-1', kind: 'degree' as TrackKindC, clips: [degreeClip('d1', 'c1')] },
  ];

  it('改级数轨后，和弦轨的编辑仍然在', () => {
    const e = makeEditing(baseTracks());
    expect(e.setLabel('c1', 'G:7')).toBe(true);

    // 模拟「用户改了级数轨调性」→ 上层重算 tracks → 调 syncDerivedTracks
    const next = baseTracks();
    next[1] = { id: 'deg-1', kind: 'degree' as TrackKindC, clips: [degreeClip('d1', 'c1')] };
    e.syncDerivedTracks(next);

    expect(e.clipById('c1')?.label).toBe('G:7');
  });

  it('改级数轨后，撤销历史仍然在', () => {
    const e = makeEditing(baseTracks());
    e.setLabel('c1', 'G:7');
    expect(e.canUndo.value).toBe(true);

    e.syncDerivedTracks(baseTracks());

    expect(e.canUndo.value).toBe(true);
    e.undo();
    expect(e.clipById('c1')?.label).toBe('C:maj');
  });

  it('新增一条级数轨会出现在编辑层', () => {
    const e = makeEditing(baseTracks());
    const next = [
      ...baseTracks(),
      { id: 'deg-2', kind: 'degree' as TrackKindC, clips: [degreeClip('d2', 'c1')] },
    ];
    e.syncDerivedTracks(next);

    expect(e.clipById('d2')).toBeTruthy();
  });

  it('删掉一条级数轨会从编辑层移除', () => {
    const e = makeEditing(baseTracks());
    e.syncDerivedTracks([baseTracks()[0]]);
    expect(e.clipById('d1')).toBeNull();
  });

  it('对比：resetTracks 会清掉编辑和撤销历史（这是它的职责）', () => {
    const e = makeEditing(baseTracks());
    e.setLabel('c1', 'G:7');
    expect(e.canUndo.value).toBe(true);

    e.resetTracks(baseTracks());

    expect(e.clipById('c1')?.label).toBe('C:maj');
    expect(e.canUndo.value).toBe(false);
  });
});

/**
 * 新建块也必须**不重叠**。
 *
 * ## 为什么单独测
 *
 * 拖动手势有 `validateClipChange` 把关，所以「拖到别人身上」是被挡住的。
 * 但新建走的是另一条路（直接在数组里 push），原来完全没有检查 ——
 * 于是可以在一块中间再插一块，结构段就叠起来了。
 *
 * 用户的要求是「结构段不能叠」。这里的策略不是拒绝（点了没反应很困惑），
 * 而是**往后找最近的空位**并自动收缩。
 */
describe('useClipEditing.createAt 不重叠', () => {
  const sec = (id: string, startTick: number, endTick: number) => ({
    id,
    trackId: 'tr-sec',
    startTick,
    endTick,
    label: 'Verse',
    state: 'draft' as const,
  });

  const build = () =>
    makeEditing([
      { id: 'tr-sec', kind: 'section' as TrackKindC, clips: [sec('s1', 0, 3840)] },
    ]);

  it('起点落在已有块内部 → 挪到该块末尾', () => {
    const e = build();
    const c = e.createAt('tr-sec', 1920, 'Chorus', 3840);
    expect(c).not.toBeNull();
    expect(c!.startTick).toBe(3840);
    // 原块没被改动
    expect(e.clipById('s1')!.endTick).toBe(3840);
  });

  it('长度会被「到下一个块起点」截断', () => {
    const e = makeEditing([
      {
        id: 'tr-sec',
        kind: 'section' as TrackKindC,
        clips: [sec('s1', 0, 1920), sec('s2', 3840, 5760)],
      },
    ]);
    const c = e.createAt('tr-sec', 1920, 'Chorus', 3840);
    expect(c).not.toBeNull();
    expect(c!.startTick).toBe(1920);
    expect(c!.endTick).toBe(3840); // 被 s2 的起点挡住
  });

  it('空隙连一拍都放不下 → 放弃（不制造重叠）', () => {
    const e = makeEditing([
      {
        id: 'tr-sec',
        kind: 'section' as TrackKindC,
        clips: [sec('s1', 0, 1920), sec('s2', 2880, 5760)],
      },
    ]);
    // 1920~2880 只有 960 tick = 1 拍，够；再往上挤就不行
    expect(e.createAt('tr-sec', 1920, 'Chorus', 3840)!.endTick).toBe(2880);

    const e2 = makeEditing([
      {
        id: 'tr-sec',
        kind: 'section' as TrackKindC,
        clips: [sec('s1', 0, 1920), sec('s2', 2400, 5760)],
      },
    ]);
    // 1920~2400 只有 480 tick < 1 拍 → 放弃
    expect(e2.createAt('tr-sec', 1920, 'Chorus', 3840)).toBeNull();
  });

  it('新建后同轨内没有任何重叠', () => {
    const e = build();
    e.createAt('tr-sec', 1920, 'Chorus', 3840);
    const list = e.clipsByTrack.value['tr-sec'].slice().sort((a, b) => a.startTick - b.startTick);
    for (let i = 1; i < list.length; i++) {
      expect(list[i].startTick).toBeGreaterThanOrEqual(list[i - 1].endTick);
    }
  });
});
