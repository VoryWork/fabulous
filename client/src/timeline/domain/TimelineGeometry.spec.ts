/**
 * TimelineGeometry 模块测试 —— 对应 PRD A06（Zoom 锚点）、A09（轨间对齐基础）
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MAX_PIXELS_PER_TICK,
  MIN_PIXELS_PER_TICK,
  centerOnTick,
  clampScroll,
  contentWidthPx,
  createViewport,
  fitToContent,
  isVisible,
  resizeViewport,
  scrollByPixels,
  scrollToTick,
  setZoomAtX,
  tickRangeToPixels,
  tickToX,
  visibleEndTick,
  visibleRange,
  xToTick,
  xToTickFloat,
  zoomAtCenter,
  zoomAtX,
} from './TimelineGeometry';

const vp = () => createViewport(0.1, 0, 1000); // 0.1 px/tick，宽 1000px

describe('A06 Zoom 锚点：缩放后同一 Tick 的屏幕 X 偏差 ≤ 1px', () => {
  it('以鼠标位置为锚点放大', () => {
    const v0 = createViewport(0.1, 0, 1000);
    const anchorX = 500;
    const tickAtAnchorBefore = xToTickFloat(v0, anchorX);

    const v1 = zoomAtX(v0, anchorX, 2);

    // 锚点处的 tick 应保持不变
    const tickAtAnchorAfter = xToTickFloat(v1, anchorX);
    expect(tickAtAnchorAfter).toBeCloseTo(tickAtAnchorBefore, 9);

    // 屏幕 X 偏差 ≤ 1px
    const xAfter = tickToX(v1, tickAtAnchorBefore);
    expect(Math.abs(xAfter - anchorX)).toBeLessThanOrEqual(1);
  });

  it('以鼠标位置为锚点缩小', () => {
    const v0 = createViewport(0.1, 5000, 1000);
    const anchorX = 200;
    const tickBefore = xToTickFloat(v0, anchorX);

    const v1 = zoomAtX(v0, anchorX, 0.5);

    const xAfter = tickToX(v1, tickBefore);
    expect(Math.abs(xAfter - anchorX)).toBeLessThanOrEqual(1);
  });

  it('Property: 任意锚点位置 × 任意缩放倍数，X 偏差 ≤ 1px', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(1000), noNaN: true }), // anchorX
        fc.float({ min: Math.fround(0.05), max: Math.fround(20), noNaN: true }), // factor
        fc.float({ min: Math.fround(0.001), max: Math.fround(1), noNaN: true }), // pixelsPerTick
        fc.integer({ min: 0, max: 100000 }), // scrollTick
        (anchorX, factor, ppt, scroll) => {
          const v0 = createViewport(ppt, scroll, 1000);
          const tickBefore = xToTickFloat(v0, anchorX);
          const v1 = zoomAtX(v0, anchorX, factor);
          const xAfter = tickToX(v1, tickBefore);
          return Math.abs(xAfter - anchorX) <= 1;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('缩放被限制在可读范围内', () => {
    const v0 = createViewport(0.1, 0, 1000);
    const tiny = zoomAtX(v0, 500, 1e-9);
    expect(tiny.pixelsPerTick).toBeGreaterThanOrEqual(MIN_PIXELS_PER_TICK);

    const huge = zoomAtX(v0, 500, 1e9);
    expect(huge.pixelsPerTick).toBeLessThanOrEqual(MAX_PIXELS_PER_TICK);
  });

  it('以中心缩放也保持中心 tick 不变', () => {
    const v0 = createViewport(0.1, 0, 1000);
    const centerTick = xToTickFloat(v0, 500);
    const v1 = zoomAtCenter(v0, 3);
    expect(xToTickFloat(v1, 500)).toBeCloseTo(centerTick, 9);
  });

  it('setZoomAtX 设置绝对缩放并保持锚点', () => {
    const v0 = createViewport(0.1, 0, 1000);
    const tickBefore = xToTickFloat(v0, 300);
    const v1 = setZoomAtX(v0, 300, 0.25);
    expect(v1.pixelsPerTick).toBeCloseTo(0.25, 9);
    expect(xToTickFloat(v1, 300)).toBeCloseTo(tickBefore, 9);
  });

  it('多次连续缩放不累积漂移', () => {
    let v = createViewport(0.1, 0, 1000);
    const anchorX = 400;
    const tick = xToTickFloat(v, anchorX);
    for (let i = 0; i < 20; i++) {
      v = zoomAtX(v, anchorX, 1.1);
    }
    for (let i = 0; i < 20; i++) {
      v = zoomAtX(v, anchorX, 1 / 1.1);
    }
    // 20 次放大再 20 次缩小，锚点 tick 应回到原位
    expect(xToTickFloat(v, anchorX)).toBeCloseTo(tick, 5);
    expect(tickToX(v, tick)).toBeCloseTo(anchorX, 5);
  });
});

describe('坐标换算基础', () => {
  it('tickToX / xToTick 互逆', () => {
    const v = vp();
    for (const tick of [0, 100, 5000, 9999]) {
      const x = tickToX(v, tick);
      expect(xToTick(v, x)).toBe(tick);
    }
  });

  it('scrollTick 对应的 X 是 0', () => {
    const v = createViewport(0.1, 3000, 1000);
    expect(tickToX(v, 3000)).toBe(0);
  });

  it('contentOffsetPx 参与偏移', () => {
    const v = { ...vp(), contentOffsetPx: 50 };
    expect(tickToX(v, 0)).toBe(50);
    expect(xToTick(v, 50)).toBe(0);
  });

  it('xToTickFloat 不取整（用于预览）', () => {
    const v = createViewport(0.1, 0, 1000);
    expect(xToTickFloat(v, 505)).toBeCloseTo(5050, 9);
    expect(xToTickFloat(v, 505.5)).toBeCloseTo(5055, 9);
  });

  it('visibleEndTick', () => {
    const v = createViewport(0.1, 0, 1000);
    expect(visibleEndTick(v)).toBe(10000);
  });
});

describe('可视范围与裁剪', () => {
  it('bufferRatio=0 时正好是视口范围', () => {
    const v = createViewport(0.1, 1000, 1000);
    const r = visibleRange(v, 0);
    expect(r.startTick).toBe(1000);
    expect(r.endTick).toBe(11000);
  });

  it('默认带 0.5 个屏幕的缓冲', () => {
    const v = createViewport(0.1, 5000, 1000);
    const r = visibleRange(v);
    // 视口宽 1000px / 0.1 = 10000 tick；缓冲 5000 tick
    expect(r.startTick).toBe(0);
    expect(r.endTick).toBe(5000 + 10000 + 5000);
  });

  it('起始范围不会为负', () => {
    const v = createViewport(0.1, 100, 1000);
    expect(visibleRange(v).startTick).toBe(0);
  });

  it('isVisible 判定', () => {
    const v = createViewport(0.1, 1000, 1000); // 可视 [1000, 11000]
    expect(isVisible(v, 2000, 3000)).toBe(true);
    expect(isVisible(v, 0, 500)).toBe(false);
    expect(isVisible(v, 20000, 21000)).toBe(false);
    // 跨越左边界的片段仍可见
    expect(isVisible(v, 500, 1500)).toBe(true);
  });
});

describe('A09 基础：DOM 片段与 Canvas 网格使用同一函数', () => {
  it('tickRangeToPixels 与 tickToX 一致', () => {
    const v = createViewport(0.12, 2000, 1200);
    const span = tickRangeToPixels(v, 3000, 4000);
    expect(span.left).toBeCloseTo(tickToX(v, 3000), 9);
    expect(span.width).toBeCloseTo(tickToX(v, 4000) - tickToX(v, 3000), 9);
  });

  it('相邻片段首尾严格相接（无缝隙、无重叠）', () => {
    const v = createViewport(0.1, 0, 1000);
    const a = tickRangeToPixels(v, 1000, 2000);
    const b = tickRangeToPixels(v, 2000, 3000);
    // a 的右边缘 === b 的左边缘
    expect(a.left + a.width).toBeCloseTo(b.left, 9);
  });

  it('宽度不为负', () => {
    const v = createViewport(0.1, 0, 1000);
    const span = tickRangeToPixels(v, 2000, 1000);
    expect(span.width).toBe(0);
  });
});

describe('滚动', () => {
  it('scrollByPixels 正向与反向抵消', () => {
    const v = createViewport(0.1, 5000, 1000);
    const moved = scrollByPixels(v, 100);
    expect(moved.scrollTick).toBeCloseTo(6000, 9);
    const back = scrollByPixels(moved, -100);
    expect(back.scrollTick).toBeCloseTo(5000, 9);
  });

  it('scrollToTick', () => {
    const v = scrollToTick(vp(), 12345);
    expect(v.scrollTick).toBe(12345);
  });

  it('centerOnTick 把 tick 放到中间', () => {
    const v = centerOnTick(createViewport(0.1, 0, 1000), 20000);
    // 视口中心 X = 500 -> tick 应为 20000
    expect(xToTickFloat(v, 500)).toBeCloseTo(20000, 6);
  });

  it('clampScroll 不允许负数', () => {
    const v = { ...vp(), scrollTick: -500 };
    expect(clampScroll(v, 100000).scrollTick).toBe(0);
  });

  it('clampScroll 允许滚到内容末尾之后一个视口宽', () => {
    const v = createViewport(0.1, 0, 1000); // 视口 = 10000 tick
    const total = 10000;
    const clamped = clampScroll(v, total, 1);
    // maxScroll = total + viewportTicks*1 - viewportTicks = total
    expect(clamped.scrollTick).toBeLessThanOrEqual(total);

    // 但不能再往右
    const tooFar = { ...v, scrollTick: 999999 };
    expect(clampScroll(tooFar, total, 1).scrollTick).toBe(total);
  });

  it('clampScroll 在合法范围内不改对象（引用优化）', () => {
    const v = createViewport(0.1, 5000, 1000);
    expect(clampScroll(v, 100000)).toBe(v);
  });
});

describe('视口调整', () => {
  it('resizeViewport 保持 scrollTick', () => {
    const v = createViewport(0.1, 5000, 1000);
    const next = resizeViewport(v, 2000);
    expect(next.width).toBe(2000);
    expect(next.scrollTick).toBe(5000);
  });

  it('resizeViewport 拒绝非法宽度', () => {
    expect(() => resizeViewport(vp(), 0)).toThrow(RangeError);
    expect(() => resizeViewport(vp(), -100)).toThrow(RangeError);
  });

  it('contentWidthPx', () => {
    expect(contentWidthPx(createViewport(0.1, 0, 1000), 10000)).toBeCloseTo(1000, 9);
  });

  it('fitToContent 让整首曲子可见', () => {
    const v = createViewport(0.1, 0, 1000);
    const total = 50000;
    const fitted = fitToContent(v, total);
    // 内容宽度应略小于视口宽度（留 padding）
    const w = contentWidthPx(fitted, total);
    expect(w).toBeLessThanOrEqual(1000);
    expect(w).toBeGreaterThan(900);
    expect(fitted.scrollTick).toBe(0);
  });
});

describe('构造校验', () => {
  it('拒绝非法参数', () => {
    expect(() => createViewport(0, 0, 1000)).toThrow(RangeError);
    expect(() => createViewport(-1, 0, 1000)).toThrow(RangeError);
    expect(() => createViewport(NaN, 0, 1000)).toThrow(RangeError);
    expect(() => createViewport(0.1, NaN, 1000)).toThrow(RangeError);
    expect(() => createViewport(0.1, 0, 0)).toThrow(RangeError);
  });

  it('zoomAtX 拒绝非法倍数', () => {
    const v = vp();
    expect(() => zoomAtX(v, 100, 0)).toThrow(RangeError);
    expect(() => zoomAtX(v, 100, -1)).toThrow(RangeError);
    expect(() => zoomAtX(v, 100, NaN)).toThrow(RangeError);
  });
});

describe('Property: 坐标往返与单调性', () => {
  const arbVp = fc
    .record({
      ppt: fc.float({ min: Math.fround(0.001), max: Math.fround(1), noNaN: true }),
      scroll: fc.integer({ min: 0, max: 100000 }),
      width: fc.integer({ min: 100, max: 3000 }),
    })
    .map(({ ppt, scroll, width }) => createViewport(ppt, scroll, width));

  it('tick → x → tick 往返误差 ≤ 1', () => {
    fc.assert(
      fc.property(arbVp, fc.integer({ min: 0, max: 200000 }), (v, tick) => {
        const x = tickToX(v, tick);
        return Math.abs(xToTick(v, x) - tick) <= 1;
      }),
      { numRuns: 300 },
    );
  });

  it('tickToX 严格单调递增', () => {
    fc.assert(
      fc.property(
        arbVp,
        fc.integer({ min: 0, max: 200000 }),
        fc.integer({ min: 1, max: 10000 }),
        (v, tick, delta) => tickToX(v, tick + delta) > tickToX(v, tick),
      ),
      { numRuns: 300 },
    );
  });
});
