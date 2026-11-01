/**
 * 空谱面（歌还没分析完）的行为约束。
 *
 * ## 为什么要有这个测试
 *
 * 踩过的坑：`data` 在 `currentAnalysis` 为 null 时回退到打包进项目的
 * `analysis.json`（Refrain 的数据）。于是点一首正在分析的歌，
 * 时间轴照样画出 Refrain 的结构和和弦，标题也是 Refrain ——
 * 用户看到的是「编辑器还是那首默认的歌」，完全没有「正在分析」的反馈。
 *
 * 现在空态返回**真正的空谱面**（0 小节、0 和弦），这里锁住三件事：
 *   1. 下游计算不崩（`createTempoMap` 对 durationSec<=0 会抛 RangeError）
 *   2. `inferKey` 不返回假的 `C major`
 *   3. 各轨在空数据下产出 0 个片段
 */
import { describe, it, expect } from 'vitest';
import {
  makeTempoMapFromSegments,
  makeRealTracks,
  makeBeatSnapper,
  totalTicksOf,
  inferKey,
  type AnalysisFile,
} from './realData';
import { bpmAt, tickToSec } from '../domain/TempoMap';

/** 与 App.vue 的 `emptyAnalysis` 保持同构 */
function emptyAnalysis(durationSec: number): AnalysisFile {
  return {
    song: { title: '新歌', artist: '', durationSec },
    source: { beats: '', chords: '', note: '尚未分析' },
    downbeatsSec: [],
    beatsSec: [],
    chords: {},
    sections: [],
    tempoSegments: [],
    meta: {
      beatsPerBar: 4,
      bpmMedian: 0,
      barSecMedian: 0,
      beatCount: 0,
      barCount: 0,
    },
  };
}

describe('空谱面（分析中）', () => {
  // durationSec = 0 是最危险的：曲库记录刚建好、还没读到时长
  for (const durationSec of [0, 185]) {
    describe(`durationSec = ${durationSec}`, () => {
      const a = emptyAnalysis(durationSec);

      it('内容总长是 0', () => {
        expect(totalTicksOf(a)).toBe(0);
      });

      it('TempoMap 可构造且能取值（不抛 RangeError）', () => {
        const tm = makeTempoMapFromSegments(a, a.tempoSegments ?? []);
        expect(() => bpmAt(tm, 0)).not.toThrow();
        expect(() => tickToSec(tm, 0)).not.toThrow();
        // 占位 BPM 必须为正，否则下游算小节时长会得到 Infinity
        expect(bpmAt(tm, 0)).toBeGreaterThan(0);
      });

      it('调性未知时返回空串（不是假的 C major）', () => {
        // 以前会走完打分循环：segs 为空 → 全是 0 分 → 保留初始值 'C'
        expect(inferKey(a)).toEqual({ tonic: '', mode: '' });
      });

      it('拍点为空时 snap 不产生 NaN', () => {
        const snap = makeBeatSnapper(a.beatsSec);
        expect(Number.isFinite(snap(3.2))).toBe(true);
      });

      it('各轨都是 0 片段', () => {
        const tracks = makeRealTracks(a, {
          bySecToTick: makeBeatSnapper(a.beatsSec),
          snapToBar: 0,
          minBeats: 1,
        });
        expect(Array.isArray(tracks)).toBe(true);
        for (const t of tracks) expect(t.clips.length).toBe(0);
      });
    });
  }
});
