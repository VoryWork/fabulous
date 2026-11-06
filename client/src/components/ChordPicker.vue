<script setup lang="ts">
/**
 * 和弦选择器 —— **点选为主，自定义补充**。
 *
 * ## 统一用我们自己的 X:model 记法
 *
 * 所有对外暴露的写法都是 `根音:性质/转位`（`C:min7`、`C:maj/3`），
 * 不引入第二套记法。理由：
 *   - 分析链路（`chordToNumber` / `inferKey` / 导出）全部按这个格式解析
 *   - 模型输出也是这个格式，用户手写与模型结果能直接对照
 *   - 学一套记法就够，不需要心里做两套译文
 *
 * ## 点选候选从 17 种扩到 49+ 种
 *
 * 原来只放了 `submission_chord_list.txt` 的 17 种性质，但 `validateChord`
 * 早就接受 49 种（来自 full 词表）。结果 `7(b9)`、`min7(b5)`、`maj7(#11)`
 * 这些爵士常用和弦**校验能过、级数算得出、用户却选不到**。
 *
 * ## 为什么还要一个输入框
 *
 * 模型词表里有 21 种**多变化音组合**（`7(b9,b13)`、`sus4(b7,9,13)`…），
 * 铺开成按钮会太长。输入框走同一套语法，实时过 `validateChord`，
 * 合法才允许提交 —— 所以不会把脏数据写进库。
 */
import { computed, ref, watch } from 'vue';
import { validateChord } from '../timeline/domain/ChordNotation';
import { chordToNumber } from '../timeline/demo/realData';

interface Props {
  /** 当前和弦（用来高亮） */
  current?: string;
  /**
   * 当前轨的主音与调式，**只用于输入框的级数预览**。
   *
   * 不传也不影响点选 —— 预览是为了让用户确认
   * 「这个写法在当前调里是几级」，不是必需功能。
   */
  tonic?: string;
  mode?: 'major' | 'minor';
}

const props = defineProps<Props>();

const emit = defineEmits<{
  /** 提交的和弦名（已规范化为 X:model，如 `C:7(b9,b13)`） */
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
  // ---- 基本三和弦
  { id: 'maj', label: '大三', group: '基本' },
  { id: 'min', label: '小三', group: '基本' },
  { id: 'dim', label: '减', group: '基本' },
  { id: 'aug', label: '增', group: '基本' },
  { id: '5', label: '5（强力和弦）', group: '基本' },
  { id: 'sus2', label: 'sus2', group: '基本' },
  { id: 'sus4', label: 'sus4', group: '基本' },

  // ---- 六和弦
  { id: 'maj6', label: '大六', group: '六和弦' },
  { id: 'min6', label: '小六', group: '六和弦' },

  // ---- 七和弦
  { id: '7', label: '属七', group: '七和弦' },
  { id: 'maj7', label: '大七', group: '七和弦' },
  { id: 'min7', label: '小七', group: '七和弦' },
  { id: 'dim7', label: '减七', group: '七和弦' },
  { id: 'hdim7', label: '半减七', group: '七和弦' },
  { id: 'minmaj7', label: '小大七', group: '七和弦' },

  // ---- 九 / 十一 / 十三
  { id: '9', label: '属九', group: '扩展' },
  { id: 'maj9', label: '大九', group: '扩展' },
  { id: 'min9', label: '小九', group: '扩展' },
  { id: '11', label: '属十一', group: '扩展' },
  { id: 'min11', label: '小十一', group: '扩展' },
  { id: '13', label: '属十三', group: '扩展' },
  { id: 'min13', label: '小十三', group: '扩展' },
  { id: 'maj13', label: '大十三', group: '扩展' },

  // ---- 悬挂变化（模型词表里的）
  { id: 'sus4(b7)', label: 'sus4(b7)', group: '悬挂变化' },
  { id: 'sus2(b7)', label: 'sus2(b7)', group: '悬挂变化' },

  // ---- 属和弦变化音（爵士最常用的一档）
  { id: '7(b5)', label: '7(b5)', group: '属和弦变化' },
  { id: '7(b9)', label: '7(b9)', group: '属和弦变化' },
  { id: '7(#9)', label: '7(#9)', group: '属和弦变化' },
  { id: '7(#11)', label: '7(#11)', group: '属和弦变化' },
  { id: '7(b13)', label: '7(b13)', group: '属和弦变化' },
  { id: '7(9)', label: '7(9)', group: '属和弦变化' },
  { id: '7(11)', label: '7(11)', group: '属和弦变化' },
  { id: '7(13)', label: '7(13)', group: '属和弦变化' },
  { id: '9(b5)', label: '9(b5)', group: '属和弦变化' },
  { id: '9(#11)', label: '9(#11)', group: '属和弦变化' },
  { id: '9(b13)', label: '9(b13)', group: '属和弦变化' },

  // ---- 其他变化
  { id: 'maj(b5)', label: 'maj(b5)', group: '其他变化' },
  { id: 'maj(b9)', label: 'maj(b9)', group: '其他变化' },
  { id: 'maj(#11)', label: 'maj(#11)', group: '其他变化' },
  { id: 'maj7(#11)', label: 'maj7(#11)', group: '其他变化' },
  { id: 'maj7(#5)', label: 'maj7(#5)', group: '其他变化' },
  { id: 'maj7(9)', label: 'maj7(9)', group: '其他变化' },
  { id: 'maj9(#11)', label: 'maj9(#11)', group: '其他变化' },
  { id: 'min7(b5)', label: 'min7(b5)', group: '其他变化' },
  { id: 'min7(9)', label: 'min7(9)', group: '其他变化' },
  { id: 'min7(11)', label: 'min7(11)', group: '其他变化' },
  { id: 'min7(b13)', label: 'min7(b13)', group: '其他变化' },
  { id: 'aug(7)', label: 'aug(7)', group: '其他变化' },
  { id: 'aug(b7)', label: 'aug(b7)', group: '其他变化' },
];

