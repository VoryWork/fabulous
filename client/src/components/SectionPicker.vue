<script setup lang="ts">
/**
 * 结构段名选择器。
 *
 * ## 为什么不让用户直接输入
 *
 * 结构段名是**分析用语**，不是自由文本。同一首歌里出现
 * `Chorus` / `chorus` / `副歌` / `高潮` 四种写法，等于没有结构信息 ——
 * 想按结构做统计（"副歌平均多长"）就完全没法算。
 *
 * 和和弦名只能从 `ChordPicker` 选是同一个道理：**能选就不要填**。
 *
 * ## 分组而不是一个长列表
 *
 * 30+ 个词平铺，用户找 `Bridge` 得从头扫。按功能分组后，
 * 找词思路变成「我要找的是个过渡段」→ 直接看「过渡 / 变体」那组。
 */
import { SECTION_GROUPS } from '../timeline/domain/SectionLabels';

const props = defineProps<{
  /** 当前名字（高亮用） */
  modelValue?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
}>();
</script>

<template>
  <div class="sec-picker">
    <div v-for="g in SECTION_GROUPS" :key="g.id" class="sec-group">
      <div class="sec-group-title">{{ g.title }}</div>
      <div class="sec-grid">
        <button
          v-for="it in g.items"
          :key="it.id"
          class="sec-item"
          :class="{ active: props.modelValue === it.label }"
          :title="it.hint"
          @click="emit('update:modelValue', it.label)"
        >
          {{ it.label }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sec-picker {
  max-height: 360px;
  overflow-y: auto;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sec-group-title {
  font-size: 11px;
  color: var(--text-muted, #9a9a9d);
  margin-bottom: 4px;
}
.sec-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
.sec-item {
  font: inherit;
  font-size: 12px;
  padding: 5px 6px;
  text-align: left;
  border-radius: 5px;
  border: 1px solid var(--border, #33333a);
  background: transparent;
  color: var(--text, #e6e6e9);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sec-item:hover {
  border-color: var(--accent, #e0a052);
}
.sec-item.active {
  background: rgba(224, 160, 82, 0.18);
  border-color: var(--accent, #e0a052);
  color: var(--accent, #e0a052);
  font-weight: 600;
}
</style>
