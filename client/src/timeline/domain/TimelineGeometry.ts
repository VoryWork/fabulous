/**
 * TimelineGeometry —— Tick ⇄ 屏幕 X 坐标。
 *
 * 规格（PRD §4.6 / A06）：
 *   - Zoom 的锚点是**鼠标下方的 Tick**：缩放后该 Tick 的屏幕 X 保持不变
 *   - 左侧轨名列与顶部标尺固定，只滚动内容区
 *   - 支持横向滚动
 *
 * 设计要点：
 *   1. 这是一个**纯函数模块**：给定 Viewport 快照和 tick，算出 x。
 *   2. Viewport 是一个不可变快照，用 `applyXxx` 系列函数生成新快照。
 *      这样做的好处是：Canvas 与 DOM 消费同一个快照，自然对齐（A09）。
 *   3. 不用 DPR 参与坐标计算，DPR 只在 Canvas 绘制时缩放。
 */

import { assertTick } from './Tick';

/**
 * 视口快照。
 *
 * 单位说明：
 *   - `pixelsPerTick`：缩放系数，越大越放大
 *   - `scrollTick`：视口左边缘对应的 tick（**可以是负数吗？** 不行，
 *     但为了支持"音频开始前的空白"我们允许 0；
 *     若要支持前置空白，用 `contentOffsetPx`）
 */
export interface Viewport {
  /** 每 tick 多少像素 */
  readonly pixelsPerTick: number;
  /** 视口左边缘对应的 tick */
  readonly scrollTick: number;
  /** 内容区可视宽度（CSS 像素） */
  readonly width: number;
  /** 可选：内容左边缘的额外像素偏移（用于预留空白） */
  readonly contentOffsetPx?: number;
}

/** 缩放范围（由可读性决定，PRD §4.6） */
export const MIN_PIXELS_PER_TICK = 0.0005; // 极缩小：一屏能看几十分钟
export const MAX_PIXELS_PER_TICK = 2.0; // 极放大：一个 tick 占 2px

/** 创建视口，做基本校验 */
export function createViewport(
  pixelsPerTick: number,
  scrollTick: number,
  width: number,
): Viewport {
  if (!(pixelsPerTick > 0) || !Number.isFinite(pixelsPerTick)) {
    throw new RangeError(`pixelsPerTick 必须为正有限数，收到 ${pixelsPerTick}`);
  }
  if (!Number.isFinite(scrollTick)) {
    throw new RangeError(`scrollTick 必须有限，收到 ${scrollTick}`);
  }
  if (!(width > 0) || !Number.isFinite(width)) {
    throw new RangeError(`width 必须为正有限数，收到 ${width}`);
  }
  return { pixelsPerTick, scrollTick, width };
}

/** tick → 屏幕 X（相对内容区左边缘） */
export function tickToX(vp: Viewport, tick: number): number {
  return (tick - vp.scrollTick) * vp.pixelsPerTick + (vp.contentOffsetPx ?? 0);
}

/**
 * 屏幕 X → tick（浮点，调用方按需取整）。
 *
 * 注意这里**不四舍五入**：格式化信息（比如拖动预览、光标位置）
 * 需要浮点精度才能算出正确的像素位置。
 */
export function xToTickFloat(vp: Viewport, x: number): number {
  return (x - (vp.contentOffsetPx ?? 0)) / vp.pixelsPerTick + vp.scrollTick;
}

/** 屏幕 X → 最近的整数 tick */
export function xToTick(vp: Viewport, x: number): number {
  return Math.round(xToTickFloat(vp, x));
}

/** 视口右边缘对应的 tick */
export function visibleEndTick(vp: Viewport): number {
  return Math.ceil(vp.scrollTick + vp.width / vp.pixelsPerTick);
}

/** 视口覆盖的 tick 范围 */
export interface VisibleRange {
  readonly startTick: number;
  readonly endTick: number;
}

/**
 * 计算可视范围，并向外扩展一个缓冲带。
 *
 * 缓冲带的作用（PRD §4.3 "可视范围裁剪"）：
 * 只渲染视口内的 Clip，但滚动时如果正好在边界生成 DOM 会看到闪烁，
 * 所以多渲染半个屏幕。
 */
