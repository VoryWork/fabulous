/**
 * 导出功能的测试。
 *
 * 核心要求只有一条：**`.fbsong` 一个字段都不能少**（能无损还原一首歌）。
 *
 * （曾经还有个「导出讲解稿（Markdown）」，用户要求去掉了。）
 */
import { describe, expect, it } from 'vitest';
import {
  FBSONG_FORMAT,
  FBSONG_VERSION,
  buildFbsongBundle,
  serializeFbsong,
  suggestFileName,
} from './exporters';
import type { AnalysisFile } from '../timeline/demo/realData';

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

describe('.fbsong 包含用户编辑层', () => {
  it('歌词轨 / 级数轨 / 调性 / 和弦编辑都随工程导出', () => {
    const edits = {
      key: { tonic: 'F#', mode: 'minor' as const },
      degreeTracks: [{ id: 'deg-1', tonic: 'A', mode: 'major' as const }],
      lyricTracks: [
        {
          id: 'lyr-1',
          name: '歌词',
          clips: [
            { id: 'ly-0', startTick: 0, endTick: 3840, text: '我们 变成一对 差点缘分' },
            { id: 'ly-1', startTick: 3840, endTick: 7680, text: '装成朋友少点天分' },
          ],
        },
      ],
      sections: {
        clips: [{ id: 'sec-0', startTick: 0, endTick: 15360, label: 'Intro' }],
      },
    };

    const bundle = buildFbsongBundle({
      analysis: fakeAnalysis(),
      edits,
      key: { tonic: 'G', mode: 'major' },
      bpm: 129.7,
    });

    // 序列化 → 反序列化，模拟「存盘后在别的机器上打开」
    const roundTrip = JSON.parse(serializeFbsong(bundle));

    expect(roundTrip.edits.lyricTracks).toHaveLength(1);
    expect(roundTrip.edits.lyricTracks[0].name).toBe('歌词');
    expect(roundTrip.edits.lyricTracks[0].clips.map((c: { text: string }) => c.text)).toEqual([
      '我们 变成一对 差点缘分',
      '装成朋友少点天分',
    ]);
    // 歌词块的时间也要原样保留（否则导入后位置全乱）
    expect(roundTrip.edits.lyricTracks[0].clips[1]).toMatchObject({
      startTick: 3840,
      endTick: 7680,
    });
    // 其他编辑层不受影响
    expect(roundTrip.edits.degreeTracks).toHaveLength(1);
    expect(roundTrip.edits.key).toEqual({ tonic: 'F#', mode: 'minor' });
    // 分析结果原样
    expect(roundTrip.analysis.chords.submission).toHaveLength(3);
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
