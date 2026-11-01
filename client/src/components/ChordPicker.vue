<script setup lang="ts">
/**
 * 和弦选择器 —— **只能选，不能填**。
 *
 * ## 为什么不做自由输入
 *
 * 手填和弦名会静默污染整条链路：
 *   - `chordToNumber` 解析失败 → 级数轨对应的块直接消失（不报错）
 *   - `inferKey` 拿脏和弦打分 → 调性推断偏掉
 *   - 导出 / 重新分析的下游全要处理非法值
 *
 * ## 选项从哪来
 *
 * 直接对齐 lv-chordia 的 `submission_chord_list.txt`（模型实际能输出的集合），
 * 也就是「12 个根音 × 25 种形式 + N」。这样用户选出来的东西**一定**在模型
 * 的词表里，不会出现"人能选但模型永远给不出"的怪值。
 *
 * 三步：
 *   1. 根音（12 个，按常见调性排序，降号写法优先——流行乐谱更常用）
 *   2. 性质（maj/min/7/maj7/... 分组显示）
 *   3. 转位（可选：原位 / 3 / 5 / b7 / 2 ...）
 *
 * 选完即时应用，不需要再点确定。
 */
import { computed, ref } from 'vue';

interface Props {
  /** 当前和弦（用来高亮） */
  current?: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'pick', chord: string): void;
}>();

/**
 * 根音顺序：C 开头，然后按五度圈 / 常用度排列。
 * 降号写法（Db/Eb/Gb/Ab/Bb）优先——流行乐谱习惯，也和模型输出一致。
 */
const ROOTS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * 性质列表（来自 submission 档的实测提取）。
 *
 * `bassOnly` 的几项是「只有转位、没有额外性质」——它们本来附在 maj/min 上，
 * 这里单独列出，让用户能直接选 `C:maj/3` 这种。
 */
const QUALITIES: Array<{ id: string; label: string; group: string }> = [
  { id: 'maj', label: '大三', group: '基本' },
  { id: 'min', label: '小三', group: '基本' },
  { id: 'dim', label: '减', group: '基本' },
  { id: 'aug', label: '增', group: '基本' },
  { id: 'sus2', label: 'sus2', group: '基本' },
  { id: 'sus4', label: 'sus4', group: '基本' },
  { id: '7', label: '属七', group: '七和弦' },
  { id: 'maj7', label: '大七', group: '七和弦' },
  { id: 'min7', label: '小七', group: '七和弦' },
  { id: 'dim7', label: '减七', group: '七和弦' },
  { id: 'hdim7', label: '半减七', group: '七和弦' },
  { id: '9', label: '九', group: '扩展' },
  { id: 'maj9', label: '大九', group: '扩展' },
  { id: 'min9', label: '小九', group: '扩展' },
  { id: '11', label: '十一', group: '扩展' },
  { id: '13', label: '十三', group: '扩展' },
  { id: 'sus4(b7)', label: 'sus4(b7)', group: '扩展' },
];

/** 转位：原位 + 词表里出现的低音 */
const INVERSIONS: Array<{ id: string; label: string }> = [
  { id: '', label: '原位' },
  { id: '3', label: '/3 第一转位' },
  { id: '5', label: '/5 第二转位' },
  { id: 'b7', label: '/b7 七音低音' },
  { id: '2', label: '/2' },
  { id: 'b3', label: '/b3' },
];

const root = ref<string>(ROOTS[0]);
const quality = ref<string>('maj');
const inversion = ref<string>('');

