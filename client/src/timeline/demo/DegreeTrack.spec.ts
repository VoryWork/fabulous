/**
 * 级数轨 + 调性覆盖的测试。
 *
 * ## 为什么要单独测这块
 *
 * 级数轨是**派生数据**：它的内容完全由「父和弦 + 推定调性」决定，
 * 自己不带任何音高信息。这类派生数据最容易出两类错：
 *
 *   1. **父级断链**：用户改和弦后级数不更新（因为算的时候用的是分析快照，
 *      而不是实时数据）
 *   2. **调性没传进去**：`chordToNumber(label, '')` 全都返回 null，
 *      整条轨显示 `—`，看起来像"功能没做"
 *
 * 这两个 bug 都不报错、只显示错，所以必须用测试锁住。
 */
import { describe, expect, it } from 'vitest';
import {
  chordToNumber,
  degreeTonicOf,
  makeDegreeTrack,
  shouldHighlightDegree,
  type RealClip,
} from './realData';
import { relatedMinor, KEY_TONICS } from '../domain/ChordNotation';

/** 造一批和弦块 */
function chords(...labels: string[]): RealClip[] {
  return labels.map((label, i) => ({
    id: 'ch-' + i,
    startTick: i * 3840,
    endTick: (i + 1) * 3840,
    label,
  }));
}

