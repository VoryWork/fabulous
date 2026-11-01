/**
 * 导出功能的测试。
 *
 * ## 两种导出的定位
 *
 * | 格式 | 给谁 | 特点 |
 * |---|---|---|
 * | 讲解 Markdown | 人看 | 丢掉精度换可读性 |
 * | `.fbsong` | 程序看 | 完整 JSON，不裁任何字段 |
 *
 * 所以测试也分两类：
 *   - 讲解稿：**信息要在**（标题、调性、结构、和弦、级数）
 *   - `.fbsong`：**一个字段都不能少**（能无损还原一首歌）
 */
import { describe, expect, it } from 'vitest';
import {
  FBSONG_FORMAT,
  FBSONG_VERSION,
  buildFbsongBundle,
  buildLectureMarkdown,
  serializeFbsong,
  suggestFileName,
} from './exporters';
import type { AnalysisFile, RealTrack } from '../timeline/demo/realData';

/** 造一个最小但完整的分析对象 */
function fakeAnalysis(over: Partial<AnalysisFile> = {}): AnalysisFile {
  return {
    song: { title: '何なんw (WTF lol)', artist: '藤井风', durationSec: 320 },
    downbeatsSec: [2.76, 5.42, 7.46, 10.1, 12.78],
    beatsSec: [2.76, 3.42, 4.09, 4.75, 5.42, 5.93, 6.44, 6.95, 7.46, 7.9],
    chords: {
      submission: [
        { start: 2.76, end: 5.42, chord: 'G:maj7' },
        { start: 5.42, end: 7.46, chord: 'A:min7' },
        { start: 7.46, end: 10.1, chord: 'D:7' },
      ],
    },
    meta: { beatsPerBar: 4, bpmMedian: 90.2, barSecMedian: 2.66, beatCount: 10, barCount: 5 },
    sections: [
      { label: 'Intro', startBar: 0, endBar: 2 },
      { label: 'Verse', startBar: 2, endBar: 5 },
    ],
    ...over,
  } as unknown as AnalysisFile;
}

const chordTrack: RealTrack = {
  id: 'tr-chord',
  kind: 'chord',
  name: '绝对和弦',
  visible: true,
  clips: [
    { id: 'c1', startTick: 0, endTick: 3840, label: 'G:maj7' },
    { id: 'c2', startTick: 3840, endTick: 7680, label: 'A:min7' },
    { id: 'c3', startTick: 7680, endTick: 11520, label: 'D:7' },
  ],
};

describe('buildLectureMarkdown', () => {
  const md = () =>
    buildLectureMarkdown({
      analysis: fakeAnalysis(),
      tracks: [chordTrack],
      key: { tonic: 'G', mode: 'major' },
      keyIsManual: false,
      bpm: 90.2,
    });

  it('有标题、曲名、artist', () => {
    const s = md();
    expect(s).toContain('# 何なんw (WTF lol)');
    expect(s).toContain('藤井风');
  });

  it('有调性，并标明是自动推断还是手动', () => {
    expect(md()).toContain('**G 大调**（自动推断）');
    const manual = buildLectureMarkdown({
      analysis: fakeAnalysis(),
      tracks: [chordTrack],
      key: { tonic: 'D', mode: 'minor' },
      keyIsManual: true,
      bpm: 90.2,
    });
    expect(manual).toContain('**D 小调**（手动指定）');
  });

  it('概览行包含 BPM / 小节 / 和弦段数', () => {
    const s = md();
    expect(s).toMatch(/90\.2 BPM/);
    expect(s).toMatch(/5 小节/);
    expect(s).toMatch(/3 个和弦段/);
  });

  it('结构表带段落名和小节区间', () => {
    const s = md();
    expect(s).toContain('| Intro |');
    expect(s).toContain('| Verse |');
  });

  it('和弦进行里带级数（G 大调下 G:maj7 = 1:maj7）', () => {
    const s = md();
    expect(s).toContain('G:maj7 (1:maj7)');
  });

  it('同一和弦连续出现会合并成 ×N（避免一堆重复行）', () => {
    const repeated: RealTrack = {
      ...chordTrack,
      clips: [
        { id: 'c1', startTick: 0, endTick: 960, label: 'G:maj7' },
        { id: 'c2', startTick: 960, endTick: 1920, label: 'G:maj7' },
        { id: 'c3', startTick: 1920, endTick: 2880, label: 'G:maj7' },
      ],
    };
    const s = buildLectureMarkdown({
      analysis: fakeAnalysis({ sections: [] }),
      tracks: [repeated],
      key: { tonic: 'G', mode: 'major' },
      keyIsManual: false,
      bpm: 90.2,
    });
    expect(s).toMatch(/G:maj7.*×3/);
  });

  it('没有和弦时不崩，给出提示', () => {
    const s = buildLectureMarkdown({
      analysis: fakeAnalysis({ chords: { submission: [] } } as Partial<AnalysisFile>),
      tracks: [{ ...chordTrack, clips: [] }],
      key: { tonic: 'G', mode: 'major' },
      keyIsManual: false,
      bpm: 90.2,
    });
    expect(s).toContain('还没有和弦数据');
  });

  it('调音校正信息会写进讲解（用户需要知道移调了）', () => {
    const s = buildLectureMarkdown({
      analysis: fakeAnalysis({
        tuning: { deviationCents: -34.7, corrected: true },
      } as Partial<AnalysisFile>),
      tracks: [chordTrack],
      key: { tonic: 'G', mode: 'major' },
      keyIsManual: false,
      bpm: 90.2,
    });
    expect(s).toContain('-35 音分');
    expect(s).toContain('移调');
  });
});

