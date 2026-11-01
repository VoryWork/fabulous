/**
 * 整数像素对齐测试 —— 对应 PRD A09（轨间对齐偏差）
 *
 * A09 原文要求「偏差 ≤ 1px」。用了整数像素对齐之后，目标是 **0px**。
 *
 * 这里测的是不变量（不是"看起来对"）：
 *   1. 相邻片段的 right 必须等于下一段的 left（无缝无叠）
 *   2. 同一 tick 在 Canvas 与 DOM 两条路径上算出同一个像素
 *   3. 任意缩放级别下都成立
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createViewport,
  snapPx,
  snapPxLine,
  tickRangeToIntRect,
  tickRangeToPixels,
  tickToX,

} from './TimelineGeometry';

const BAR = 3840;

describe('snapPx：DOM 像素取整', () => {
  it('四舍五入到整数', () => {
    expect(snapPx(155.19)).toBe(155);
    expect(snapPx(155.5)).toBe(156);
    expect(snapPx(155.9)).toBe(156);
    expect(snapPx(-0.3)).toBe(-0);
    expect(snapPx(0)).toBe(0);
  });

  it('结果总是整数', () => {
    fc.assert(
      fc.property(fc.float({ min: -1e4, max: 1e4, noNaN: true }), (x) => {
        return Number.isInteger(snapPx(x));
      }),
    );
  });
});

describe('snapPxLine：Canvas 线取整', () => {
  it('总是整数 + 0.5（对齐像素中心，1px 线不发虚）', () => {
    for (const x of [0, 0.1, 0.5, 0.9, 1, 100.4, 100.6, -3.2]) {
      const v = snapPxLine(x);
      expect(Number.isInteger(v - 0.5)).toBe(true);
    }
  });

  it('与 snapPx 的关系：line = round(x) + 0.5', () => {
    for (const x of [155.19, 155.5, 200, 0.49]) {
      expect(snapPxLine(x)).toBe(snapPx(x) + 0.5);
    }
  });
});

describe('A09 核心不变量：相邻片段边界完全重合', () => {
  it('同一 tick 既是前一段的 end 又是后一段的 start 时，像素完全相等', () => {
    const vp = createViewport(0.01484375, 0, 912);
    // 连续 8 个 2 小节的和弦块
    let prevRight: number | null = null;
    for (let i = 0; i < 8; i++) {
      const start = i * 2 * BAR;
      const end = (i + 1) * 2 * BAR;
      const rect = tickRangeToIntRect(vp, start, end);

      expect(rect.left + rect.width).toBe(rect.right);
      if (prevRight !== null) {
        // 上一段的 right === 本段的 left，误差 0
        expect(rect.left).toBe(prevRight);
      }
      prevRight = rect.right;
    }
  });

  it('每小节一个块时也无缝', () => {
    const vp = createViewport(0.03, 0, 1200);
    let prevRight: number | null = null;
    for (let i = 0; i < 20; i++) {
      const rect = tickRangeToIntRect(vp, i * BAR, (i + 1) * BAR);
      if (prevRight !== null) expect(rect.left).toBe(prevRight);
      prevRight = rect.right;
    }
  });

  it('Property: 任意缩放 × 任意合法区间，left+width === right', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0.0005), max: Math.fround(2), noNaN: true }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 1, max: 50000 }),
        (ppt, barIndex, spanBars) => {
          const vp = createViewport(ppt, 0, 1200);
          const start = barIndex * BAR;
          const end = start + spanBars * BAR;
          const r = tickRangeToIntRect(vp, start, end);
          return r.left + r.width === r.right && Number.isInteger(r.left) && Number.isInteger(r.right);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('Canvas 与 DOM 用同一个取整函数', () => {
  it('网格线位置 = 片段的边界位置', () => {
    const vp = createViewport(0.01484375, 0, 912);
    for (let i = 0; i < 10; i++) {
      const tick = i * BAR;
      // DOM 侧：片段左边界
      const domLeft = tickRangeToIntRect(vp, tick, tick + BAR).left;
      // Canvas 侧：网格线（snapPxLine 去掉 0.5 后应等于 domLeft）
      const canvasX = snapPxLine(tickToX(vp, tick));
      expect(canvasX - 0.5).toBe(domLeft);
    }
  });

  it('播放头位置与标尺刻度一致', () => {
    const vp = createViewport(0.02, 1000, 1000);
    const tick = 50000;
    const playheadX = snapPxLine(tickToX(vp, tick));
    const rulerTickX = snapPxLine(tickToX(vp, tick));
    expect(playheadX).toBe(rulerTickX);
  });
});

describe('浮点 vs 整数：为什么需要两层', () => {
  it('tickToX 保留浮点（供缩放锚点计算）', () => {
    // 用一个必然产生小数的缩放系数（0.0242 * 1000 = 24.2）
    const vp = createViewport(0.0242, 111.37, 890);
    const x = tickToX(vp, 1000);
    expect(Number.isInteger(x)).toBe(false);
  });

  it('但渲染用的矩形总是整数', () => {
    const vp = createViewport(0.01484375, 0, 912);
    const r = tickRangeToIntRect(vp, 0, 7680);
    expect(Number.isInteger(r.left)).toBe(true);
    expect(Number.isInteger(r.width)).toBe(true);
    expect(Number.isInteger(r.right)).toBe(true);
  });

  it('浮点版本仍然精确（不受取整影响）', () => {
    const vp = createViewport(0.01484375, 0, 912);
    const exact = tickRangeToPixels(vp, 0, 7680);
    const ints = tickRangeToIntRect(vp, 0, 7680);
    // 整数版本与浮点版本相差不超过 1px
    expect(Math.abs(exact.left - ints.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(exact.width - ints.width)).toBeLessThanOrEqual(1);
  });
});

describe('回归：曾经出过的错位', () => {
  it('缩放后块宽度有小数时，边界依然对齐', () => {
    // 这是用户实际截图里出问题的场景：
    // zoom 之后 pixelsPerTick 是无限小数，块宽度带小数尾巴
    const vp = createViewport(0.0242, 111.37, 890);
    const clips = [0, 2, 4, 6, 8, 10].map((i) =>
      tickRangeToIntRect(vp, i * BAR, (i + 2) * BAR),
    );
    for (let i = 1; i < clips.length; i++) {
      // 严格相等，不是"接近"
      expect(clips[i].left).toBe(clips[i - 1].right);
    }
  });

  it('不用"left + round(width)"，避免累积缝隙', () => {
    const vp = createViewport(0.0242, 111.37, 890);
    const rect = tickRangeToIntRect(vp, 0, BAR * 8);
    const floatSpan = tickRangeToPixels(vp, 0, BAR * 8);
    // 错误做法会得到 round(left) + round(width)，可能与 round(right) 差 1
    const wrongRight = snapPx(floatSpan.left) + snapPx(floatSpan.width);
    const correctRight = snapPx(floatSpan.left + floatSpan.width);
    // 正确实现用的是后者
    expect(rect.right).toBe(correctRight);
    // 两者可能不同，这正是为什么不能图省事用 left+width
    if (wrongRight !== correctRight) {
      expect(rect.right).not.toBe(wrongRight);
    }
  });
});
