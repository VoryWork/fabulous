/**
 * `normalizeSections` —— 结构段的排序 / 去重叠 / 合并。
 *
 * ## 为什么需要
 *
 * 用户明确要求「结构段不能叠」。而模型（all-in-one-infer）输出的段落
 * 既不保证有序，也不保证不交叠 —— 直接画出来会出现两条结构块压在一起，
 * 用户既看不明白也没法拖（一拖就撞）。
 *
 * 所以在这里统一收口，下游（渲染、编辑层、导出）都拿干净数据。
 */
import { describe, expect, it } from 'vitest';
import { normalizeSections, type AnalysisFile } from './realData';

/** 造一个只有 downbeats 的最小分析对象（小节 = 每个 downbeat） */
function fakeAnalysis(sections: any[], barCount = 40): AnalysisFile {
  return {
    song: { title: 't', artist: '', durationSec: barCount * 2, audioPath: '' },
    downbeatsSec: Array.from({ length: barCount }, (_, i) => i * 2),
    beatsSec: Array.from({ length: barCount * 4 }, (_, i) => i * 0.5),
    chords: {},
    meta: { beatsPerBar: 4, bpmMedian: 120, barSecMedian: 2, beatCount: barCount * 4, barCount },
    sections,
  } as unknown as AnalysisFile;
}

/** 断言：结果严格递增且不重叠 */
function expectNoOverlap(items: { startBar: number; endBar: number }[]) {
  for (let i = 0; i < items.length; i++) {
    expect(items[i].endBar).toBeGreaterThan(items[i].startBar);
    if (i > 0) expect(items[i].startBar).toBeGreaterThanOrEqual(items[i - 1].endBar);
  }
}

describe('normalizeSections', () => {
  it('乱序输入会被排好', () => {
    const a = fakeAnalysis([
      { label: 'Chorus', startBar: 10, endBar: 20 },
      { label: 'Intro', startBar: 0, endBar: 10 },
    ]);
    const out = normalizeSections(a);
    expect(out.map((x) => x.label)).toEqual(['Intro', 'Chorus']);
    expectNoOverlap(out);
  });

  it('交叠的段会被截断，不重叠', () => {
    const a = fakeAnalysis([
      { label: 'Intro', startBar: 0, endBar: 15 },
      { label: 'Verse', startBar: 10, endBar: 25 }, // 与 Intro 重叠 5 小节
    ]);
    const out = normalizeSections(a);
    expectNoOverlap(out);
    expect(out[0]).toMatchObject({ label: 'Intro', startBar: 0, endBar: 15 });
    // Verse 被推到 Intro 末尾开始
    expect(out[1]).toMatchObject({ label: 'Verse', startBar: 15, endBar: 25 });
  });

  it('被前一段完全吃掉的段会被丢弃', () => {
    const a = fakeAnalysis([
      { label: 'Intro', startBar: 0, endBar: 20 },
      { label: 'Verse', startBar: 5, endBar: 12 }, // 完全在 Intro 里面
    ]);
    const out = normalizeSections(a);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Intro');
  });

  it('相邻同名段合并', () => {
    const a = fakeAnalysis([
      { label: 'Verse', startBar: 0, endBar: 10 },
      { label: 'Verse', startBar: 10, endBar: 20 },
    ]);
    const out = normalizeSections(a);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startBar: 0, endBar: 20 });
  });

  it('中间隔着别的段就不合并', () => {
    const a = fakeAnalysis([
      { label: 'Verse', startBar: 0, endBar: 10 },
      { label: 'Chorus', startBar: 10, endBar: 20 },
      { label: 'Verse', startBar: 20, endBar: 30 },
    ]);
    expect(normalizeSections(a)).toHaveLength(3);
  });

  it('start / end 用秒时也能转成小节', () => {
    // 每个 downbeat 间隔 2 秒 → 第 5 秒 ≈ 第 2.5 小节
    const a = fakeAnalysis([{ label: 'Intro', start: 0, end: 10 }]);
    const out = normalizeSections(a);
    expect(out[0].startBar).toBe(0);
    expect(out[0].endBar).toBe(5); // 10s / 2s = 第 5 小节
  });

  it('超出曲末的段会被截断', () => {
    const a = fakeAnalysis([{ label: 'Outro', startBar: 30, endBar: 999 }], 40);
    const out = normalizeSections(a);
    expect(out[0].endBar).toBeLessThanOrEqual(40);
    expectNoOverlap(out);
  });

  it('模型给的 start / end 这种非结构标签会被丢掉', () => {
    const a = fakeAnalysis([
      { label: 'start', startBar: 0, endBar: 5 },
      { label: 'Verse', startBar: 5, endBar: 15 },
      { label: 'end', startBar: 15, endBar: 20 },
    ]);
    const out = normalizeSections(a);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Verse');
  });

  it('空 sections 返回空数组', () => {
    expect(normalizeSections(fakeAnalysis([]))).toEqual([]);
  });

  it('随机乱序 + 交叠也能产出不重叠结果', () => {
    const a = fakeAnalysis([
      { label: 'Chorus', startBar: 20, endBar: 30 },
      { label: 'Intro', startBar: 0, endBar: 12 },
      { label: 'Verse', startBar: 8, endBar: 22 },
      { label: 'Bridge', startBar: 28, endBar: 35 },
    ]);
    const out = normalizeSections(a);
    expectNoOverlap(out);
    expect(out.length).toBeGreaterThan(0);
  });
});