describe('makeDegreeTrack', () => {
  it('每个和弦块对应一个级数块，且 parentId 指回和弦', () => {
    const cs = chords('A:maj', 'D:maj', 'E:maj', 'F#:min');
    const t = makeDegreeTrack(cs, 'A', 'major', 'tr-x');

    expect(t.clips).toHaveLength(cs.length);
    t.clips.forEach((c, i) => {
      expect(c.parentId).toBe(cs[i].id);
      // 时间范围必须和父级完全一致，否则级数会视觉错位
      expect(c.startTick).toBe(cs[i].startTick);
      expect(c.endTick).toBe(cs[i].endTick);
    });
  });

  it('A 大调下正确算出 I / IV / V / vi', () => {
    const t = makeDegreeTrack(
      chords('A:maj', 'D:maj', 'E:maj', 'F#:min'),
      'A',
      'major',
      'tr-x',
    );
    expect(t.clips.map((c) => c.label)).toEqual(['1:maj', '4:maj', '5:maj', '6:min']);
  });

  it('同一个和弦在不同调性下得到不同级数（这就是对照轨的意义）', () => {
    const cs = chords('F#:min');
    const major = makeDegreeTrack(cs, 'A', 'major', 'tr-a');
    const minor = makeDegreeTrack(cs, 'F#', 'minor', 'tr-b');

    // A 大调里 F#:min 是 vi；F# 小调里它是 i
    expect(major.clips[0].label).toBe('6:min');
    expect(minor.clips[0].label).toBe('1:min');
  });

  it('N / 未识别 / 中文 不抛错，留空标签等用户补', () => {
    const t = makeDegreeTrack(
      chords('N', '未识别', 'A:maj'),
      'A',
      'major',
      'tr-x',
    );
    expect(t.clips).toHaveLength(3);
    // `N`（无和弦）保留原样 —— 它不是「解析失败」，
    // 而是一个有意义的语义：这里确实没有和弦。
    // 在级数轨上显示 `N` 比显示 `—` 更准确。
    expect(t.clips[0].label).toBe('N');
    // 「未识别」是中文标签，解析不出来 → 空串（渲染时显示 —）
    expect(t.clips[1].label).toBe('');
    expect(t.clips[2].label).toBe('1:maj');
  });

  it('空主音（歌还没分析出调）时全部留空，但块数不变', () => {
    const t = makeDegreeTrack(chords('A:maj', 'D:maj'), '', 'major', 'tr-x');
    expect(t.clips).toHaveLength(2);
    expect(t.clips.every((c) => c.label === '')).toBe(true);
  });

  it('轨道名带调性，界面上能区分多条级数轨', () => {
    const a = makeDegreeTrack(chords('C:maj'), 'C', 'major', 'tr-1');
    const b = makeDegreeTrack(chords('C:maj'), 'A', 'minor', 'tr-2');
    expect(a.name).toBe('级数 · C 大调');
    expect(b.name).toBe('级数 · A 小调');
    expect(a.id).not.toBe(b.id);
  });

  it('轨道 id 用于区分，块 id 也带轨道前缀（不会和主级数轨撞）', () => {
    const cs = chords('A:maj', 'D:maj');
    const t1 = makeDegreeTrack(cs, 'A', 'major', 'tr-extra-1');
    const t2 = makeDegreeTrack(cs, 'B', 'minor', 'tr-extra-2');
    const ids = [...t1.clips, ...t2.clips].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('relatedMinor', () => {
  it('关系小调 = 主音下移 3 个半音', () => {
    expect(relatedMinor('C')).toBe('A');
    expect(relatedMinor('A')).toBe('F#');
    expect(relatedMinor('G')).toBe('E');
    expect(relatedMinor('Bb')).toBe('G');
  });

  it('未知主音原样返回（不崩）', () => {
    expect(relatedMinor('')).toBe('');
    expect(relatedMinor('X')).toBe('X');
  });

  it('12 个主音都有自己的关系小调，且在列表内', () => {
    for (const t of KEY_TONICS) {
      const rel = relatedMinor(t);
      expect(KEY_TONICS).toContain(rel as (typeof KEY_TONICS)[number]);
    }
  });

  it('关系小调的关系大调能回去（loop 3 次 = 自己）', () => {
    // 下移 3 个半音，4 次正好回到原点（12 / 3 = 4）
    let t = 'C';
    for (let i = 0; i < 4; i++) t = relatedMinor(t);
    expect(t).toBe('C');
  });
});

/**
 * 核心回归：**多条级数轨必须各自按自己的调性算数字**。
 *
 * ## 用户报的 bug
 *
 * 「级数轨根本没有单独计算，却换全曲的主调，自定义级数轨跟着变」
 * 「我们要换的是数字！你只换了调号，没换数字」
 *
 * 表现：加一条 D 小调的级数轨，它的标签确实写着「D 小调」，
 * 但每一块的数字和 G 大调那条**一模一样** —— 因为渲染时统一读了
 * 全局 `keyTonic`，压根没用轨道自己的调性。
 *
 * ## 为什么这个测试必须存在
 *
 * `makeDegreeTrack` 生成时算的 label 是对的（那时就传了 tonic），
 * 所以「生成结果」的测试全绿。但渲染层是**重新算一遍**的，
 * 那一处漏了 tonic 就整个废掉，而生成侧的测试完全发现不了。
 *
 * 这里模拟渲染层的算法：`chordToNumber(label, degreeTonicOf(track, 全局))`。
 */
describe('多条级数轨各自算数字（渲染层行为）', () => {
  /** 模拟 TimelineView 渲染时的标签派生 */
  const renderLabel = (track: ReturnType<typeof makeDegreeTrack>, globalTonic: string, chord: string) =>
    chordToNumber(chord, degreeTonicOf(track, globalTonic));

  it('同一段和弦在 G 大调 / D 小调下得到不同数字', () => {
    const cs = chords('G:maj7', 'A:min7', 'D:7');
    const g = makeDegreeTrack(cs, 'G', 'major', 't-g');
    const d = makeDegreeTrack(cs, 'D', 'minor', 't-d');

    expect(renderLabel(g, 'G', 'G:maj7')).toBe('1:maj7');
    expect(renderLabel(d, 'D', 'G:maj7')).toBe('4:maj7');

    expect(renderLabel(g, 'G', 'A:min7')).toBe('2:min7');
    expect(renderLabel(d, 'D', 'A:min7')).toBe('5:min7');
  });

  it('切全局主调时，自定义轨的数字**不变**', () => {
    const cs = chords('A:min7');
    const custom = makeDegreeTrack(cs, 'D', 'minor', 't-d');

    // 全局从 G 切到 Ab，自定义轨仍按自己的 D 算
    expect(renderLabel(custom, 'G', 'A:min7')).toBe('5:min7');
    expect(renderLabel(custom, 'Ab', 'A:min7')).toBe('5:min7');
  });

  it('自动轨（没有 degreeTonic）才跟随全局主调', () => {
    const cs = chords('A:min7');
    const auto = makeDegreeTrack(cs, 'G', 'major', 't-auto');
    // 模拟「自动推断」那条轨：它不存自己的调性
    const bare = { ...auto, degreeTonic: undefined, degreeMode: undefined };

    expect(renderLabel(bare, 'G', 'A:min7')).toBe('2:min7');
    expect(renderLabel(bare, 'D', 'A:min7')).toBe('5:min7');
  });

  it('makeDegreeTrack 把调性写进轨道本身', () => {
    const t = makeDegreeTrack(chords('C:maj'), 'Bb', 'minor', 't1');
    expect(t.degreeTonic).toBe('Bb');
    expect(t.degreeMode).toBe('minor');
  });
});

/**
 * 段调性 → 级数块高亮（`shouldHighlightDegree`）。
 *
 * ## 完整规则
 *
 * | 段调性 | 主级数轨（自动轨） | 自定义轨 |
 * |---|---|---|
 * | 没标 | ✅ 高亮（它是默认解读） | ❌ 不高亮 |
 * | 标了且一致 | ✅ | ✅ |
 * | 标了但不一致 / 没有匹配轨 | ❌ | ❌ |
 *
 * 用户的两次明确要求：
 *   - 「段标了 G major 但没有匹配的级数轨，可以不高亮任何轨道」
 *   - 「如果啥都没标，主级数轨（级数解释）要高亮」
 */
describe('shouldHighlightDegree', () => {
  const auto = { degreeTonic: undefined, degreeMode: undefined }; // 级数解释轨
  const g = { degreeTonic: 'G', degreeMode: 'major' as const };
  const dm = { degreeTonic: 'D', degreeMode: 'minor' as const };

  it('段没标调性 → 只高亮主级数轨', () => {
    expect(shouldHighlightDegree(auto, undefined, 'G', 'major')).toBe(true);
    expect(shouldHighlightDegree(g, undefined, 'G', 'major')).toBe(false);
    expect(shouldHighlightDegree(dm, undefined, 'G', 'major')).toBe(false);
  });

  it('段标了 G 大调 → G 大调轨高亮，自动轨也高亮（全局就是 G）', () => {
    const sec = { tonic: 'G', mode: 'major' as const };
    expect(shouldHighlightDegree(g, sec, 'G', 'major')).toBe(true);
    expect(shouldHighlightDegree(auto, sec, 'G', 'major')).toBe(true);
    expect(shouldHighlightDegree(dm, sec, 'G', 'major')).toBe(false);
  });

  it('段标了但全局不同 → 自动轨不匹配就不高亮', () => {
    const sec = { tonic: 'A', mode: 'major' as const };
    // 自动轨跟随全局 G，和段的 A 不符
    expect(shouldHighlightDegree(auto, sec, 'G', 'major')).toBe(false);
  });

  it('段标了调性、但没有任何匹配的轨 → 一条都不高亮', () => {
    const sec = { tonic: 'Bb', mode: 'major' as const };
    expect(shouldHighlightDegree(auto, sec, 'G', 'major')).toBe(false);
    expect(shouldHighlightDegree(g, sec, 'G', 'major')).toBe(false);
    expect(shouldHighlightDegree(dm, sec, 'G', 'major')).toBe(false);
  });

  it('调式不同也算不匹配（G 大调 vs G 小调）', () => {
    const sec = { tonic: 'G', mode: 'minor' as const };
    expect(shouldHighlightDegree(g, sec, 'G', 'major')).toBe(false);
  });

  it('自定义轨在没有段调性时不抢戏（即使它等于全局调性）', () => {
    // G 轨的调性恰好等于全局 G，但没有段标注 → 仍不高亮
    expect(shouldHighlightDegree(g, undefined, 'G', 'major')).toBe(false);
  });
});