describe('buildFbsongBundle', () => {
  it('完整保留分析结果（一字段不删）', () => {
    const a = fakeAnalysis();
    const b = buildFbsongBundle({
      analysis: a,
      edits: { key: { tonic: 'D', mode: 'minor' } },
      key: { tonic: 'D', mode: 'minor' },
      bpm: 90.2,
    });
    expect(b.analysis).toEqual(a);
  });

  it('完整保留用户编辑层', () => {
    const edits = {
      key: { tonic: 'D' as const, mode: 'minor' as const },
      degreeTracks: [{ id: 'd1', tonic: 'G', mode: 'major' as const }],
      sections: { clips: [{ id: 's1', startTick: 0, endTick: 3840, label: 'Intro' }] },
    };
    const b = buildFbsongBundle({
      analysis: fakeAnalysis(),
      edits,
      key: { tonic: 'D', mode: 'minor' },
      bpm: 90.2,
    });
    expect(b.edits).toEqual(edits);
  });

  it('带格式标识和版本号（将来能识别旧文件）', () => {
    const b = buildFbsongBundle({
      analysis: fakeAnalysis(),
      edits: {},
      key: { tonic: 'G', mode: 'major' },
      bpm: 90.2,
    });
    expect(b.format).toBe(FBSONG_FORMAT);
    expect(b.version).toBe(FBSONG_VERSION);
    expect(b.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('序列化后是**可读的多行文本**，不是压成一行', () => {
    const text = serializeFbsong(
      buildFbsongBundle({
        analysis: fakeAnalysis(),
        edits: {},
        key: { tonic: 'G', mode: 'major' },
        bpm: 90.2,
      }),
    );
    expect(text.split('\n').length).toBeGreaterThan(20);
    expect(text.endsWith('\n')).toBe(true);
    // 能原样解析回来
    const back = JSON.parse(text);
    expect(back.format).toBe(FBSONG_FORMAT);
    expect(back.analysis.song.title).toBe('何なんw (WTF lol)');
  });
});

describe('suggestFileName', () => {
  it('去掉 Windows 不允许的字符', () => {
    expect(suggestFileName('a/b\\c:d*e?f"g<h>i|j', 'fbsong')).toBe('a_b_c_d_e_f_g_h_i_j.fbsong');
  });

  it('空标题兜底', () => {
    expect(suggestFileName('', 'md')).toBe('未命名.md');
  });

  it('保留中文和空格', () => {
    expect(suggestFileName('満ちてゆく (live)', 'md')).toBe('満ちてゆく (live).md');
  });

  it('太长会截断（避免超出文件系统限制）', () => {
    const long = 'あ'.repeat(200);
    expect(suggestFileName(long, 'md').length).toBeLessThanOrEqual(84);
  });
});
