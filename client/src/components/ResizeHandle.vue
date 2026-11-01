<script setup lang="ts">
/**
 * ResizeHandle —— 可拖拽的分隔条。
 *
 * 用途：让用户调整左右侧栏宽度，从而改变中间时间轴的可用宽度
 * （用户反馈「太挤了」的直接对策）。
 *
 * 交互细节：
 *   - 拖动时实时更新，松手才提交（避免每帧写 localStorage）
 *   - 双击恢复默认宽度
 *   - 键盘可达：聚焦后用 ←/→ 调整 8px
 *   - 有 1px 的视觉反馈线，hover 时高亮
 */
import { computed, ref } from 'vue';

const props = defineProps<{
  /** 当前宽度 */
  modelValue: number;
  /** 最小宽度 */
  min?: number;
  /** 最大宽度 */
  max?: number;
  /** 双击恢复的默认宽度 */
  defaultValue?: number;
  /** 手柄在容器的哪一侧：left 表示被调宽的元素在其左侧 */
  side: 'left' | 'right';
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: number): void;
}>();

const dragging = ref(false);
const hovering = ref(false);
let startX = 0;
let startW = 0;

const minW = computed(() => props.min ?? 200);
const maxW = computed(() => props.max ?? 480);

function clampW(v: number) {
  return Math.max(minW.value, Math.min(maxW.value, Math.round(v)));
}

function onPointerDown(e: PointerEvent) {
  dragging.value = true;
  startX = e.clientX;
  startW = props.modelValue;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();

  // 拖动期间禁用文本选中与 iframe 捕获
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return;
  // side='right' 表示手柄在左侧元素的右边：往右拖 → 左侧变宽（+）
  // side='left'  表示手柄在右侧元素的左边：往右拖 → 右侧变窄（-）
  const delta = e.clientX - startX;
  const signed = props.side === 'right' ? delta : -delta;
  emit('update:modelValue', clampW(startW + signed));
}

function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  try {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

function onDoubleClick() {
  if (props.defaultValue != null) emit('update:modelValue', clampW(props.defaultValue));
}

function onKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 32 : 8;
  if (e.key === 'ArrowLeft') {
    emit('update:modelValue', clampW(props.modelValue - step));
    e.preventDefault();
  } else if (e.key === 'ArrowRight') {
    emit('update:modelValue', clampW(props.modelValue + step));
    e.preventDefault();
  }
}
</script>

<template>
  <div
    class="resize-handle"
    :class="{ dragging, hovering }"
    role="separator"
    :aria-orientation="'vertical'"
    :aria-valuenow="modelValue"
    :aria-valuemin="minW"
    :aria-valuemax="maxW"
    tabindex="0"
    :title="`拖拽调整宽度（当前 ${modelValue}px，双击恢复）`"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @dblclick="onDoubleClick"
    @keydown="onKey"
    @pointerenter="hovering = true"
    @pointerleave="hovering = false"
  >
    <span class="bar" />
  </div>
</template>

<style scoped>
.resize-handle {
  flex: 0 0 5px;
  width: 5px;
  cursor: col-resize;
  background: transparent;
  position: relative;
  z-index: 20;
  outline: none;
  /* 扩大命中区域但不占布局 */
  padding: 0;
}
.resize-handle::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  right: -3px;
}
.bar {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 1px;
  background: var(--border);
  transition: background 0.12s, width 0.12s;
}
.resize-handle:hover .bar,
.resize-handle.hovering .bar,
.resize-handle:focus-visible .bar {
  left: 1px;
  width: 3px;
  background: var(--accent);
}
.resize-handle.dragging .bar {
  left: 1px;
  width: 3px;
  background: var(--accent);
}
</style>
