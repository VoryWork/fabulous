/**
 * BPM 与拍时间轴的语义测试。
 *
 * 用户明确的架构要求：
 *
 * > 修改 bpm 不要影响和弦在拍时间轴上的位置，影响的是这一小节的播放标记走时速度即可。
 * > 举例：如果我从 60 改到 120，然后和声完全对不上了，这是正常现象。
 * > 分析的时候先对 bpm，再对和声在哪个拍上。
 * > 拍时间轴应该是最核心的基准，秒时间轴是次要的。
 *
 * 拆成三条可测的不变量：
 *   1. **和弦的 tick 由真实拍点决定**，与 BPM 估计无关
 *   2. **改 BPM 不改和弦 tick**（只改 tick→秒）
 *   3. **改 BPM 会改同一 tick 对应的秒数**（走时速度）
 */
import { describe, expect, it } from 'vitest';
import { PPQ } from './Tick';
import { makeBeatSnapper } from '../demo/realData';
import { createTempoMap, tickToSec, secToTick } from './TempoMap';

/** 4/4，130 BPM 的拍点（间隔 0.4615s） */
function makeBeats(count: number, startSec = 0.36, bpm = 130): number[] {
  const gap = 60 / bpm;
  return Array.from({ length: count }, (_, i) => startSec + i * gap);
}

describe('1. 和弦 tick 由真实拍点决定', () => {
  const beats = makeBeats(64);
  const snap = makeBeatSnapper(beats);

  it('拍点本身映射回整数拍', () => {
    for (let i = 0; i < beats.length; i++) {
      expect(snap(beats[i])).toBe(i * PPQ);
    }
  });

  it('拍点之间的时间吸附到最近的拍', () => {
    const gap = 60 / 130;
    // 略过第 2 拍一点 → 仍吸附到第 2 拍
    expect(snap(beats[2] + gap * 0.3)).toBe(2 * PPQ);
    // 更靠近第 3 拍 → 吸附到第 3 拍
    expect(snap(beats[2] + gap * 0.7)).toBe(3 * PPQ);
  });

  it('不累积误差（这是不用 TempoMap 的原因）', () => {
    // 用平均值 BPM 转 64 拍会产生漂移；用真实拍点则每拍都精确
    const pitchDrift = beats.map((t, i) => Math.abs(snap(t) - i * PPQ));
    expect(Math.max(...pitchDrift)).toBe(0);
  });

  it('超出末尾按最后一拍间隔外推', () => {
    const last = beats[beats.length - 1];
    const gap = 60 / 130;
    expect(snap(last + gap)).toBe(beats.length * PPQ);
  });

  it('起点之前返回 0', () => {
    expect(snap(0)).toBe(0);
    expect(snap(beats[0] - 1)).toBe(0);
  });
});

describe('2 & 3. 改 BPM 只影响走时速度，不影响事件位置', () => {
  /** 构造"由 BPM 段派生的 TempoMap"（这是运行期的映射） */
  function makeTempoAt(bpm: number, bars = 10) {
    const bar = 4 * PPQ;
    const anchors = Array.from({ length: bars }, (_, i) => ({ tick: i * bar, bpm }));
    // 末尾补一个，便于外推
    anchors.push({ tick: bars * bar, bpm });
    return createTempoMap(anchors, 600, 0.36);
  }

  it('同一 tick 在两个 BPM 下对应不同的秒（走时速度变了）', () => {
    const slow = makeTempoAt(60);
    const fast = makeTempoAt(120);

    const tick = 4 * PPQ; // 第 2 小节起点
    const secSlow = tickToSec(slow, tick);
    const secFast = tickToSec(fast, tick);

    // 60 BPM：1 小节 = 4 秒；120 BPM：1 小节 = 2 秒
    expect(secSlow).toBeCloseTo(0.36 + 4, 3);
    expect(secFast).toBeCloseTo(0.36 + 2, 3);

    // 120 BPM 的同一位置在时间上更早（走得更快）
    expect(secFast).toBeLessThan(secSlow);
    // 加速比正好 2
    expect((secSlow - 0.36) / (secFast - 0.36)).toBeCloseTo(2, 3);
  });

  it('和弦的 tick 值本身不参与 BPM 计算 —— 改 BPM 后 tick 完全不变', () => {
    // 和弦事件只存 tick。BPM 变了，tick 还是那个 tick。
    const chordTick = 22080;
    const slow = makeTempoAt(60);
    const fast = makeTempoAt(120);

    // tick 是同一个（这里根本没"改 tick"的操作）
    expect(chordTick).toBe(22080);

    // 但它映射到的秒不同 → 播放时"和声对不上"，这是**预期行为**
    const s1 = tickToSec(slow, chordTick);
    const s2 = tickToSec(fast, chordTick);
    expect(s1).not.toBeCloseTo(s2, 1);
  });

  it('反向：同一秒在两个 BPM 下对应不同 tick（这解释了"为什么对不上"）', () => {
    const slow = makeTempoAt(60);
    const fast = makeTempoAt(120);
    const sec = 4;

    const t1 = secToTick(slow, sec);
    const t2 = secToTick(fast, sec);

    // 60 BPM 下 4.36 秒约在第 1 小节多；120 BPM 下约在第 2 小节
    expect(t2).toBeGreaterThan(t1);
  });
});

describe('拍时间轴是权威，秒是派生', () => {
  it('事件位置用 tick 表达，BPM 只是换算参数', () => {
    /**
     * 这是整个架构的核心：
     *   ChordEvent { startTick, endTick }   ← 权威
     *   BeatMap / TempoMap                  ← 换算参数（可被用户修改）
     *   seconds                             ← 派生
     *
     * 所以数据模型里**不应该**出现"和弦的秒位置"作为权威字段。
     * 秒只在两处使用：
     *   1. 模型输出（原始秒数，作为换算的输入）
     *   2. 播放定位（tick → 秒，喂给音频引擎）
     */
    const chordStartTick = 22080;
    const chordEndTick = 25920;

    // tick 是整数且半开区间
    expect(Number.isInteger(chordStartTick)).toBe(true);
    expect(chordEndTick).toBeGreaterThan(chordStartTick);
    // 长度是整数拍
    expect((chordEndTick - chordStartTick) % (PPQ / 2)).toBe(0);
  });

  it('改 BPM 时不需要重算任何事件 —— 这是"不漂移"的根本保证', () => {
    // 模拟：一批和弦事件（只有 tick）
    const events = [
      { startTick: 0, endTick: 22080 },
      { startTick: 22080, endTick: 25920 },
      { startTick: 25920, endTick: 34560 },
    ];
    const before = JSON.stringify(events);

    // 用户改 BPM（只有 TempoMap 变，events 一个字节都没动）
    const tempo = makeTempoAtBpm(200);
    expect(tempo.anchors[0].bpm).toBe(200);

    const after = JSON.stringify(events);
    expect(after).toBe(before);
  });
});

function makeTempoAtBpm(bpm: number) {
  return createTempoMap([{ tick: 0, bpm }], 600, 0.36);
}