/**
 * 转位 / 低音。
 *
 * 从 5 个扩到 22 个 —— 和 `ChordNotation.INVERSIONS` 对齐。
 * `bb6` / `bb7` 这种重降看起来怪，但模型词表里真有，谱面上也确实存在
 * （比如把和弦七音写成重降来保持音级拼写的一致性）。
 */
const INVERSIONS: Array<{ id: string; label: string }> = [
  { id: '', label: '原位' },
  { id: '3', label: '/3 一转' },
  { id: '5', label: '/5 二转' },
  { id: '7', label: '/7' },
  { id: 'b7', label: '/b7' },
  { id: '9', label: '/9' },
  { id: '11', label: '/11' },
  { id: '2', label: '/2' },
  { id: 'b2', label: '/b2' },
  { id: 'b3', label: '/b3' },
  { id: 'b5', label: '/b5' },
  { id: 'b6', label: '/b6' },
  { id: 'b8', label: '/b8' },
  { id: 'b9', label: '/b9' },
  { id: '#1', label: '/#1' },
  { id: '#4', label: '/#4' },
  { id: '#5', label: '/#5' },
  { id: 'bb6', label: '/bb6' },
  { id: 'bb7', label: '/bb7' },
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

/**
 * 切换选中块时同步选择器状态。
 *
 * 之前只在初始化时调一次 `syncFrom`，用户选中另一个块时
 * 选择器还停在旧和弦上 —— 看着像没响应。
 */
watch(
  () => props.current,
  (v) => syncFrom(v),
);

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
// ---------------------------------------------------------------- 自定义输入

/**
 * 自定义输入框的内容。
 *
 * 语法就是咱们自己的 `X:model`（`C:7(b9,b13)`），和模型输出、
 * 落库格式完全一致 —— 用户不需要学第二套记法。
 */
const typed = ref('');

/**
 * 实时校验结果（走卡片里现有的 `validateChord`）。
 *
 * 为什么用它而不是自己写正则：它已经处理了这些情况：
 *   - `Cm7` → `C:min7` 的别名纠正（带 hint）
 *   - `Ab` 单写 → 补成 `Ab:maj`
 *   - `C:maj7(#11)` 这类多变化音组合
 * 手写一套只会和它不一致。
 */
const typedResult = computed(() => {
  const text = typed.value.trim();
  if (!text) return null;
  return validateChord(text);
});

/** 输入合法时预览级数（用当前轨的主音算） */
const typedDegree = computed(() => {
  if (typedResult.value?.ok !== true) return null;
  const tonic = props.tonic ?? '';
  if (!tonic) return null;
  return chordToNumber(typedResult.value.normalized, tonic, props.mode ?? 'major');
});

function applyTyped() {
  if (typedResult.value?.ok !== true) return;
  emit('pick', typedResult.value.normalized);
  typed.value = '';
}
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

    <!--
      自定义具体写法（**还是我们自己的 X:model 记法**）。

      点选能覆盖常用情况，但模型词表里还有 `7(b9,b13)`、
      `sus4(b7,9,13)` 这种多变化音组合，铺开成按钮会太长，
      所以留一个输入框。**语法就是 `C:7(b9,b13)`**，用户不需要
      学另一套记法。

      输入实时过 `validateChord`：合法绿色、非法红色并说明原因，
      不会把脏数据写进库。
    -->
    <div class="pk-label">自定义（X:model）</div>
    <div class="pk-typed">
      <input
        class="pk-input"
        :class="{ bad: typed && typedResult && !typedResult.ok, good: typedResult?.ok === true }"
        v-model="typed"
        :placeholder="`${root}:maj7(#11)`"
        spellcheck="false"
        @keydown.enter.prevent="applyTyped"
      />
      <button class="pk-apply" :disabled="typedResult?.ok !== true" @click="applyTyped">
        应用
      </button>
    </div>
    <!-- 校验反馈：合法显示规范写法 + 级数，非法显示原因 -->
    <div v-if="typed && typedResult" class="pk-feedback">
      <span v-if="typedResult.ok" class="ok">
        将保存为 {{ typedResult.normalized }}
        <template v-if="typedDegree">
          · 级数 {{ typedDegree }}
        </template>
        <template v-if="typedResult.hint">
          <br />
          <span class="warn">{{ typedResult.hint }}</span>
        </template>
      </span>
      <span v-else class="err">{{ typedResult.error }}</span>
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
/* ---- 手写输入 ---- */
.pk-typed {
  display: flex;
  gap: 4px;
  align-items: center;
}
.pk-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 7px;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--text-primary);
  background: var(--bg-panel-alt);
  border: 1px solid var(--border);
  border-radius: 0;
  outline: none;
}
.pk-input:focus {
  border-color: var(--accent-dim);
}
/* 校验结果的颜色：绿=可提交，红=算不出结构。 */
.pk-input.good {
  border-color: #3f9e5a;
}
.pk-input.bad {
  border-color: #c2453d;
}
.pk-apply:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.pk-feedback {
  font-size: 10px;
  line-height: 1.35;
  padding: 1px 2px 0;
  word-break: break-all;
}
.pk-feedback .ok {
  color: #3f7a4f;
}
.pk-feedback .warn {
  color: #9a7b21;
}
.pk-feedback .err {
  color: #c2453d;
}
</style>
