/**
 * TempoMap 的秒 ⇄ tick 换算必须是**互逆**的，尤其是 `startSec != 0` 时。
 *
 * ## 这个 bug 长什么样
 *
 * 用户：「在标尺上选点后，似乎会直接忽略补齐的静音段开始播放，造成没对齐」。
 *
 * 根因：`secToTick` 的两个早退分支直接拿**绝对秒数**乘 `ticksPerSecond`，
 * 忘了减 `startSec`。而 `tickToSec` 的对应分支是加了的 —— 于是两者不对称：
 *
 *   补了开头虚拟小节后 startSec = 0.10
 *   tickToSec(0)    = 0.10s          ✓
 *   secToTick(0.10) = 0.10 × 1440 = 144   ✗（应该是 0）
 *
 * 表现就是点第 1 小节、播放头却落在第 144 tick；播放时两者互相追不上。
 *
 * ## 为什么以前没暴露
 *
 * `startSec` 一直是 0（第一拍就在 0 秒），减不减都一样。
 * 加了「开头补虚拟小节」之后 startSec 变成 0.10，问题才显形。
 */
import { describe, expect, it } from 'vitest';
import {
  createConstantTempoMap,
  createTempoMap,
  secToTick,
  tickToSec,
} from './TempoMap';
import { makeRealTempoMap } from '../demo/realData';
import { PPQ } from './Tick';

describe('TempoMap 秒 ⇄ tick 对称性', () => {
  /** 90 BPM、startSec = 0.10（《何なんw》补小节的真实场景） */
  const map = createConstantTempoMap(90, 300, 0.1);

  it('tick 0 对应 startSec', () => {
    expect(tickToSec(map, 0)).toBeCloseTo(0.1, 6);
  });

  it('startSec 对应 tick 0（关键：往返一致）', () => {
    expect(secToTick(map, 0.1)).toBe(0);
  });

  it('多个位置往返一致', () => {
    for (const tick of [0, 960, 3840, 19200, 460800]) {
      const sec = tickToSec(map, tick);
      expect(secToTick(map, sec)).toBe(tick);
    }
  });

  it('startSec 之前的秒数是负 tick（谱面之外）', () => {
    expect(secToTick(map, 0)).toBeLessThan(0);
    expect(secToTick(map, 0.05)).toBeLessThan(0);
  });

  it('单锚点（points.length === 1）时也对称', () => {
    const one = createTempoMap([{ tick: 0, bpm: 120 }], 100, 2.5);
    expect(tickToSec(one, 0)).toBeCloseTo(2.5, 6);
    expect(secToTick(one, 2.5)).toBe(0);
    expect(secToTick(one, tickToSec(one, 4 * PPQ))).toBe(4 * PPQ);
  });

  it('startSec = 0 时行为不变（老数据不受影响）', () => {
    const zero = createConstantTempoMap(120, 100, 0);
    expect(tickToSec(zero, 0)).toBe(0);
    expect(secToTick(zero, 0)).toBe(0);
    expect(secToTick(zero, 1)).toBe(1920); // 120 BPM：每秒 2 拍 = 1920 tick
  });

  it('多锚点 + startSec 也往返一致', () => {
    const multi = createTempoMap(
      [
        { tick: 0, bpm: 90 },
        { tick: 4 * PPQ, bpm: 120 },
        { tick: 8 * PPQ, bpm: 100 },
      ],
      200,
      0.25,
    );
    for (const tick of [0, 960, 4 * PPQ, 6 * PPQ, 8 * PPQ, 12 * PPQ]) {
      expect(secToTick(multi, tickToSec(multi, tick))).toBe(tick);
    }
  });
});

/**
 * `makeRealTempoMap` 的空态防御。
 *
 * ## 为什么必须有这组测试
 *
 * 把 tempoMap 从 `makeTempoMapFromSegments`（有兜底）换成
 * `makeRealTempoMap`（没兜底）之后，**整个前端白屏了**。
 *
 * `createTempoMap` 遇到非法输入是直接抛 `RangeError` 的，而 Vue 的
 * computed 抛错 = 整页白屏。歌还没分析完时三条同时成立：
 *
 *   downbeatsSec = []      → (0-1)×BAR 是负数 tick
 *   meta.bpmMedian = 0     → 「bpm 必须为正有限数」
 *   song.durationSec = 0   → 「durationSec 必须为正有限数」
 *
 * 白屏是最糟的失败方式：用户看不到任何信息，也没法自己恢复。
 * 所以这里锁死「任何空/脏数据都不能抛」。
 */
describe('makeRealTempoMap 空态防御', () => {
  const empty = (): any => ({
    song: { title: '', artist: '', durationSec: 0 },
    downbeatsSec: [],
    beatsSec: [],
    chords: {},
    meta: { beatsPerBar: 4, bpmMedian: 0, barSecMedian: 0, beatCount: 0, barCount: 0 },
  });

  it('全空数据不抛错（曾经白屏的元凶）', () => {
    expect(() => makeRealTempoMap(empty())).not.toThrow();
    const map = makeRealTempoMap(empty());
    expect(tickToSec(map, 0)).toBe(0);
  });

  it('只有 1 个小节也不抛', () => {
    const a = empty();
    a.downbeatsSec = [1.5];
    a.song.durationSec = 100;
    a.meta.bpmMedian = 90;
    expect(() => makeRealTempoMap(a)).not.toThrow();
    expect(tickToSec(makeRealTempoMap(a), 0)).toBeCloseTo(1.5, 6);
  });

  it('bpmMedian 为 0 但有拍点时，用 120 兜底而不是抛', () => {
    const a = empty();
    a.downbeatsSec = [0, 2, 4, 6];
    a.song.durationSec = 100;
    a.meta.bpmMedian = 0;
    expect(() => makeRealTempoMap(a)).not.toThrow();
  });

  it('durationSec 为 0 时也能构造出来', () => {
    const a = empty();
    a.downbeatsSec = [0, 2, 4];
    a.meta.bpmMedian = 120;
    expect(() => makeRealTempoMap(a)).not.toThrow();
  });

  it('正常数据：tick k×BAR 精确对应 downbeats[k]', () => {
    const a = empty();
    a.downbeatsSec = [0.1, 2.76, 5.42, 8.08]; // 每小节 2.66s ≈ 90.2 BPM
    a.song.durationSec = 20;
    a.meta.bpmMedian = 90.2;
    const map = makeRealTempoMap(a);
    for (let k = 0; k < a.downbeatsSec.length; k++) {
      expect(tickToSec(map, k * 4 * PPQ)).toBeCloseTo(a.downbeatsSec[k], 2);
    }
  });

  it('正常数据往返一致', () => {
    const a = empty();
    a.downbeatsSec = [0.1, 2.76, 5.42, 8.08];
    a.song.durationSec = 20;
    a.meta.bpmMedian = 90.2;
    const map = makeRealTempoMap(a);
    for (const tick of [0, 960, 4 * PPQ, 8 * PPQ]) {
      expect(secToTick(map, tickToSec(map, tick))).toBe(tick);
    }
  });
});
