// SPDX-License-Identifier: MIT
// Copyright (c) 2026 VoryWork

import { describe, expect, it } from 'vitest';
import { makeDegreeTrack, relativeKeyName, relativeTonicOf, type RealClip } from './realData';

function chords(...labels: string[]): RealClip[] {
  return labels.map((label, i) => ({
    id: 'ch-' + i,
    startTick: i * 3840,
    endTick: (i + 1) * 3840,
    label,
  }));
}

/**
 * 用户举的例子：选 D minor 时，D minor 的级数必须在前面。
 */
describe('D minor 级数轨', () => {
  it('主级数按 d 自然小调编号（Bb 是 6，不是 b7）', () => {
    const t = makeDegreeTrack(
      chords('D:min', 'G:min', 'Bb:maj', 'A:maj', 'F:maj', 'C:maj', 'E:dim'),
      'D',
      'minor',
      'tr-dm',
    );
    expect(t.clips.map((c) => c.label)).toEqual([
      '1:min', '4:min', '6:maj', '5:maj', '3:maj', '7:maj', '2:dim',
    ]);
  });

  it('关键差别：同一条 Bb 在大调轨 vs 小调轨', () => {
    const dm = makeDegreeTrack(chords('Bb:maj'), 'D', 'minor', 'a');
    const dM = makeDegreeTrack(chords('Bb:maj'), 'D', 'major', 'b');
    expect(dm.clips[0].label).toBe('6:maj'); // d 小调的 VI 级
    expect(dM.clips[0].label).toBe('b6:maj'); // D 大调里是降六级
  });

  it('块上标签是「关系大调」，完整名在悬浮提示里', () => {
    // 用户要求：不要写「关系 F major」，直接写「关系大调」
    expect(relativeTonicOf('D', 'minor')).toBe('关系大调');
    expect(relativeKeyName('D', 'minor')).toBe('F major');
  });

  it('关系大调视角：F 是 1 级、Bb 是 4 级、D 是 6 级', () => {
    // 这条轨的关系调是 F major（F G A Bb C D E）
    const t = makeDegreeTrack(chords('F:maj', 'Bb:maj', 'C:maj', 'D:min'), 'D', 'minor', 'x');
    expect(t.degreeTonic).toBe('D');
    expect(t.degreeMode).toBe('minor');
    // 主级数是 D 小调的编号
    expect(t.clips.map((c) => c.label)).toEqual(['3:maj', '6:maj', '7:maj', '1:min']);
  });
});