/** 解析当前和弦，初始化选择器状态 */
function syncFrom(chord: string | undefined) {
  if (!chord || chord === 'N') return;
  const m = chord.match(/^([A-G][#b]?)(?::([^/]+))?(?:\/(.+))?$/);
  if (!m) return;
  if (ROOTS.includes(m[1])) root.value = m[1];
  if (m[2] && QUALITIES.some((q) => q.id === m[2])) quality.value = m[2];
  inversion.value = m[3] ?? '';
}

syncFrom(props.current);

/** 当前选择拼出来的和弦 */
const preview = computed(
  () => `${root.value}:${quality.value}${inversion.value ? '/' + inversion.value : ''}`,
);

function apply() {
  emit('pick', preview.value);
}

const grouped = computed(() => {
  const map = new Map<string, typeof QUALITIES>();
  for (const q of QUALITIES) {
    const arr = map.get(q.group) ?? [];
    arr.push(q);
    map.set(q.group, arr);
  }
  return [...map.entries()];
});
</script>

<template>
  <div class="picker">
    <!-- 1. 根音 -->
    <div class="pk-label">根音</div>
    <div class="pk-grid roots">
      <button
        v-for="r in ROOTS"
        :key="r"
        :class="['pk-btn', { on: root === r }]"
        @click="root = r; apply()"
      >
        {{ r }}
      </button>
    </div>

    <!-- 2. 性质 -->
    <div class="pk-label">性质</div>
    <div v-for="[group, items] in grouped" :key="group" class="pk-group">
      <div class="pk-sub">{{ group }}</div>
      <div class="pk-grid">
        <button
          v-for="q in items"
          :key="q.id"
          :class="['pk-btn', { on: quality === q.id }]"
          :title="`${root}:${q.id}`"
          @click="quality = q.id; apply()"
        >
          {{ q.label }}
        </button>
      </div>
    </div>

    <!-- 3. 转位 -->
    <div class="pk-label">转位 / 低音</div>
    <div class="pk-grid inv">
      <button
        v-for="inv in INVERSIONS"
        :key="inv.id"
        :class="['pk-btn', { on: inversion === inv.id }]"
        @click="inversion = inv.id; apply()"
      >
        {{ inv.label }}
      </button>
    </div>

    <!-- 结果预览 -->
    <div class="pk-preview">
      <span class="pk-cur">当前结果</span>
      <span class="pk-value">{{ preview }}</span>
      <button class="pk-apply" @click="apply">应用</button>
    </div>

    <!-- 无和弦 -->
    <div class="pk-grid">
      <button
        :class="['pk-btn', 'wide', { on: current === 'N' }]"
        title="这一段没有可识别的和弦"
        @click="emit('pick', 'N')"
      >
        N（无和弦）
      </button>
    </div>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pk-label {
  margin-top: 6px;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-secondary);
}
.pk-group {
  margin-bottom: 2px;
}
.pk-sub {
  font-size: 9.5px;
  color: var(--text-muted);
  margin: 3px 0 2px;
}

.pk-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 3px;
}
.pk-grid.roots {
  grid-template-columns: repeat(6, 1fr);
}
.pk-grid.inv {
  grid-template-columns: repeat(3, 1fr);
}

.pk-btn {
  height: 22px;
  padding: 0;
  font-family: inherit;
  font-size: 10.5px;
  color: var(--text-secondary);
  background: var(--bg-panel-alt);
  border: 1px solid transparent;
  border-radius: 0;
  cursor: pointer;
  transition: all 0.1s;
  white-space: nowrap;
  overflow: hidden;
}
.pk-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.pk-btn.on {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-color: var(--accent-dim);
  color: var(--accent);
  font-weight: 600;
}
.pk-btn:active {
  transform: translateY(1px);
}
.pk-btn.wide {
  grid-column: 1 / -1;
  height: 24px;
}

.pk-preview {
  margin-top: 8px;
  padding: 6px 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-panel-alt);
  border-left: 2px solid var(--accent);
}
.pk-cur {
  font-size: 10px;
  color: var(--text-muted);
}
.pk-value {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.pk-apply {
  height: 22px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 11px;
  color: var(--accent);
  background: rgba(253, 101, 26, 0.12);
  border: 1px solid var(--accent-dim);
  border-radius: 0;
  cursor: pointer;
}
.pk-apply:hover {
  background: rgba(253, 101, 26, 0.2);
}
</style>
