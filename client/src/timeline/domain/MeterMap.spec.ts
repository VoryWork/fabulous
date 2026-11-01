/**
 * MeterMap 模块测试 —— 对应 PRD A10（拍号内嵌）、A11（临时变拍）
 */
import { describe, expect, it } from 'vitest';
import {
  barAt,
  barLengthAt,
  barLinesInRange,
  barStartTick,
  barTicks,
  beatInBar,
  beatLinesInBar,
  beatTicks,
  createMeterMap,
  createMeterMap4_4,
  isDownbeat,
  meterAt,
  tickOfBar,
  withMeterEvent,
  withoutMeterEvent,
} from './MeterMap';
import { PPQ } from './Tick';

describe('基础：拍号与小节长度', () => {
  it('4/4 = 4 拍，每拍 960 tick，一小节 3840 tick', () => {
    expect(beatTicks(4, 4)).toBe(960);
    expect(barTicks(4, 4)).toBe(3840);
  });

  it('3/4 = 3 拍，一小节 2880 tick', () => {
    expect(beatTicks(3, 4)).toBe(960);
    expect(barTicks(3, 4)).toBe(2880);
  });

  it('6/8 以八分音符为一拍，一小节 2880 tick', () => {
    expect(beatTicks(6, 8)).toBe(480);
    expect(barTicks(6, 8)).toBe(2880);
  });

  it('2/2 以二分音符为一拍', () => {
    expect(beatTicks(2, 2)).toBe(1920);
    expect(barTicks(2, 2)).toBe(3840);
  });

  it('拒绝非法拍号', () => {
    expect(() => beatTicks(0, 4)).toThrow(RangeError);
    expect(() => beatTicks(4, 0)).toThrow(RangeError);
    expect(() => beatTicks(4.5, 4)).toThrow(RangeError);
  });
});

describe('A01 关联：4/4 中第 3 小节起点 = 7680 Tick', () => {
  const map = createMeterMap4_4();

  it('第 0/1/2/3 小节起点', () => {
    expect(tickOfBar(map, 0)).toBe(0);
    expect(tickOfBar(map, 1)).toBe(3840);
    expect(tickOfBar(map, 2)).toBe(7680);
    expect(tickOfBar(map, 3)).toBe(11520);
  });

  it('barAt 与 tickOfBar 互逆', () => {
    for (let bar = 0; bar < 20; bar++) {
      const start = tickOfBar(map, bar);
      expect(barAt(map, start)).toBe(bar);
      expect(barStartTick(map, start)).toBe(start);
    }
  });

  it('小节内的 tick 归属正确（半开）', () => {
    expect(barAt(map, 0)).toBe(0);
    expect(barAt(map, 3839)).toBe(0);
    expect(barAt(map, 3840)).toBe(1);
    expect(barAt(map, 7679)).toBe(1);
    expect(barAt(map, 7680)).toBe(2);
  });
});

describe('A10 拍号内嵌：Bridge 改 3/4 只影响该段', () => {
  // 前 8 个 4/4 小节（tick 0 ~ 30720），Bridge 从 tick 30720 开始变 3/4
  const BRIDGE_START = 8 * 3840; // 30720
  const map = createMeterMap([
    { startTick: 0, numerator: 4, denominator: 4 },
    { startTick: BRIDGE_START, numerator: 3, denominator: 4 },
  ]);

  it('Bridge 之前仍是 4/4', () => {
    expect(meterAt(map, 0).numerator).toBe(4);
    expect(meterAt(map, BRIDGE_START - 1).numerator).toBe(4);
    expect(barLengthAt(map, 0)).toBe(3840);
    expect(barLengthAt(map, BRIDGE_START - 1)).toBe(3840);
  });

  it('Bridge 之后变 3/4，小节长度 2880', () => {
    expect(meterAt(map, BRIDGE_START).numerator).toBe(3);
    expect(barLengthAt(map, BRIDGE_START)).toBe(2880);
    expect(barLengthAt(map, BRIDGE_START + 3000)).toBe(2880);
  });

  it('Bridge 起点仍是第 8 小节', () => {
    expect(barAt(map, BRIDGE_START)).toBe(8);
    expect(tickOfBar(map, 8)).toBe(BRIDGE_START);
  });

  it('Bridge 内小节按 2880 推进', () => {
    expect(tickOfBar(map, 9)).toBe(BRIDGE_START + 2880);
    expect(tickOfBar(map, 10)).toBe(BRIDGE_START + 2 * 2880);
    expect(tickOfBar(map, 11)).toBe(BRIDGE_START + 3 * 2880);
  });

  it('barAt 在变拍后正确', () => {
    // 第 9 小节起点
    const bar9 = BRIDGE_START + 2880;
    expect(barAt(map, bar9)).toBe(9);
    expect(barAt(map, bar9 - 1)).toBe(8);
  });

  it('变拍点被标记为 meterChange（渲染需要画粗线 + 拍号）', () => {
    const lines = barLinesInRange(map, BRIDGE_START - 3840, BRIDGE_START + 3840);
    const changeLine = lines.find((l) => l.tick === BRIDGE_START);
    expect(changeLine).toBeDefined();
    expect(changeLine!.isMeterChange).toBe(true);
    // 其他小节线不是变拍点
    const normalLine = lines.find((l) => l.barIndex === 7);
    expect(normalLine!.isMeterChange).toBe(false);
  });
});