export function visibleRange(vp: Viewport, bufferRatio = 0.5): VisibleRange {
  const bufferTicks = (vp.width / vp.pixelsPerTick) * bufferRatio;
  return {
    startTick: Math.max(0, Math.floor(vp.scrollTick - bufferTicks)),
    endTick: Math.ceil(vp.scrollTick + vp.width / vp.pixelsPerTick + bufferTicks),
  };
}

/**
 * 以某个屏幕 X 为锚点缩放。
 *
 * **这是 PRD A06 的核心**：缩放后，锚点处的 Tick 屏幕 X 保持 `<= 1px` 偏差。
 *
 * 实现思路：
 *   1. 先算出锚点处的 tick（缩放前）
 *   2. 应用新的 pixelsPerTick
 *   3. 反解出新的 scrollTick，使该 tick 仍落在同一个 x 上
 */
export function zoomAtX(vp: Viewport, anchorX: number, factor: number): Viewport {
  if (!(factor > 0) || !Number.isFinite(factor)) {
    throw new RangeError(`factor 必须为正有限数，收到 ${factor}`);
  }
  const tickAtAnchor = xToTickFloat(vp, anchorX);
  const nextPPT = clampZoom(vp.pixelsPerTick * factor);
  const offset = vp.contentOffsetPx ?? 0;
  // 目标： (tickAtAnchor - nextScroll) * nextPPT + offset === anchorX
  const nextScroll = tickAtAnchor - (anchorX - offset) / nextPPT;
  return {
    ...vp,
    pixelsPerTick: nextPPT,
    scrollTick: nextScroll,
  };
}

/** 以视口中心为锚点缩放（键盘 +/- 快捷键用） */
export function zoomAtCenter(vp: Viewport, factor: number): Viewport {
  return zoomAtX(vp, vp.width / 2, factor);
}

/** 把缩放值限制在可读范围内 */
export function clampZoom(ppt: number): number {
  return Math.min(MAX_PIXELS_PER_TICK, Math.max(MIN_PIXELS_PER_TICK, ppt));
}

/** 设置绝对缩放值，以某个 X 为锚点 */
export function setZoomAtX(vp: Viewport, anchorX: number, pixelsPerTick: number): Viewport {
  const factor = pixelsPerTick / vp.pixelsPerTick;
  return zoomAtX(vp, anchorX, factor);
}

/** 横向滚动指定像素 */
export function scrollByPixels(vp: Viewport, dxPixels: number): Viewport {
  return {
    ...vp,
    scrollTick: vp.scrollTick + dxPixels / vp.pixelsPerTick,
  };
}

/** 滚动到指定 tick（放到视口左边缘） */
export function scrollToTick(vp: Viewport, tick: number): Viewport {
  return { ...vp, scrollTick: tick };
}

/**
 * 让某个 tick 居中
 */
export function centerOnTick(vp: Viewport, tick: number): Viewport {
  const halfWidthTicks = vp.width / 2 / vp.pixelsPerTick;
  return { ...vp, scrollTick: tick - halfWidthTicks };
}

/** 改变视口宽度（窗口 resize），保持左边缘不变 */
export function resizeViewport(vp: Viewport, width: number): Viewport {
  if (!(width > 0)) {
    throw new RangeError(`width 必须为正，收到 ${width}`);
  }
  return { ...vp, width };
}

/** 整段内容的总像素宽度 */
export function contentWidthPx(vp: Viewport, totalTicks: number): number {
  return totalTicks * vp.pixelsPerTick;
}

/**
 * 把 scrollTick 限制在合法范围，避免滚出内容区。
 *
 * `totalTicks` 是内容总长度。允许滚到内容末尾之后一个视口宽，
 * 这样用户可以在歌曲结尾后继续编辑（PRD §4.6 提到的空白区）。
 */
