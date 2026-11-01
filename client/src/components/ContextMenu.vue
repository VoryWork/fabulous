<script setup lang="ts">
/**
 * ContextMenu —— 片段右键菜单。
 *
 * 按 PRD 与 ADR-0002 组织：
 *   - 文本编辑 / 校对状态
 *   - 档位重新分析（局部重绘，ADR-0002）
 *   - 拆分 / 合并
 *   - 级数解释 / 删除
 *
 * 键盘可达：↑↓ 移动，Enter 执行，Esc 关闭。
 */
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  /** 分隔线 */
  divider?: boolean;
  disabled?: boolean;
  /** 危险操作（红色） */
  danger?: boolean;
  /** 子菜单 */
  children?: MenuItem[];
  /** 是否显示勾选标记 */
  checked?: boolean;
}

const props = defineProps<{
  x: number;
  y: number;
  items: MenuItem[];
  /** 菜单标题（显示当前片段名） */
  title?: string;
}>();

const emit = defineEmits<{
  (e: 'select', id: string): void;
  (e: 'close'): void;
}>();

const menuRef = ref<HTMLDivElement | null>(null);
const activeIndex = ref(-1);
const openSubId = ref<string | null>(null);

/** 扁平化的可选项（跳过分隔线），用于键盘导航 */
const flatSelectable = computed(() => props.items.filter((i) => !i.divider && !i.disabled));

function onSelect(item: MenuItem) {
  if (item.divider || item.disabled) return;
  if (item.children) {
    openSubId.value = openSubId.value === item.id ? null : item.id;
    return;
  }
  emit('select', item.id);
}

function onKey(e: KeyboardEvent) {
  const list = flatSelectable.value;
  if (e.key === 'Escape') {
    emit('close');
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown') {
    activeIndex.value = (activeIndex.value + 1) % list.length;
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    activeIndex.value = (activeIndex.value - 1 + list.length) % list.length;
    e.preventDefault();
  } else if (e.key === 'Enter') {
    const item = list[activeIndex.value];
    if (item) onSelect(item);
    e.preventDefault();
  }
}

/** 点击外部关闭 */
function onDocDown(e: PointerEvent) {
  if (!menuRef.value?.contains(e.target as Node)) emit('close');
}
onMounted(() => {
  window.addEventListener('pointerdown', onDocDown, true);
  window.addEventListener('keydown', onKey, true);
  nextTick(() => {
    // 防止菜单超出视口
    const el = menuRef.value;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth) {
      el.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
    }
    if (r.bottom > window.innerHeight) {
      el.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
    }
  });
});
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocDown, true);
  window.removeEventListener('keydown', onKey, true);
});

watch(
  () => [props.x, props.y],
  () => {
    activeIndex.value = -1;
    openSubId.value = null;
  },
);
</script>

<template>
  <div
    ref="menuRef"
    class="ctx-menu"
    :style="{ left: x + 'px', top: y + 'px' }"
    @contextmenu.prevent
  >
    <div v-if="title" class="ctx-title">{{ title }}</div>

    <template v-for="item in items" :key="item.id">
      <div v-if="item.divider" class="ctx-divider" />
      <div
        v-else
        class="ctx-item"
        :class="{
          disabled: item.disabled,
          danger: item.danger,
          active: flatSelectable[activeIndex]?.id === item.id,
          'has-sub': !!item.children,
        }"
        @pointerdown.stop="onSelect(item)"
        @pointerenter="activeIndex = flatSelectable.findIndex((f) => f.id === item.id)"
      >
        <span class="ctx-check">{{ item.checked ? '✓' : '' }}</span>
        <span class="ctx-label">{{ item.label }}</span>
        <span v-if="item.shortcut" class="ctx-shortcut">{{ item.shortcut }}</span>
        <span v-if="item.children" class="ctx-arrow">›</span>
      </div>

      <!-- 子菜单 -->
      <div v-if="item.children && openSubId === item.id" class="ctx-sub">
        <div
          v-for="sub in item.children"
          :key="sub.id"
          class="ctx-item"
          :class="{ disabled: sub.disabled, active: sub.checked }"
          @pointerdown.stop="onSelect(sub)"
        >
          <span class="ctx-check">{{ sub.checked ? '✓' : '' }}</span>
          <span class="ctx-label">{{ sub.label }}</span>
          <span v-if="sub.shortcut" class="ctx-shortcut">{{ sub.shortcut }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  min-width: 220px;
  background: #fff;
  border: 1px solid var(--border-strong);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
  padding: 4px 0;
  z-index: 1000;
  font-size: 12px;
  user-select: none;
}

.ctx-title {
  padding: 4px 10px 6px;
  color: var(--text-muted);
  font-size: 10.5px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctx-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px 5px 4px;
  cursor: pointer;
  color: var(--text-primary);
  position: relative;
  white-space: nowrap;
}
.ctx-item.active {
  background: var(--accent-soft);
}
.ctx-item.disabled {
  color: var(--text-muted);
  cursor: default;
  opacity: 0.55;
}
.ctx-item.danger {
  color: var(--danger);
}

.ctx-check {
  width: 14px;
  text-align: center;
  color: var(--accent);
  font-size: 11px;
  flex: 0 0 auto;
}
.ctx-label {
  flex: 1;
}
.ctx-shortcut {
  color: var(--text-muted);
  font-size: 10.5px;
  margin-left: 16px;
  font-variant-numeric: tabular-nums;
}
.ctx-arrow {
  color: var(--text-muted);
  margin-left: 6px;
}

.ctx-sub {
  position: absolute;
  left: 100%;
  top: 0;
  min-width: 170px;
  background: #fff;
  border: 1px solid var(--border-strong);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
  padding: 4px 0;
}
</style>
