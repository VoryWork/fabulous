<!--
  调性选择器。

  ## 和和弦选择器同样的原则：只能选，不能填

  手填调性会出现 `A major` / `Amajor` / `A大调` / `a 小调` 各种写法，
  下游的级数计算（`chordToNumber`）只认 12 个音名 + major/minor，
  写歪了就是级数轨整条变 `—`，而用户看不出为什么。

  所以这里给 12 个音级 × 2 个调式，点选即生效。

  ## 为什么不用 `<select>`

  12 × 2 = 24 个选项，`<select>` 要滚半天才找到。音级格子铺开一眼看全，
  而且和和弦选择器的视觉语言一致（用户已经熟悉那种点选方式）。
-->
<template>
  <div class="key-picker">
    <div class="kp-row-label">主音</div>
    <div class="kp-tonics">
      <button
        v-for="t in KEY_TONICS"
        :key="t"
        :class="['kp-tonic', { on: t === modelValue.tonic }]"
        @click="pickTonic(t)"
      >
        {{ t }}
      </button>
    </div>

    <div class="kp-row-label">调式</div>
    <div class="kp-modes">
      <button
        v-for="m in MODES"
        :key="m.value"
        :class="['kp-mode', { on: m.value === modelValue.mode }]"
        :title="m.hint"
        @click="pickMode(m.value)"
      >
        {{ m.label }}
      </button>
    </div>

    <div v-if="autoKey" class="kp-hint">
      自动推断：{{ autoKey.tonic }} {{ autoKey.mode }}
      <button v-if="isOverridden" class="kp-reset" @click="emit('reset')">
        恢复自动
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { KEY_TONICS } from '../timeline/domain/ChordNotation';

export type KeyMode = 'major' | 'minor';

const props = defineProps<{
  modelValue: { tonic: string; mode: KeyMode };
  /** 自动推断出来的调性（用来显示"恢复自动"和对照） */
  autoKey?: { tonic: string; mode: string } | null;
  /** 当前是否是用户手动指定的 */
  isOverridden?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: { tonic: string; mode: KeyMode }): void;
  (e: 'reset'): void;
}>();

const MODES = [
  { value: 'major' as const, label: '大调', hint: 'I–ii–iii–IV–V–vi–vii°' },
  { value: 'minor' as const, label: '小调', hint: 'i–ii°–III–iv–v–VI–VII' },
];

function pickTonic(t: string) {
  emit('update:modelValue', { tonic: t, mode: props.modelValue.mode });
}

function pickMode(mode: KeyMode) {
  emit('update:modelValue', { tonic: props.modelValue.tonic || 'C', mode });
}

/** 自动推断的调性是否为空（空谱面时为空，不显示对照行） */
const autoKey = computed(() => {
  const a = props.autoKey;
  if (!a || !a.tonic) return null;
  return a;
});
</script>

<style scoped>
.key-picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kp-row-label {
  font-size: 10.5px;
  color: var(--text-dim, #8a8f98);
}

.kp-tonics {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 3px;
}

.kp-tonic {
  padding: 5px 0;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  border: 1px solid var(--border, #e3e6ea);
  border-radius: 3px;
  background: var(--bg-panel, #fff);
  color: var(--text, #1f2328);
  cursor: pointer;
}
.kp-tonic:hover {
  border-color: var(--accent, #e8722d);
}
.kp-tonic.on {
  background: var(--accent, #e8722d);
  border-color: var(--accent, #e8722d);
  color: #fff;
}

.kp-modes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
}
.kp-mode {
  padding: 5px 0;
  font-size: 11.5px;
  border: 1px solid var(--border, #e3e6ea);
  border-radius: 3px;
  background: var(--bg-panel, #fff);
  color: var(--text, #1f2328);
  cursor: pointer;
}
.kp-mode:hover {
  border-color: var(--accent, #e8722d);
}
.kp-mode.on {
  background: var(--accent, #e8722d);
  border-color: var(--accent, #e8722d);
  color: #fff;
}

.kp-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-dim, #8a8f98);
}
.kp-reset {
  margin-left: auto;
  padding: 0;
  font-size: 10.5px;
  border: 0;
  background: transparent;
  color: var(--accent, #e8722d);
  cursor: pointer;
  text-decoration: underline;
}
</style>
