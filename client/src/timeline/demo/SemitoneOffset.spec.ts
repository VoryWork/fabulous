// SPDX-License-Identifier: MIT
// Copyright (c) 2026 VoryWork

/**
 * 级数轨的两个增强标注：
 *
 *   1. **主调级数按调式编号** —— d 小调里 `Bb` 是 6 级（VI），不是 `b7`
 *   2. **关系大小调第几级** —— 换个视角（大↔小）它是第几级
 *
 * ## 为什么要写死测试
 *
 * 这两件事都是「看起来对但其实错」的高危区：
 *
 *   - 主级数如果统一用大调尺子，`Bb` 在 d 小调里会算成 `b7`，
 *     而它在小调语境里是常用的 VI 级，读不出来
 *   - 关系调级数如果不换算主音，全部算成主调的级数，
 *     看不出「换个视角是第几级」
 *
 * 注：半音差徽章（`+2` / `+4`）已删除 —— 它和级数数字信息重复，
 * 自然音级上每块都写一遍纯属噪音。
 */
import { describe, expect, it } from 'vitest';
import {
  chordToNumber,
  relativeDegree,
  relativeKeyName,
  relativeTonicOf,
} from './realData';

describe('relativeDegree（关系大小调第几级）', () => {
  /**
   * 规则：把主音换到**关系主音**，然后用**关系调自己的调式音阶**编号。
   *
   *   大调轨 → 关系小调（+9 半音）→ 自然小调数级
   *   小调轨 → 关系大调（+3 半音）→ 大调数级
   *
   * 就是说：在 C 大调轨上，看到 C 就知道它是关系小调 A 小调的 3 级。
   */
  it('大调轨：换到关系小调视角看级数', () => {
    // C 大调的关系小调是 A 小调（A B C D E F G）
    //   A → 1   B → 2   C → 3   D → 4   E → 5   F → 6   G → 7
    expect(relativeDegree('A:min', 'C', 'major')).toBe('1');
    expect(relativeDegree('B:dim', 'C', 'major')).toBe('2');
    expect(relativeDegree('C:maj', 'C', 'major')).toBe('3');
    expect(relativeDegree('D:min', 'C', 'major')).toBe('4');
    expect(relativeDegree('E:min', 'C', 'major')).toBe('5');
    expect(relativeDegree('F:maj', 'C', 'major')).toBe('6');
    expect(relativeDegree('G:maj', 'C', 'major')).toBe('7');
  });

  it('小调轨：换到关系大调视角看级数', () => {
    // a 小调的关系大调是 C 大调（C D E F G A B）
    //   C → 1   D → 2   E → 3   F → 4   G → 5   A → 6   B → 7
    expect(relativeDegree('C:maj', 'A', 'minor')).toBe('1');
    expect(relativeDegree('D:min', 'A', 'minor')).toBe('2');
    expect(relativeDegree('E:maj', 'A', 'minor')).toBe('3');
    expect(relativeDegree('F:maj', 'A', 'minor')).toBe('4');
    expect(relativeDegree('G:maj', 'A', 'minor')).toBe('5');
    expect(relativeDegree('A:min', 'A', 'minor')).toBe('6');
    expect(relativeDegree('B:dim', 'A', 'minor')).toBe('7');
  });

  it('d 小调轨 → 关系大调 F（用户举的例子）', () => {
    // d 小调的关系大调是 F（F G A Bb C D E）
    //   F → 1   G → 2   A → 3   Bb → 4   C → 5   D → 6   E → 7
    expect(relativeDegree('F:maj', 'D', 'minor')).toBe('1');
    expect(relativeDegree('G:min', 'D', 'minor')).toBe('2');
    expect(relativeDegree('A:maj', 'D', 'minor')).toBe('3');
    expect(relativeDegree('Bb:maj', 'D', 'minor')).toBe('4');
    expect(relativeDegree('C:maj', 'D', 'minor')).toBe('5');
    expect(relativeDegree('D:min', 'D', 'minor')).toBe('6');
    expect(relativeDegree('E:dim', 'D', 'minor')).toBe('7');
  });

  it('变化音也能算（不在自然音阶上就补 b/#）', () => {
    // C 大调轨 → A 小调视角：Bb 在 A 小调里是 b2
    expect(relativeDegree('Bb:maj', 'C', 'major')).toBe('b2');
    // F# 在 A 小调里是 b7（G 降半音）
    expect(relativeDegree('F#:min', 'C', 'major')).toBe('b7');
  });

  it('12 个半音都有合法写法，且不重复', () => {
    const legal = new Set([
      '1', '2', '3', '4', '5', '6', '7',
      'b2', 'b3', 'b4', 'b5', 'b6', 'b7',
      '#1', '#2', '#4', '#5', '#6',
      'b1', 'b8', '#3', '#7',
    ]);
    const seen = new Set<string>();
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    for (const n of notes) {
      const deg = relativeDegree(`${n}:maj`, 'C', 'major');
      expect(deg).not.toBeNull();
      expect(legal.has(deg as string)).toBe(true);
      seen.add(deg as string);
    }
    // 12 个半音 → 12 个不同编号
    expect(seen.size).toBe(12);
  });

  it('N / 未识别 / 空 返回 null', () => {
    expect(relativeDegree('N', 'C', 'major')).toBeNull();
    expect(relativeDegree('未识别', 'C', 'major')).toBeNull();
    expect(relativeDegree('', 'C', 'major')).toBeNull();
    expect(relativeDegree('X:foo', 'C', 'major')).toBeNull();
  });
});

