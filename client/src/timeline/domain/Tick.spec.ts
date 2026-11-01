/**
 * Tick 模块测试 —— 对应 PRD A01（基础坐标）、A04（三连网格）
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  PPQ,
  MAX_TICK,
  assertTick,
  ceilToGrid,
  clamp,
  clampRange,
  contains,
  floorToGrid,
  gridStep,
  hull,
  intersection,
  intersects,
  isEmpty,
  isValidTick,
  length,
  quantize,
  snapToNearest,
  tickRange,
} from './Tick';

describe('A01 基础坐标：960 PPQ', () => {
  it('4/4 中第 3 小节起点 = 7680 Tick', () => {
    // 前两小节各 4 拍，每拍 960 tick
    const barTicks = 4 * PPQ;
    expect(barTicks).toBe(3840);
    expect(2 * barTicks).toBe(7680);
  });

  it('PPQ 是 960', () => {
    expect(PPQ).toBe(960);
  });

  it('所有事件存整数 Tick', () => {
    expect(() => assertTick(0)).not.toThrow();
    expect(() => assertTick(7680)).not.toThrow();
    expect(() => assertTick(1.5)).toThrow(TypeError);
    expect(() => assertTick(0.0001)).toThrow(TypeError);
  });

  it('拒绝负数与超上限', () => {
    expect(() => assertTick(-1)).toThrow(RangeError);
    expect(() => assertTick(MAX_TICK + 1)).toThrow(RangeError);
  });

  it('isValidTick 与 assertTick 一致', () => {
    for (const v of [0, 1, 960, 7680, MAX_TICK, -1, 1.5, MAX_TICK + 1, NaN]) {
      const ok = isValidTick(v);
      let threw = false;
      try {
        assertTick(v);
      } catch {
        threw = true;
      }
      expect(threw).toBe(!ok);
    }
  });
});

describe('A04 三连网格：1/3 拍 = 320 Tick', () => {
  it('1/3 拍正好 320 tick', () => {
    expect(gridStep(3)).toBe(320);
  });

  it('常用划分都是整数', () => {
    expect(gridStep(1)).toBe(960);
    expect(gridStep(2)).toBe(480);
    expect(gridStep(4)).toBe(240);
    expect(gridStep(8)).toBe(120);
    expect(gridStep(16)).toBe(60);
    expect(gridStep(6)).toBe(160);
    expect(gridStep(12)).toBe(80);
  });

  it('拖动/伸缩后首尾正确吸附到三连网格', () => {
    const step = gridStep(3); // 320
    // 首尾都落在 320 的倍数上
    for (const raw of [100, 319, 321, 500, 640, 999]) {
      const q = quantize(raw, step);
      expect(q % step).toBe(0);
      expect(Math.abs(q - raw)).toBeLessThanOrEqual(step / 2);
    }
  });

  it('quantize 在 halfway 时向上（Math.round 语义）', () => {
    expect(quantize(160, 320)).toBe(320); // 160 / 320 = 0.5 -> round(0.5) = 1
    expect(quantize(159, 320)).toBe(0);
  });
});

describe('区间语义：半开 [start, end)', () => {
  it('构造合法区间', () => {
    const r = tickRange(0, 960);
    expect(r.start).toBe(0);
    expect(r.end).toBe(960);
  });

  it('拒绝 end < start', () => {
    expect(() => tickRange(960, 0)).toThrow(RangeError);
  });

  it('允许零长度区间（end === start）', () => {
    const r = tickRange(960, 960);
    expect(isEmpty(r)).toBe(true);
    expect(length(r)).toBe(0);
  });

  it('contains 不含 end', () => {
    const r = tickRange(100, 200);
    expect(contains(r, 100)).toBe(true);
    expect(contains(r, 199)).toBe(true);
    expect(contains(r, 200)).toBe(false);
    expect(contains(r, 99)).toBe(false);
  });

  it('紧邻不算相交（这是和弦紧挨摆放的基础）', () => {
    const a = tickRange(0, 960);
    const b = tickRange(960, 1920);
    expect(intersects(a, b)).toBe(false);
    expect(intersection(a, b)).toBeNull();
  });

  it('真正重叠才算相交', () => {
    const a = tickRange(0, 1000);
    const b = tickRange(960, 1920);
    expect(intersects(a, b)).toBe(true);
    const i = intersection(a, b);
    expect(i).toEqual({ start: 960, end: 1000 });
  });

  it('零长度区间不与任何区间相交', () => {
    const point = tickRange(500, 500);
    const a = tickRange(0, 960);
    expect(intersects(point, a)).toBe(false);
  });
});

describe('网格与吸附工具', () => {
  it('floorToGrid / ceilToGrid', () => {
    expect(floorToGrid(1000, 960)).toBe(960);
    expect(ceilToGrid(1000, 960)).toBe(1920);
    expect(floorToGrid(960, 960)).toBe(960);
    expect(ceilToGrid(960, 960)).toBe(960);
  });

  it('quantize 拒绝非正/非整数步长', () => {
    expect(() => quantize(100, 0)).toThrow(RangeError);
    expect(() => quantize(100, -5)).toThrow(RangeError);
    expect(() => quantize(100, 1.5)).toThrow(RangeError);
  });

  it('snapToNearest 返回最近的候选', () => {
    expect(snapToNearest(900, [0, 960, 1920])).toBe(960);
    expect(snapToNearest(100, [0, 960])).toBe(0);
    expect(snapToNearest(500, [])).toBeNull();
    // 平局取先出现的
    expect(snapToNearest(480, [0, 960])).toBe(0);
  });

  it('clamp / clampRange', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);

    expect(clampRange({ start: -100, end: 200 }, 150)).toEqual({ start: 0, end: 150 });
    // start 被 clamp 超过 end 时，保证 start <= end
    expect(clampRange({ start: 200, end: 200 }, 150)).toEqual({ start: 150, end: 150 });
  });

  it('hull 取包围盒', () => {
    expect(hull(tickRange(0, 100), tickRange(50, 200))).toEqual({ start: 0, end: 200 });
    expect(hull(tickRange(500, 600), tickRange(0, 100))).toEqual({ start: 0, end: 600 });
  });
});

// ------------------------------------------------------------------ property-based
describe('Property-based：不变量', () => {
  const arbTick = fc.integer({ min: 0, max: MAX_TICK });
  const arbPositiveTick = fc.integer({ min: 1, max: MAX_TICK });

  // 只从**合法**的 division 里抽样。
  // gridStep 的类型签名已限制为 1|2|3|4|6|8|12|16，
  // 用 integer(1..16) 会喂进 5/7/11 这类非法值，测不出有效结论。
  const VALID_DIVISIONS = [1, 2, 3, 4, 6, 8, 12, 16] as const;
  const arbDivision = fc.constantFrom(...VALID_DIVISIONS);

  it('量化结果总是落在网格上', () => {
    fc.assert(
      fc.property(arbTick, arbDivision, (tick, division) => {
        const step = gridStep(division);
        const q = quantize(tick, step);
        return Number.isInteger(q) && q % step === 0;
      }),
    );
  });

  it('量化误差不超过半个步长', () => {
    fc.assert(
      fc.property(arbTick, arbDivision, (tick, division) => {
        const step = gridStep(division);
        const q = quantize(tick, step);
        return Math.abs(q - tick) <= step / 2 + 1e-9;
      }),
    );
  });

  it('gridStep 拒绝无法整除 PPQ 的划分', () => {
    // 960 能被 1,2,3,4,5,6,8,10,12,15,16... 整除，不能被 7/11 整除
    expect(() => gridStep(7 as never)).toThrow(RangeError);
    expect(() => gridStep(11 as never)).toThrow(RangeError);
  });

  it('任何合法区间都有 end >= start 且长度为非负', () => {
    fc.assert(
      fc.property(arbTick, arbTick, (a, b) => {
        const r = tickRange(Math.min(a, b), Math.max(a, b));
        return r.end >= r.start && length(r) >= 0;
      }),
    );
  });

  it('区间与自己相交当且仅当非空', () => {
    fc.assert(
      fc.property(arbTick, arbPositiveTick, (start, len) => {
        const r = tickRange(start, Math.min(start + len, MAX_TICK));
        if (isEmpty(r)) return true;
        return intersects(r, r);
      }),
    );
  });
});
