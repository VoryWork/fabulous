/**
 * 假数据 —— 用于 M1 阶段的 UI 验证。
 *
 * 设计原则：
 *   1. 用**真实的音乐结构**而不是随机数据。
 *      前 60 秒用《Refrain》实测的 G–D–Em–C（I–V–vi–IV）进行，
 *      和弦边界与 beat_this 的小节边界对齐，这样 UI 看起来是可信的。
 *   2. 包含故意设计的边界情况：跨小节的段落、重叠的级数解释、
 *      多行歌词、变拍段落。
 *   3. 所有 tick 都是 960 PPQ 下的整数。
 *
 * 数据来自 ADR-0001 / ADR-0002 的实测结果：
 *   - BPM 78.95，4/4，386 拍 / 99 小节
 *   - submission 档 139 段，前 20 秒为 G:maj | D:maj/3 | E:min7 | D:maj | C:maj/5
 */

import type { TempoMapData } from '../domain/TempoMap';
import { createConstantTempoMap } from '../domain/TempoMap';
import type { MeterMapData } from '../domain/MeterMap';
import { createMeterMap } from '../domain/MeterMap';
import type { TrackKind } from '../design/tokens';

export interface FakeClip {
  id: string;
  startTick: number;
  endTick: number;
  /** 主标签（和弦名 / 段落名 / 调性） */
  label: string;
  /** 副标签（级数解释 / 状态） */
  sublabel?: string;
  /** 校对状态 */
  state?: 'draft' | 'confirmed' | 'rejected';
  /** 置信度 0-1，用于显示透明度或角标 */
  confidence?: number;
  /** 是否被选中（用于演示选中态） */
  selected?: boolean;
  /**
   * 级数解释的父和弦事件 id。
   * 设了它之后，级数块的时间范围由父和弦投影，跟随编辑。
   */
  parentId?: string;
}

export interface FakeTrack {
  id: string;
  kind: TrackKind;
  name: string;
  /** 轨道的分析层（多重解释用） */
  layer?: string;
  /** 是否可见 */
  visible: boolean;
  /** 是否被锁定 */
  locked?: boolean;
  clips: FakeClip[];
}

const BPM = 78.95;
const PPQ = 960;
const TICKS_PER_BAR = 4 * PPQ; // 3840
const DURATION_SEC = 290.15;

/** 一拍换算成秒：60 / 78.95 ≈ 0.7600s */
export const SEC_PER_BEAT = 60 / BPM;
export const SEC_PER_BAR = SEC_PER_BEAT * 4;

/**
 * TempoMap：恒速 78.95 BPM（实测值）。
 *
 * 用 BPM 而不是 (tick, sec)：这是用户确认的模型 ——
 * BPM 是音乐语义，小节时长 = 拍数 × 60/bpm。
 */
export function makeDemoTempoMap(): TempoMapData {
  return createConstantTempoMap(BPM, DURATION_SEC);
}

/**
 * MeterMap：4/4 为主，在第 24 小节插入一个单小节 3/4（演示 A11）。
 */
export function makeDemoMeterMap(): MeterMapData {
  const bar24 = 24 * TICKS_PER_BAR; // 92160
  return createMeterMap([
    { startTick: 0, numerator: 4, denominator: 4 },
    { startTick: bar24, numerator: 3, denominator: 4 },
    { startTick: bar24 + 3 * PPQ, numerator: 4, denominator: 4 },
  ]);
}

/** 为了排版简单，所有假数据都只做前 40 小节 */
export const DEMO_BARS = 40;

function bar(n: number): number {
  return n * TICKS_PER_BAR;
}

/** 每个和弦占 2 小节（实测约 2 小节换一次和弦） */
const CHORDS: Array<[string, number]> = [
  // [和弦名, 起始小节]
  ['G:maj', 0],
  ['D:maj/3', 2],
  ['E:min7', 4],
  ['D:maj', 6],
  ['C:maj/5', 7],
  ['G:maj', 9],
  ['D:maj', 11],
  ['E:min7', 13],
  ['C:maj', 15],
  ['G:maj', 17],
  ['B:min7', 19],
  ['C:maj', 20],
  ['A:min7', 21],
  ['D:7', 22],
  ['G:maj', 24],
  ['E:min', 26],
  ['C:maj7', 28],
  ['D:maj', 30],
  ['G:maj', 32],
  ['D:maj/3', 34],
  ['E:min7', 36],
  ['C:maj', 38],
];

/** 级数解释（submission 档下的相对级数） */
const DEGREES = [
  'I',
  'V/3',
  'vi7',
  'V',
  'IV/5',
  'I',
  'V',
  'vi7',
  'IV',
  'I',
  'iii7',
  'IV',
  'ii7',
  'V7',
  'I',
  'vi',
  'IVmaj7',
  'V',
  'I',
  'V/3',
  'vi7',
  'IV',
];

function chordClips(): FakeClip[] {
  const clips: FakeClip[] = [];
  for (let i = 0; i < CHORDS.length; i++) {
    const [label, startBar] = CHORDS[i];
    const nextStartBar = CHORDS[i + 1]?.[1] ?? DEMO_BARS;
    // 第 24 小节是 3/4，长度按 3 拍算
    const endTick =
      startBar === 24 ? bar(24) + 3 * PPQ + (nextStartBar - 25) * TICKS_PER_BAR : bar(nextStartBar);
    clips.push({
      id: `chord-${i}`,
      startTick: bar(startBar),
      endTick,
      label,
      sublabel: DEGREES[i],
      // 前几个已确认，中间是 draft，最后几个被 reject 演示状态色
      state: i < 4 ? 'confirmed' : i < 18 ? 'draft' : 'confirmed',
      confidence: i < 4 ? 0.96 : 0.72 + ((i * 7) % 20) / 100,
      selected: i === 5,
    });
  }
  return clips;
}