export function clampScroll(vp: Viewport, totalTicks: number, allowTrailing = 1): Viewport {
  const viewportTicks = vp.width / vp.pixelsPerTick;
  const maxScroll = Math.max(0, totalTicks + viewportTicks * allowTrailing - viewportTicks);
  const next = Math.min(Math.max(0, vp.scrollTick), maxScroll);
  return next === vp.scrollTick ? vp : { ...vp, scrollTick: next };
}

/**
 * 计算适合"显示整首曲子"的缩放。
 */
export function fitToContent(vp: Viewport, totalTicks: number, paddingRatio = 0.02): Viewport {
  const usable = vp.width * (1 - paddingRatio * 2);
  const ppt = clampZoom(usable / Math.max(1, totalTicks));
  return { ...vp, pixelsPerTick: ppt, scrollTick: 0 };
}

/**
 * 计算某个区间在屏幕上的像素矩形（用于 DOM 片段的 left/width）。
 *
 * 这是 DOM 片段与 Canvas 网格对齐的关键：两者都调用同一函数，
 * 保证 PRD A09 的"偏差 ≤ 1px"。
 */
export interface PixelSpan {
  readonly left: number;
  readonly width: number;
}

export function tickRangeToPixels(vp: Viewport, startTick: number, endTick: number): PixelSpan {
  assertTick(startTick, 'startTick');
  assertTick(endTick, 'endTick');
  const left = tickToX(vp, startTick);
  const right = tickToX(vp, endTick);
  return { left, width: Math.max(0, right - left) };
}

/**
 * 判断某个 tick 区间是否与视口有交集（用于裁剪渲染）。
 */
export function isVisible(vp: Viewport, startTick: number, endTick: number): boolean {
  const range = visibleRange(vp, 0);
  return endTick > range.startTick && startTick < range.endTick;
}

// ------------------------------------------------------------------ 整数像素对齐
/**
 * 像素取整 —— 渲染层专用。
 *
 * **为什么需要单独一层：**
 *
 * `tickToX()` 返回浮点数（例如 155.19px）。这个精度对缩放锚点计算是必需的
 * —— 若每步都取整，连续缩放 20 次再缩回的误差会累积到几像素。
 *
 * 但渲染时浮点数会带来一个隐蔽问题：
 *   - DOM 片段的 left 是 155.19
 *   - Canvas 网格线画在 155.5（+0.5 做抗锯齿）
 *   - 两者差 0.31px，肉眼在密集刻度下能看出"块和线没对齐"
 *   - 而且块多了以后误差会累积（0.31 × 10 个块 = 3px）
 *
 * 解决办法：**只在渲染边界处取整**，且 Canvas 与 DOM 走同一个函数。
 * 这样对齐不是"调"出来的，而是数学上必然的（差 0px）。
 *
 * 关键细节：片段的 right 必须**独立取整**，
 * 不能写 `left + round(width)` —— 否则相邻块之间会出现 1px 的缝或重叠。
 */

/** 把一个浮点像素坐标对齐到整数像素（DOM 用） */
export function snapPx(x: number): number {
  return Math.round(x);
}

/** Canvas 画线用：对齐到像素中心（整数 + 0.5），保证 1px 线不发虚 */
export function snapPxLine(x: number): number {
  return Math.round(x) + 0.5;
}

/**
 * tick 区间 → 整数像素矩形。
 *
 * 返回的 `left + width === right` 恒成立，因此相邻片段的边界完全重合。
 */
export interface IntRect {
  readonly left: number;
  readonly right: number;
  readonly width: number;
}

export function tickRangeToIntRect(
  vp: Viewport,
  startTick: number,
  endTick: number,
): IntRect {
  assertTick(startTick, 'startTick');
  assertTick(endTick, 'endTick');
  const left = snapPx(tickToX(vp, startTick));
  // 独立取整右边界，不用 left + width，避免累积缝隙
  const right = snapPx(tickToX(vp, endTick));
  return { left, right, width: Math.max(0, right - left) };
}

/**
 * 验证对齐不变量（供测试用）。
 *
 * 相邻区间 [a,b) 与 [b,c) 的像素矩形必须满足：
 *   rect1.right === rect2.left
 */
export function areRectsContiguous(a: IntRect, b: IntRect): boolean {
  return a.right === b.left;
}