/**
 * 主调级数必须按**所选调式**的音阶编号。
 *
 * 用户原话：「用户如果选的是 D minor，则 D minor 的级数放在前面」。
 * d 小调里的 `Bb:maj` 是常用的 VI 级，必须显示 `6`；
 * 如果按大调尺子算会得到 `b7`，在小调语境里完全读不对。
 */
describe('主调级数按调式编号（chordToNumber 的 mode 参数）', () => {
  it('D 小调：自然小调音阶上的七个级', () => {
    // D E F G A Bb C  →  1 2 3 4 5 6 7
    expect(chordToNumber('D:maj', 'D', 'minor')).toBe('1:maj');
    expect(chordToNumber('E:dim', 'D', 'minor')).toBe('2:dim');
    expect(chordToNumber('F:maj', 'D', 'minor')).toBe('3:maj');
    expect(chordToNumber('G:min', 'D', 'minor')).toBe('4:min');
    expect(chordToNumber('A:maj', 'D', 'minor')).toBe('5:maj');
    expect(chordToNumber('Bb:maj', 'D', 'minor')).toBe('6:maj');
    expect(chordToNumber('C:maj', 'D', 'minor')).toBe('7:maj');
  });

  it('同一个和弦，大调尺子与小调尺子得到不同数字', () => {
    // Bb 相对 D 差 8 个半音：
    //   大调里是 b6（降六级，因为 D 大调的 6 级是 B）
    //   小调里是 6（VI 级，因为 d 小调的 6 级就是 Bb）
    expect(chordToNumber('Bb:maj', 'D', 'major')).toBe('b6:maj');
    expect(chordToNumber('Bb:maj', 'D', 'minor')).toBe('6:maj');
  });

  it('大调轨的行为保持不变（默认 mode 不影响老调用方）', () => {
    expect(chordToNumber('D:maj', 'D')).toBe('1:maj');
    expect(chordToNumber('Bb:maj', 'D')).toBe('b6:maj');
    expect(chordToNumber('Bb:maj', 'D', 'major')).toBe('b6:maj');
  });

  it('小调里的变化音也按小调音阶算 b/#', () => {
    // 相对 d 小调：B（半音 9）= b7（C 降半音）
    expect(chordToNumber('B:dim', 'D', 'minor')).toBe('b7:dim');
  });

  it('转位低音也用同一套编号', () => {
    // D 小调下 D:maj/3：3 音 = F#（大三和弦的三音），
    // F# 在 d 小调里是 b4（因为自然小调的 3 级是 F自然音）
    expect(chordToNumber('D:maj/3', 'D', 'minor')).toBe('1:maj/b4');
    // A:maj/5 → 5 音 = E，在 d 小调里是 2 级
    expect(chordToNumber('A:maj/5', 'D', 'minor')).toBe('5:maj/2');
    // 对照：同一个 D:maj/3 在 D 大调里就是正常的 3 级
    expect(chordToNumber('D:maj/3', 'D', 'major')).toBe('1:maj/3');
  });
});

describe('relativeTonicOf（关系调标签）', () => {
  /**
   * 用户要求：「不要写关系 xxx，直接关系大/关系小」。
   *
   * 所以块上只给四个字，具体是哪个调靠 `relativeKeyName` + 悬浮提示。
   */
  it('大调轨 → 关系小调', () => {
    expect(relativeTonicOf('C', 'major')).toBe('关系小调');
    expect(relativeTonicOf('A', 'major')).toBe('关系小调');
  });

  it('小调轨 → 关系大调', () => {
    expect(relativeTonicOf('D', 'minor')).toBe('关系大调');
    expect(relativeTonicOf('A', 'minor')).toBe('关系大调');
  });

  it('不包含调名（不要「关系 F major」这种写法）', () => {
    for (const m of ['major', 'minor'] as const) {
      const label = relativeTonicOf('D', m);
      expect(label).not.toMatch(/[A-G][#b]?\s/);
      expect(label.length).toBeLessThanOrEqual(4);
    }
  });
});

describe('relativeKeyName（关系调完整名，悬浮提示用）', () => {
  it('大调 → 关系小调名', () => {
    expect(relativeKeyName('C', 'major')).toBe('A minor');
    expect(relativeKeyName('G', 'major')).toBe('E minor');
    expect(relativeKeyName('D', 'major')).toBe('B minor');
    // 6 个半音写 F# 而不是 Gb（Gb 小调是不存在的写法）
    expect(relativeKeyName('A', 'major')).toBe('F# minor');
  });

  it('小调 → 关系大调名', () => {
    expect(relativeKeyName('D', 'minor')).toBe('F major');
    expect(relativeKeyName('A', 'minor')).toBe('C major');
    expect(relativeKeyName('E', 'minor')).toBe('G major');
  });

  it('与 relativeDegree 的轴心一致：关系调主音在关系调里是 1 级', () => {
    for (const [tonic, mode] of [
      ['C', 'major'],
      ['G', 'major'],
      ['A', 'major'],
      ['D', 'minor'],
      ['A', 'minor'],
    ] as Array<[string, 'major' | 'minor']>) {
      const rel = relativeKeyName(tonic, mode);
      const relTonic = rel.split(' ')[0];
      expect(relativeDegree(`${relTonic}:min`, tonic, mode)).toBe('1');
    }
  });

  it('两个函数对同一个输入分工明确（一个简、一个全）', () => {
    expect(relativeTonicOf('D', 'minor')).toBe('关系大调');
    expect(relativeKeyName('D', 'minor')).toBe('F major');
  });
});