/** 段落结构 */
function sectionClips(): FakeClip[] {
  return [
    { id: 'sec-0', startTick: bar(0), endTick: bar(4), label: 'Intro', state: 'confirmed' },
    { id: 'sec-1', startTick: bar(4), endTick: bar(9), label: 'Verse 1', state: 'confirmed' },
    { id: 'sec-2', startTick: bar(9), endTick: bar(17), label: 'Pre-Chorus', state: 'confirmed' },
    { id: 'sec-3', startTick: bar(17), endTick: bar(24), label: 'Chorus', state: 'draft', confidence: 0.81 },
    { id: 'sec-4', startTick: bar(24), endTick: bar(28), label: 'Bridge', state: 'draft', confidence: 0.64 },
    { id: 'sec-5', startTick: bar(28), endTick: bar(36), label: 'Chorus', state: 'draft', confidence: 0.88 },
    { id: 'sec-6', startTick: bar(36), endTick: bar(40), label: 'Outro', state: 'draft', confidence: 0.77 },
  ];
}

/** 调性上下文（可重叠的多个分析层） */
function keyClips(): FakeClip[] {
  return [
    { id: 'key-0', startTick: bar(0), endTick: bar(24), label: 'G major', state: 'confirmed' },
    // 第 24 小节起转调，这是演示"枢纽和弦双解释"的位置
    { id: 'key-1', startTick: bar(24), endTick: bar(40), label: 'C major', state: 'draft', confidence: 0.69 },
  ];
}

/** 级数解释轨（演示 PRD §5.1 的多重解释） */
function degreeClips(): FakeClip[] {
  return [
    // 第一层：G 大调下的解释（覆盖整个前半）
    ...DEGREES.slice(0, 18).map((d, i) => {
      const [, startBar] = CHORDS[i];
      const nextStartBar = CHORDS[i + 1]?.[1] ?? 24;
      return {
        id: `deg-a-${i}`,
        // 时间范围由父和弦投影（parentId），这里的 tick 只是兜底值
        startTick: bar(startBar),
        endTick: bar(nextStartBar),
        label: d,
        sublabel: 'G major',
        state: 'confirmed' as const,
        parentId: `chord-${i}`,
      };
    }),
    // 第二层：从第 20 小节起，同一批和弦用 C 大调视角重新解释（重叠！）
    ...CHORDS.slice(11, 18).map(([, startBar], k) => {
      const i = k + 11;
      const nextStartBar = CHORDS[i + 1]?.[1] ?? 24;
      const alt = ['V', 'iii', 'vi', 'IV', 'I', 'iii7', 'IV'][k] ?? '?';
      return {
        id: `deg-b-${k}`,
        startTick: bar(startBar),
        endTick: bar(nextStartBar),
        label: alt,
        sublabel: 'C major',
        state: 'draft' as const,
        confidence: 0.58,
        parentId: `chord-${i}`,
      };
    }),
  ];
}

/** 歌词轨 */
function lyricClips(): FakeClip[] {
  const lines = [
    ['ねえ 忘れないで', 4],
    ['君と見た景色を', 6],
    ['今もまだ 探してる', 8],
    ['遠い遠い記憶', 11],
    ['この声が届くなら', 13],
    ['もう一度だけ', 15],
    ['Refrain, refrain', 17],
    ['繰り返すメロディ', 19],
    ['心の奥で響いて', 21],
    ['離さないで', 23],
  ] as const;
  return lines.map(([text, startBar], i) => ({
    id: `lyric-${i}`,
    startTick: bar(startBar),
    endTick: bar(startBar + 2),
    label: text,
    state: 'confirmed' as const,
  }));
}

export function makeDemoTracks(): FakeTrack[] {
  return [
    { id: 'tr-section', kind: 'section', name: '段落结构', visible: true, clips: sectionClips() },
    { id: 'tr-key', kind: 'key', name: '调性上下文', visible: true, clips: keyClips() },
    {
      id: 'tr-chord',
      kind: 'chord',
      name: '绝对和弦',
      visible: true,
      clips: chordClips(),
    },
    {
      id: 'tr-degree-a',
      kind: 'degree',
      name: '级数解释',
      layer: 'G major',
      visible: true,
      clips: degreeClips().filter((c) => c.id.startsWith('deg-a')),
    },
    {
      id: 'tr-degree-b',
      kind: 'degree',
      name: '级数解释',
      layer: 'C major',
      visible: true,
      clips: degreeClips().filter((c) => c.id.startsWith('deg-b')),
    },
    { id: 'tr-lyric', kind: 'lyric', name: '歌词', visible: true, clips: lyricClips() },
  ];
}

/** 曲目元信息（给顶部工具栏用） */
export const DEMO_SONG = {
  title: 'Refrain',
  artist: 'Aimer',
  durationSec: DURATION_SEC,
  bpm: BPM,
  key: 'G major',
  meter: '4/4',
  /** 当前分析档位 */
  dictionary: 'submission' as 'submission' | 'ismir2017' | 'full',
  beats: 386,
  bars: 99,
  chordSegments: 139,
};
