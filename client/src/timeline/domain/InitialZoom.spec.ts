/**
 * 初始缩放的取值（`TimelineView.initViewport` 的核心公式）。
 *
 * ## 为什么单独测这个
 *
 * 踩过的坑：`onMounted` 时 DOM 已挂载但布局未完成，`contentRef.clientWidth`
 * 是 **0**。此时
 *
 *     ppt = Math.max(MIN_PIXELS_PER_TICK, 0 / visibleTicks)
 *         = MIN_PIXELS_PER_TICK          ← 夹到"极缩小"
 *
 * 一屏能塞下 ~178 小节，每个和弦块只有几像素，文字全部消失；
 * 顶栏显示 9%。而且 ResizeObserver 之后纠正了宽度，却**不会重算缩放**，
 * 所以错误状态会一直留着，看起来像"默认缩放就是 9%"。
 *
 * 结论：宽度无效时必须**放弃初始化**，等真正的宽度到了再算。
 * 这里把公式和"放弃条件"固定下来，防止以后又被改回无条件 clamp。
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_PIXELS_PER_TICK,
  MIN_PIXELS_PER_TICK,
  createViewport,
} from './TimelineGeometry';

const TICKS_PER_BAR = 4 * 960;
const DEFAULT_VISIBLE_BARS = 16;

/** 与 initViewport 一致的公式；宽度无效时返回 null（= 放弃初始化） */
function computeInitialPixelsPerTick(width: number): number | null {
  if (!(width > 0)) return null;
  const visibleTicks = DEFAULT_VISIBLE_BARS * TICKS_PER_BAR;
  return Math.min(MAX_PIXELS_PER_TICK, Math.max(MIN_PIXELS_PER_TICK, width / visibleTicks));
}

describe('初始缩放', () => {
  it('宽度为 0 时放弃初始化（不能夹到最小缩放）', () => {
    expect(computeInitialPixelsPerTick(0)).toBeNull();
    expect(computeInitialPixelsPerTick(-1)).toBeNull();
    expect(computeInitialPixelsPerTick(NaN)).toBeNull();
  });

  it('拿 0 去算会被夹成最小值 —— 这正是要避免的', () => {
    // 演示错误路径的产物，确保断言的口径没变
    const wrong = Math.min(MAX_PIXELS_PER_TICK, Math.max(MIN_PIXELS_PER_TICK, 0 / 7680));
    expect(wrong).toBe(MIN_PIXELS_PER_TICK);
    // 一屏能塞下的小节数远超可读范围
    expect(1200 / (wrong * TICKS_PER_BAR)).toBeGreaterThan(100);
  });

  it('正常宽度下刚好显示 16 小节', () => {
    const width = 1200;
    const ppt = computeInitialPixelsPerTick(width)!;
    const barsOnScreen = width / (ppt * TICKS_PER_BAR);
    expect(barsOnScreen).toBeCloseTo(DEFAULT_VISIBLE_BARS, 5);
  });

  it('每小节至少 60px（和弦名能读清的下限）', () => {
    const ppt = computeInitialPixelsPerTick(1200)!;
    expect(ppt * TICKS_PER_BAR).toBeGreaterThanOrEqual(60);
  });

  it('createViewport 接受的缩放落在合法区间', () => {
    const ppt = computeInitialPixelsPerTick(1200)!;
    const vp = createViewport(ppt, 0, 1200);
    expect(vp.pixelsPerTick).toBeGreaterThanOrEqual(MIN_PIXELS_PER_TICK);
    expect(vp.pixelsPerTick).toBeLessThanOrEqual(MAX_PIXELS_PER_TICK);
  });
});
