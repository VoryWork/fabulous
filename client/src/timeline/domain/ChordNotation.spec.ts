/**
 * 和弦记号的严格校验（对齐 lv-chordia）。
 *
 * ## 为什么需要它
 *
 * 用户手动输入和弦时，如果放任自由格式，脏数据会静默传染：
 *   - `chordToNumber` 解析失败 → 级数解释轨对应块直接消失（不报错）
 *   - `inferKey` 拿脏和弦打分 → 调性推断偏掉
 *   - 导出、重新分析的下游都要额外处理非法值
 *
 * 所以只接受 lv-chordia 词表里的写法。
 */
import { describe, it, expect } from 'vitest';
import { validateChord } from './ChordNotation';

describe('validateChord', () => {
  describe('合法写法（原样通过）', () => {
    for (const s of [
      'C:maj',
      'Ab:maj',
      'F#:min7',
      'Bb:min',
      'D:maj/3',
      'C:maj/5',
      'E:min7',
      'G:7',
      'A:dim7',
      'B:hdim7',
      'C:sus4',
      'Db:maj9',
      'N',
    ]) {
      it(s, () => {
        const r = validateChord(s);
        expect(r.ok).toBe(true);
        expect(r.normalized).toBe(s);
        expect(r.error).toBeUndefined();
      });
    }
  });

  describe('常见错误写法 → 自动纠正', () => {
    const cases: Array<[string, string]> = [
      ['Cm7', 'C:min7'],
      ['Am', 'A:min'],
      ['Cmaj7', 'C:maj7'],
      ['FM7', 'F:maj7'],
      ['G7', 'G:7'],
      ['Bdim7', 'B:dim7'],
      ['Esus4', 'E:sus4'],
      ['Ab', 'Ab:maj'],
    ];
    for (const [input, expected] of cases) {
      it(`${input} → ${expected}`, () => {
        const r = validateChord(input);
        expect(r.ok).toBe(true);
        expect(r.normalized).toBe(expected);
        expect(r.hint).toBeTruthy();
      });
    }
  });

  describe('必须拒绝的输入', () => {
    const bad: Array<[string, string]> = [
      ['', '空'],
      ['H:foo', '不存在的音名'],
      ['X', '不存在的音名'],
      ['abc', '不是音名'],
      ['C:foo', '不存在的性质'],
      ['C:hoge', '不存在的性质'],
      ['Cmaj7:x', '乱写'],
      ['C:maj/9th', '不存在的转位'],
      ['啦', '非拉丁字符'],
      ['C:maj:extra', '多余的冒号'],
    ];
    for (const [input, why] of bad) {
      it(`拒绝「${input}」（${why}）`, () => {
        const r = validateChord(input);
        expect(r.ok).toBe(false);
        expect(r.error).toBeTruthy();
      });
    }
  });

  it('拒绝时 error 里有可操作的提示', () => {
    const r = validateChord('C:foo');
    expect(r.error).toContain('不支持的和弦性质');
    expect(r.error).toContain('foo');
  });

  it('N 大小写都认', () => {
    expect(validateChord('n').normalized).toBe('N');
    expect(validateChord('N ').normalized).toBe('N');
  });

  it('前后空格不影响', () => {
    expect(validateChord('  Ab:maj  ').normalized).toBe('Ab:maj');
  });

  it('所有模型可能输出的和弦都能通过（回归保护）', () => {
    // 这些是实测 analysis.json 里出现过的和弦
    for (const s of [
      'N', 'Ab:maj', 'C#:maj', 'Eb:maj', 'Bb:min', 'A:maj',
      'Ab:maj/5', 'C#:maj/5', 'F#:min', 'D:maj', 'D:min',
      'A:min', 'C#:min', 'B:maj', 'Bb:maj', 'A:min7', 'Ab:7',
      'C#:7', 'Bb:min7', 'F:min7', 'Eb:min7', 'C#:9', 'C#:min7',
    ]) {
      const r = validateChord(s);
      expect(r.ok, `${s} 应该合法：${r.error}`).toBe(true);
      expect(r.normalized).toBe(s);
    }
  });
});
