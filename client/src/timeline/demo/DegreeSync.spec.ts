/**
 * 级数轨必须与和弦块**一一对应**。
 *
 * ## 踩过的坑
 *
 * 原来生成级数轨时写了 `if (!deg) continue` —— 解析不出级数的块直接跳过。
 * 后果：
 *   - 「未识别」段（label 是中文）解析失败 → 级数轨那里是**空白**
 *   - 用户在右侧把「未识别」改成 `Ab:maj` 之后，**级数块根本不存在**，
 *     所以永远补不上（用户报的「手动补了级数轨没同步」）
 *
 * 现在级数块一律生成（label 留空壳），标签在渲染层从**父和弦的当前值**派生。
 * 时间范围本来就靠 `parentId` 投影，两者合起来 = 级数完全跟随父和弦。
 */
import { describe, it, expect } from 'vitest';
import { chordToNumber, makeRealTracks, type AnalysisFile } from './realData';

/** 构造一个含指定和弦序列的极简分析（每和弦 1 小节 4 拍） */
function makeAnalysis(labels: string[]): AnalysisFile {
  const beats: number[] = [];
  const downs: number[] = [];
  for (let i = 0; i < labels.length * 4; i++) beats.push(i * 0.5);
  for (let i = 0; i < labels.length; i++) downs.push(i * 2);
  return {
    song: { title: 't', artist: '', durationSec: labels.length * 2 },
    source: { beats: '', chords: '', note: '' },
    downbeatsSec: downs,
    beatsSec: beats,
    chords: {
      submission: labels.map((c, i) => ({ start: i * 2, end: i * 2 + 2, chord: c })),
    },
    sections: [],
    tempoSegments: [],
    meta: {
      beatsPerBar: 4,
      bpmMedian: 120,
      barSecMedian: 2,
      beatCount: beats.length,
      barCount: downs.length,
    },
  };
}

const opts = { bySecToTick: (s: number) => Math.round(s * 1920), snapToBar: 0, minBeats: 1 };

describe('级数轨与和弦块一一对应', () => {
  it('「未识别」也有一条级数块（不再被跳过）', () => {
    const a = makeAnalysis(['Ab:maj', '未识别', 'N', 'C#:min']);
    const tracks = makeRealTracks(a, opts);
    const chord = tracks.find((t) => t.id === 'tr-chord')!;
    const degree = tracks.find((t) => t.id === 'tr-degree')!;
    expect(degree.clips.length).toBe(chord.clips.length);
  });

  it('解析不出级数时 label 留空（渲染层显示 —）', () => {
    const a = makeAnalysis(['未识别']);
    const tracks = makeRealTracks(a, opts);
    const degree = tracks.find((t) => t.id === 'tr-degree')!;
    expect(degree.clips[0].label).toBe('');
  });

  it('每个级数块都有 parentId（时间投影靠它）', () => {
    const a = makeAnalysis(['Ab:maj', '未识别', 'Bb:min']);
    const tracks = makeRealTracks(a, opts);
    const degree = tracks.find((t) => t.id === 'tr-degree')!;
    for (const c of degree.clips) expect(c.parentId).toBeTruthy();
  });

  it('补完和弦后级数能算出来（这是「手动补要同步」的核心）', () => {
    // 渲染层逻辑：用父和弦**当前** label 换算
    expect(chordToNumber('未识别', 'Ab')).toBeNull(); // 补之前：算不出
    expect(chordToNumber('Ab:maj', 'Ab')).toBe('1:maj'); // 补之后：有级数
    expect(chordToNumber('C#:maj', 'Ab')).toBe('4:maj');
  });
});