describe('A11 临时变拍：Verse 内单小节 2/4 后恢复 4/4', () => {
  // 第 0–1 小节 4/4，第 2 小节单小节 2/4，第 3 小节起恢复 4/4
  const BAR2 = 2 * 3840; // 7680
  const BAR3 = BAR2 + 2 * 960; // 7680 + 1920 = 9600
  const map = createMeterMap([
    { startTick: 0, numerator: 4, denominator: 4 },
    { startTick: BAR2, numerator: 2, denominator: 4 },
    { startTick: BAR3, numerator: 4, denominator: 4 },
  ]);

  it('第 2 小节是 2/4，长度 1920', () => {
    expect(meterAt(map, BAR2).numerator).toBe(2);
    expect(barLengthAt(map, BAR2)).toBe(1920);
    expect(barAt(map, BAR2)).toBe(2);
  });

  it('第 3 小节恢复 4/4', () => {
    expect(meterAt(map, BAR3).numerator).toBe(4);
    expect(barLengthAt(map, BAR3)).toBe(3840);
    expect(barAt(map, BAR3)).toBe(3);
  });

  it('小节序号连续，不因变拍而跳号', () => {
    expect(tickOfBar(map, 0)).toBe(0);
    expect(tickOfBar(map, 1)).toBe(3840);
    expect(tickOfBar(map, 2)).toBe(7680);
    expect(tickOfBar(map, 3)).toBe(9600);
    expect(tickOfBar(map, 4)).toBe(9600 + 3840);
  });

  it('第 2 小节内有 2 个拍（3 条拍线含首尾）', () => {
    const beats = beatLinesInBar(map, 2);
    // 起点 + 中间拍线
    expect(beats).toEqual([BAR2 + 960]);
    expect(beatInBar(map, BAR2)).toBe(0);
    expect(beatInBar(map, BAR2 + 960)).toBe(1);
    expect(beatInBar(map, BAR2 + 1919)).toBe(1);
  });

  it('整段仍是一个连续的 Verse（不产生额外结构）', () => {
    // MeterMap 本身不含"段落"概念，这里验证它只看时间：
    // 变拍不改变 tick 的连续性
    for (let t = 0; t < BAR3 + 3840; t += 480) {
      expect(Number.isInteger(barAt(map, t))).toBe(true);
    }
  });
});

describe('弱起（pickup）', () => {
  // 4/4，弱起 1 个四分音符（从第 4 拍起唱）
  const map = createMeterMap4_4(PPQ);

  it('第 0 小节是弱起，长度 = pickupTicks', () => {
    expect(barLengthAt(map, 0)).toBe(PPQ);
    expect(barAt(map, 0)).toBe(0);
    expect(barAt(map, PPQ - 1)).toBe(0);
  });

  it('第 1 小节从 pickup 之后开始', () => {
    expect(tickOfBar(map, 1)).toBe(PPQ);
    expect(barAt(map, PPQ)).toBe(1);
  });

  it('第 2 小节起按 3840 推进', () => {
    expect(tickOfBar(map, 2)).toBe(PPQ + 3840);
    expect(tickOfBar(map, 3)).toBe(PPQ + 2 * 3840);
  });

  it('弱起不能长于第一个完整小节', () => {
    expect(() => createMeterMap4_4(3840)).toThrow(/必须短于第一个完整小节/);
  });
});

