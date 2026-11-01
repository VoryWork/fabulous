/**
 * 「按歌曲隔离」的回归测试。
 *
 * ## 这一类 bug 的特征
 *
 * 单曲场景永远是对的，**只有切歌才暴露**。所以单测、手动点一遍都发现不了，
 * 要专门写「先 A 再 B」的序列测试。
 *
 * 本项目踩过两次：
 *
 *   1. `keyOverride` 写成单个 ref → 在 A 歌设 A 小调，切到 B 歌，
 *      B 歌的调性也被改成了 A 小调；改回去 A 歌也跟着变。
 *   2. `extraDegreeTracks` 写成全局数组 → A 歌上加的对照轨出现在 B 歌，
 *      而且是按 A 歌和弦算的级数，`parentId` 全部对不上，整条轨显示 `—`。
 *
 * 这里测的是**数据模型**（Record<songId, …>），不是组件 —— 组件只是读它。
 */
import { describe, expect, it } from 'vitest';
import { makeDegreeTrack, type RealClip } from './realData';

type KeyVal = { tonic: string; mode: 'major' | 'minor' };

/**
 * 复刻 App.vue 里 `keyOverrides` 的读写语义。
 *
 * 单独抽出来是为了能测「切歌后读到的是哪个」——
 * 直接测 ref 需要挂 Vue 运行时，收益不大。
 */
function makeKeyStore() {
  let store: Record<string, KeyVal> = {};
  return {
    set(songId: string | null, v: KeyVal) {
      if (!songId) return;
      store = { ...store, [songId]: v };
    },
    get(songId: string | null): KeyVal | null {
      if (!songId) return null;
      return store[songId] ?? null;
    },
    reset(songId: string | null) {
      if (!songId || !(songId in store)) return;
      const next = { ...store };
      delete next[songId];
      store = next;
    },
    drop(songId: string) {
      const next = { ...store };
      delete next[songId];
      store = next;
    },
    all: () => store,
  };
}

describe('调性覆盖按歌曲隔离', () => {
  it('在 A 歌设的调性不影响 B 歌', () => {
    const s = makeKeyStore();
    s.set('songA', { tonic: 'A', mode: 'minor' });

    expect(s.get('songA')).toEqual({ tonic: 'A', mode: 'minor' });
    // 关键断言：B 歌必须是 null（走自动推断），不能被 A 的值污染
    expect(s.get('songB')).toBeNull();
  });

  it('切回 A 歌时仍能读到原来的设置', () => {
    const s = makeKeyStore();
    s.set('songA', { tonic: 'A', mode: 'minor' });
    s.set('songB', { tonic: 'D', mode: 'major' });

    expect(s.get('songA')).toEqual({ tonic: 'A', mode: 'minor' });
    expect(s.get('songB')).toEqual({ tonic: 'D', mode: 'major' });
  });

  it('恢复自动只清当前歌', () => {
    const s = makeKeyStore();
    s.set('songA', { tonic: 'A', mode: 'minor' });
    s.set('songB', { tonic: 'D', mode: 'major' });

    s.reset('songA');
    expect(s.get('songA')).toBeNull();
    // B 不受影响 —— 这是「单个全局值」版本做不到的
    expect(s.get('songB')).toEqual({ tonic: 'D', mode: 'major' });
  });

  it('删歌会清掉它的调性（重新导入同名歌不该继承旧设置）', () => {
    const s = makeKeyStore();
    s.set('songA', { tonic: 'A', mode: 'minor' });
    s.drop('songA');
    expect(s.get('songA')).toBeNull();
  });

  it('没有当前歌时写入被忽略（浏览器模式 / 空态）', () => {
    const s = makeKeyStore();
    s.set(null, { tonic: 'C', mode: 'major' });
    expect(Object.keys(s.all())).toHaveLength(0);
  });
});

describe('追加级数轨按歌曲隔离', () => {
  const chordsA: RealClip[] = [
    { id: 'A-ch1', startTick: 0, endTick: 3840, label: 'A:maj' },
    { id: 'A-ch2', startTick: 3840, endTick: 7680, label: 'F#:min' },
  ];
  const chordsB: RealClip[] = [
    { id: 'B-ch1', startTick: 0, endTick: 3840, label: 'D:maj' },
  ];

  it('A 歌的轨道 id 不会和 B 歌撞', () => {
    // 轨道 id 带歌曲前缀（App.vue 的 addDegreeTrack 里这么做）
    const tA = makeDegreeTrack(chordsA, 'F#', 'minor', 'songA-deg-1');
    const tB = makeDegreeTrack(chordsB, 'B', 'minor', 'songB-deg-1');
    expect(tA.id).not.toBe(tB.id);
  });

  it('块 id 也不撞（编辑层靠 id 索引，撞了会串块）', () => {
    const tA = makeDegreeTrack(chordsA, 'F#', 'minor', 'songA-deg-1');
    const tB = makeDegreeTrack(chordsB, 'B', 'minor', 'songB-deg-1');
    const ids = [...tA.clips, ...tB.clips].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('轨道必须用自己那首歌的和弦算级数', () => {
    // 这是「全局数组」版本最隐蔽的错：A 歌的轨被套到 B 歌上，
    // parentId 全对不上，级数全空。
    const tA = makeDegreeTrack(chordsA, 'A', 'major', 'songA-deg-1');
    const parents = tA.clips.map((c) => c.parentId);
    expect(parents).toEqual(['A-ch1', 'A-ch2']);
    // 每个 parentId 都必须真的存在于 A 歌的和弦里
    const chordIds = new Set(chordsA.map((c) => c.id));
    for (const p of parents) {
      expect(chordIds.has(p as string)).toBe(true);
    }
  });
});