describe('强拍与拍内位置', () => {
  const map = createMeterMap4_4();

  it('isDownbeat 只在小节起点为 true', () => {
    expect(isDownbeat(map, 0)).toBe(true);
    expect(isDownbeat(map, 960)).toBe(false);
    expect(isDownbeat(map, 3840)).toBe(true);
    expect(isDownbeat(map, 3840 + 959)).toBe(false);
  });

  it('beatInBar 返回 0..numerator-1', () => {
    for (let beat = 0; beat < 4; beat++) {
      expect(beatInBar(map, beat * 960)).toBe(beat);
    }
  });

  it('6/8 的 beatInBar', () => {
    const m68 = createMeterMap([{ startTick: 0, numerator: 6, denominator: 8 }]);
    // 一拍 480 tick
    expect(beatInBar(m68, 0)).toBe(0);
    expect(beatInBar(m68, 480)).toBe(1);
    expect(beatInBar(m68, 480 * 5)).toBe(5);
  });
});

describe('小节线生成（渲染用）', () => {
  const map = createMeterMap4_4();

  it('区间内的小节线', () => {
    const lines = barLinesInRange(map, 0, 3840 * 3);
    expect(lines.map((l) => l.tick)).toEqual([0, 3840, 7680, 11520]);
    expect(lines.map((l) => l.barIndex)).toEqual([0, 1, 2, 3]);
  });

  it('区间起点在小节中间时，包含该小节起点', () => {
    const lines = barLinesInRange(map, 1000, 4000);
    expect(lines[0].tick).toBe(0);
    expect(lines[0].barIndex).toBe(0);
    expect(lines.map((l) => l.tick)).toContain(3840);
  });

  it('有 maxBars 保护，不会无限循环', () => {
    const lines = barLinesInRange(map, 0, 10_000_000, 100);
    expect(lines.length).toBeLessThanOrEqual(100);
  });
});

describe('拍号事件增删', () => {
  const map = createMeterMap4_4();

  it('withMeterEvent 追加变拍', () => {
    const next = withMeterEvent(map, { startTick: 3840, numerator: 3, denominator: 4 });
    expect(next.events).toHaveLength(2);
    expect(meterAt(next, 3840).numerator).toBe(3);
  });

  it('withMeterEvent 替换同位置', () => {
    const next = withMeterEvent(map, { startTick: 0, numerator: 6, denominator: 8 });
    expect(next.events).toHaveLength(1);
    expect(meterAt(next, 0).numerator).toBe(6);
  });

  it('withoutMeterEvent 移除变拍', () => {
    const withEvt = withMeterEvent(map, { startTick: 3840, numerator: 3, denominator: 4 });
    const removed = withoutMeterEvent(withEvt, 3840);
    expect(removed.events).toHaveLength(1);
    expect(meterAt(removed, 3840).numerator).toBe(4);
  });

  it('不能移除 tick 0 的初始拍号', () => {
    expect(() => withoutMeterEvent(map, 0)).toThrow(RangeError);
  });
});

describe('构造校验', () => {
  it('至少一个拍号事件', () => {
    expect(() => createMeterMap([])).toThrow(RangeError);
  });

  it('第一个事件必须从 tick 0 开始', () => {
    expect(() => createMeterMap([{ startTick: 100, numerator: 4, denominator: 4 }])).toThrow(
      /必须从 tick 0 开始/,
    );
  });

  it('事件必须严格递增', () => {
    expect(() =>
      createMeterMap([
        { startTick: 0, numerator: 4, denominator: 4 },
        { startTick: 0, numerator: 3, denominator: 4 },
      ]),
    ).toThrow(/严格递增/);
  });

  it('pickupTicks 必须是非负整数', () => {
    expect(() => createMeterMap4_4(-1)).toThrow(RangeError);
    expect(() => createMeterMap4_4(1.5)).toThrow(RangeError);
  });
});

describe('一致性：barLinesInRange 与 tickOfBar 对齐', () => {
  it('多段变拍下，小节线 tick 与小节序号严格一致', () => {
    const map = createMeterMap([
      { startTick: 0, numerator: 4, denominator: 4 },
      { startTick: 4 * 3840, numerator: 7, denominator: 8 },
      { startTick: 4 * 3840 + 2 * 3360, numerator: 3, denominator: 4 },
    ]);

    let bar = 0;
    let guard = 0;
    while (bar < 20 && guard++ < 100) {
      const expected = tickOfBar(map, bar);
      const start = barStartTick(map, expected);
      expect(start).toBe(expected);
      expect(barAt(map, expected)).toBe(bar);
      bar++;
    }
  });
});
