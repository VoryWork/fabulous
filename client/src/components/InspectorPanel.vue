<script setup lang="ts">
/**
 * 右侧检查器 —— 显示当前选中片段的详情与可编辑字段。
 *
 * 假 UI 阶段：字段是只读展示 + 可点击的假按钮，验证信息密度与层次。
 * PRD §4.2 的 TimelineInspector.vue 对应此组件。
 */
import { computed, ref, watch } from 'vue';
import ChordPicker from './ChordPicker.vue';

interface Props {
  /** 选中片段的摘要信息 */
  clip?: {
    kind: string;
    label: string;
    sublabel?: string;
    startSec: number;
    endSec: number;
    state: 'draft' | 'confirmed' | 'rejected';
    confidence?: number;
    /** 源模型 */
    source?: string;
    /** 原始秒数（模型输出，未映射） */
    rawStartSec?: number;
    rawEndSec?: number;
    /**
     * 备选和弦（来自模型概率分布，按概率降序，含当前选中的那个）。
     *
     * 空/未定义 = 这份分析没有概率信息（老产物，或该段无和弦）。
     */
    /** `source: 'madmom'` = 由第二引擎交叉验证补入的候选（粒度只有 maj/min） */
    alternatives?: ReadonlyArray<{ chord: string; prob: number; source?: 'madmom' }>;
  };

  /** 外部要求展开选择器的信号（每次 +1 触发一次展开） */
  openPickerSignal?: number;
}

const props = defineProps<Props & { width?: number }>();

const emit = defineEmits<{
  /** 用户点了某个候选和弦，要求替换当前段 */
  (e: 'pick-chord', chord: string): void;
  /**
   * 用其他词典档位重新分析此段。
   *
   * 目前**没有实现**（需要后端支持局部重绘），按钮禁用并给出说明，
   * 而不是留一个点了没反应的按钮。
   */
  (e: 'reanalyze-segment'): void;
  /** 改片段文本（歌词轨用；和弦/段落各有专用入口） */
  (e: 'set-label', text: string): void;
}>();

const tab = ref<'detail' | 'alternatives' | 'notes'>('detail');

const duration = computed(() => {
  if (!props.clip) return 0;
  return props.clip.endSec - props.clip.startSec;
});

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * 备选和弦 —— 用模型的真实概率分布。
 *
 * 以前这里是三条写死的假数据（V/I/IV/3），纯装饰。
 * 现在接真数据：`analyze_song.py` 把每段的 top-4 和弦连同概率一起输出。
 *
 * 语义：第一条通常就是当前选中的和弦（概率最高），后面是「模型也考虑过的其他解释」。
 * 用户看到第 2~4 条概率也不低时（比如 0.10 vs 0.09），就知道这里本来就模棱两可，
 * 而不是模型信誓旦旦地判错了。
 */
const alternatives = computed(() => {
  const alts = props.clip?.alternatives ?? [];
  const label = props.clip?.label;
  const mapped = alts.map((a) => ({
    chord: a.chord,
    prob: a.prob,
    current: a.chord === label,
    fromMadmom: a.source === 'madmom',
  }));

  /**
   * 用户手动改过和弦（当前值不在模型候选里）→ 把它补在**最前面**。
   *
   * 不加这条的话，手动改完之后没有任何一条匹配 `current`，
   * 列表里全是灰色选项、看不出「现在用的是哪个」，像是坏了。
   *
   * 概率记作 0（模型没给过这个和弦），用 `manual: true` 交给样式区分，
   * 不伪造一个概率数字。
   */
  if (label && mapped.length > 0 && !mapped.some((m) => m.current)) {
    mapped.unshift({ chord: label, prob: 0, current: true, fromMadmom: false });
  }
  return mapped;
});

/** 是否展开和弦选择器 */
const pickerOpen = ref(false);

/**
 * 右键菜单点「编辑」时自动展开（父组件把 signal +1）。
 * 用 watch 而不是 prop 直接绑定：signal 只是"敲一下门"，
 * 之后用户仍可自由折叠，不会被 prop 状态锁住。
 */
watch(
  () => props.openPickerSignal,
  (v) => {
    if (v) pickerOpen.value = true;
  },
);

/** 该段是否「模棱两可」（第一名与第二名差距 < 1.5 倍） */
const isAmbiguous = computed(() => {
  const a = alternatives.value;
  if (a.length < 2) return false;
  return a[1].prob > 0 && a[0].prob / a[1].prob < 1.5;
});

/**
 * 歌词文本的就地编辑。
 *
 * 用本地 ref + 提交式（回车/失焦）而不是直接 v-model 到 props：
 * 每敲一个字就写一次编辑层会塞满撤销栈（Ctrl+Z 要按 10 次才退掉一句）。
 */
const lyricDraft = ref('');
watch(
  () => [props.clip?.kind, props.clip?.label],
  () => {
    if (props.clip?.kind === 'lyric') lyricDraft.value = props.clip.label;
  },
  { immediate: true },
);

function commitLyric() {
  const next = lyricDraft.value.trim();
  if (!next || next === props.clip?.label) {
    lyricDraft.value = props.clip?.label ?? '';
    return;
  }
  emit('set-label', next);
}

/** 假的和声关系索引（PRD §5.4） */
const relations = [
  { type: '前置', chord: 'E:min7', count: 12 },
  { type: '后续', chord: 'C:maj/5', count: 9 },
  { type: '重解释', chord: 'I (D major)', count: 3 },
];
</script>

<template>
  <aside
    class="inspector"
    :style="{ width: (props.width ?? 280) + 'px', flex: `0 0 ${props.width ?? 280}px` }"
  >
    <!-- Tab 头 -->
    <div class="tabs">
      <button :class="['tab', { on: tab === 'detail' }]" @click="tab = 'detail'">详情</button>
      <button :class="['tab', { on: tab === 'alternatives' }]" @click="tab = 'alternatives'">
        多重解释
      </button>
      <button :class="['tab', { on: tab === 'notes' }]" @click="tab = 'notes'">笔记</button>
    </div>

    <div class="insp-scroll">
      <!-- 详情 -->
      <template v-if="tab === 'detail'">
        <template v-if="clip">
          <!-- 主标题 -->
          <div class="insp-head">
            <div class="insp-chord">
              {{ clip.label }}
              <span v-if="clip.sublabel" class="insp-degree">{{ clip.sublabel }}</span>
            </div>
          </div>

          <!-- 歌词文本（只有歌词轨有） -->
          <div v-if="clip.kind === 'lyric'" class="section">
            <div class="section-title">歌词</div>
            <input
              v-model="lyricDraft"
              class="lyric-input"
              placeholder="输入这一句歌词"
              @keydown.enter.prevent="commitLyric"
              @blur="commitLyric"
            />
          </div>

          <!-- 时间信息 -->
          <div class="section">
            <div class="section-title">时间</div>
            <div class="kv"><span>起点</span><b>{{ fmt(clip.startSec) }}</b></div>
            <div class="kv"><span>终点</span><b>{{ fmt(clip.endSec) }}</b></div>
            <div class="kv"><span>时长</span><b>{{ duration.toFixed(2) }}s</b></div>
            <div class="kv muted"><span>原始秒数</span><b>{{ fmt(clip.rawStartSec ?? 0) }}</b></div>
          </div>

          <!-- 来源（歌词没有模型来源，不显示这一块） -->
          <div v-if="clip.kind !== 'lyric'" class="section">
            <div class="section-title">来源</div>
            <div class="kv"><span>模型</span><b>{{ clip.source ?? 'lv-chordia s0-s4' }}</b></div>
            <div class="kv">
              <span>置信度</span>
              <b :class="(clip.confidence ?? 0) > 0.8 ? 'good' : 'warn'">
                {{ Math.round((clip.confidence ?? 0) * 100) }}%
              </b>
            </div>
            <div class="kv"><span>档位</span><b>submission</b></div>
          </div>

          <!--
            模型给出的候选和弦 —— 放在**详情页**而不是「多重解释」标签。
            用户选中和弦段后的第一诉求就是「这个和弦对不对 / 能不能换」，
            把可操作的选项藏在另一个标签页里等于没有。
            点击即替换（走编辑层，支持 Ctrl+Z 撤销）。
          -->
          <div v-if="alternatives.length" class="section">
            <div class="section-title">
              候选和弦
              <span v-if="isAmbiguous" class="ambig-tag" title="前两名概率接近，这里本来就模棱两可">
                模棱两可
              </span>
            </div>
            <!--
              当前采用的那条用 `disabled` 而不是在 @click 里短路：
              短路的话点击会「什么都不发生」——用户以为按钮坏了。
              disabled 有明确的禁用光标和透明度，一看就知道不能点。
            -->
            <button
              v-for="(a, i) in alternatives"
              :key="i"
              :class="['alt-row', 'pickable', { current: a.current }]"
              :disabled="a.current"
              :title="a.current ? '当前已采用，点其他项可替换' : `改用 ${a.chord}`"
              @click="emit('pick-chord', a.chord)"
            >
              <div class="alt-main">
                <span class="alt-chord">{{ a.chord }}</span>
                <span v-if="a.current" class="alt-cur">当前</span>
                <!--
                  第二引擎的候选标出来。它不是「更准的答案」，而是
                  **另一个层面的解释**：madmom 只有 maj/min，所以它可能
                  是 D:maj7 里的 F#:min 那一层。用户看到来源才好判断。
                -->
                <span v-else-if="a.fromMadmom" class="alt-src" title="另一个独立引擎（madmom）在同一位置给出了不同判断">交叉</span>
              </div>
              <div class="alt-right">
                <span :class="['alt-conf', a.prob > 0.5 ? 'good' : a.prob > 0.2 ? 'warn' : 'low']">
                  {{ Math.round(a.prob * 100) }}%
                </span>
                <span class="alt-bar">
                  <span class="alt-bar-fill" :style="{ width: Math.max(2, a.prob * 100) + '%' }" />
                </span>
              </div>
            </button>
            <div class="alt-hint">
              点其他项即可替换（Ctrl+Z 撤销）· 概率来自模型的逐帧分布
              <template v-if="alternatives.some((x) => x.fromMadmom)">
                · 标「交叉」的来自第二引擎 madmom（只能识别大小三和弦）
              </template>
            </div>
          </div>

          <!--
            和弦选择器 —— **只能选，不能填**。
            手填会静默污染下游（级数解析失败、调性推断偏掉），
            而且用户很容易写出模型词表之外的怪值。所以做成
            「根音 → 性质 → 转位」三步点选，结果必然合法。
            候选列表只覆盖模型识别出的段；新建的块靠这里。
          -->
          <div class="section">
            <button class="picker-toggle" @click="pickerOpen = !pickerOpen">
              <span class="chev" :class="{ open: pickerOpen }">▾</span>
              {{ alternatives.length ? '都不对？手动选择和弦' : '选择和弦' }}
            </button>
            <ChordPicker
              v-if="pickerOpen"
              :current="clip.label"
              @pick="emit('pick-chord', $event)"
            />
          </div>

        </template>
        <div v-else class="empty">未选中片段</div>
      </template>

      <!--
        多重解释 —— 候选和弦已经移到「详情」页（那里才能一键替换）。
        这里保留给未来的「同一事件的多层解释」（比如同时记谱为
        Ab:maj 和 G#:maj 两套记法），目前还没实现，明确说明而不是放假数据。
      -->
      <template v-else-if="tab === 'alternatives'">
        <div class="section">
          <div class="section-title">多解解释</div>
          <div class="alt-empty">
            候选和弦已移到「详情」页 —— 选中和弦段后直接在那里点选替换。
            <br /><br />
            本页留给未来的「同一段落的多层记谱」（例如同时保留 Ab:maj 与
            G#:maj 两套写法），目前尚未实现。
          </div>
        </div>

        <div class="section">
          <div class="section-title">和声关系 <span class="ambig-tag">未实现</span></div>
          <div v-for="(r, i) in relations" :key="i" class="rel-row">
            <span class="rel-type">{{ r.type }}</span>
            <span class="rel-chord">{{ r.chord }}</span>
            <span class="rel-count">{{ r.count }}×</span>
          </div>
        </div>
      </template>

      <!-- 笔记 -->
      <template v-else>
        <div class="section">
          <div class="section-title">分析笔记</div>
          <textarea
            class="notes"
            rows="8"
            placeholder="写下对这一段的理解…&#10;&#10;例如：这里的 D 大三和弦是 G 大调的 V，&#10;但进入 Bridge 后它变成了 C 大调的 II，&#10;是个枢纽和弦。"
          />
          <div class="hint">笔记存入 Markdown，与自动生成的索引隔离</div>
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
  min-height: 0;
}

.tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.tab {
  flex: 1;
  padding: 8px 4px;
  font-size: 11.5px;
  color: var(--text-muted);
  border-bottom: 2px solid transparent;
  transition: all 0.12s;
}
.tab:hover {
  color: var(--text-secondary);
  background: var(--bg-hover);
}
.tab.on {
  color: var(--accent);
  border-bottom-color: var(--accent);
  background: rgba(253, 101, 26, 0.05);
}

.insp-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.insp-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--border);
}
.lyric-input {
  width: 100%;
  padding: 5px 8px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 0;
  outline: none;
}
.lyric-input:focus {
  border-color: var(--accent-dim);
  background: #fff;
}

.insp-chord {
  font-size: 19px;
  font-weight: 600;
  color: var(--track-chord);
  line-height: 1.2;
  display: flex;
  align-items: baseline;
  gap: 7px;
  flex-wrap: wrap;
}
.insp-degree {
  font-size: 13px;
  font-weight: 500;
  color: var(--track-degree);
}

.section {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.section-title {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 7px;
}

.kv {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  padding: 2.5px 0;
  color: var(--text-secondary);
}
.kv b {
  color: var(--text-primary);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.kv.muted {
  opacity: 0.65;
}
.good {
  color: var(--success) !important;
}
.warn {
  color: var(--warning) !important;
}
.low {
  color: var(--text-muted) !important;
}

.btn-row {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.btn {
  flex: 1;
  height: 26px;
  font-size: 11.5px;
  border-radius: 0;
  background: var(--bg-panel-alt);
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
  transition: all 0.12s;
}
.btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: #c8c8cc;
}
.btn.primary {
  background: rgba(253, 101, 26, 0.12);
  border-color: var(--accent-dim);
  color: var(--accent);
}
.btn.primary:hover {
  background: rgba(253, 101, 26, 0.2);
}
/* 已生效的状态（确认/拒绝按下去之后）：实心填充，明确表示已应用 */
.btn.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.btn.on:hover {
  background: var(--accent);
  color: #fff;
}
/* 禁用：未实现 / 已是该状态。必须看起来点不动，避免"点了没反应" */
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn:disabled:hover {
  background: var(--bg-panel-alt);
  color: var(--text-secondary);
  border-color: var(--border-strong);
}
.btn.primary:disabled:hover {
  background: rgba(253, 101, 26, 0.12);
  color: var(--accent);
}
/* 按下反馈 */
.btn:not(:disabled):active {
  transform: translateY(1px);
}

.btn.wide {
  width: 100%;
  flex: none;
}

.hint {
  font-size: 10.5px;
  color: var(--text-muted);
  line-height: 1.45;
  margin-top: 5px;
}

.alt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 0;
  background: var(--bg-panel-alt);
  margin-bottom: 4px;
  /* 作为 button 使用时（候选和弦）不能有原生外观 */
  border: none;
  font: inherit;
  color: inherit;
  width: 100%;
  text-align: left;
}
.alt-main {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
/* 候选行现在可点击（详情页里用来换和弦） */
.alt-row.pickable {
  cursor: pointer;
  transition: background 0.1s;
}
/* 只有可点的那几条才有悬停/按下反馈 */
.alt-row.pickable:not(:disabled):hover {
  background: var(--bg-hover);
}
.alt-row.pickable:not(:disabled):active {
  background: var(--bg-active);
}
/* 当前采用的那条：禁用态但**不降低透明度**（它反而是最重要的信息） */
.alt-row.pickable.current {
  cursor: default;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent);
}
.alt-row.pickable:disabled {
  opacity: 1;
}
/* 按下反馈（可点的那几条） */
.alt-row.pickable:not(:disabled):active {
  transform: translateY(1px);
}

.alt-chord {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  /*
   * 不要给和弦名用等宽字体。
   * `--font-mono` 这个变量本文件/样式表里都没定义过，`var(--font-mono, ui-monospace)`
   * 会一路 fallback 到 `monospace` —— Windows 上就是 Courier New，锯齿感很重。
   * 而且 `Ab:maj` 这类记号本来就是符号，用正文字体（Inter / 系统 UI 字体）才协调。
   */
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.1px;
}
/* 「当前」标记：标出哪一条是已经采用的那个 */
.alt-src {
  font-size: 9px;
  line-height: 13px;
  padding: 0 3px;
  margin-left: 4px;
  color: var(--text-dim, #8a8f98);
  border: 1px solid var(--border, #d8dbe0);
  border-radius: 2px;
  white-space: nowrap;
}
.alt-cur {
  font-size: 9.5px;
  padding: 0 4px;
  line-height: 14px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.alt-right {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
}
.alt-conf {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  min-width: 32px;
  text-align: right;
}
.alt-conf.good { color: var(--success); }
.alt-conf.warn { color: var(--warning); }
.alt-conf.low  { color: var(--text-muted); }

/* 概率条：宽度差异要能一眼看出来，所以给个固定的槽宽 */
.alt-bar {
  width: 60px;
  height: 4px;
  background: rgba(154, 154, 157, 0.16);
  overflow: hidden;
}
.alt-bar-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  opacity: 0.65;
}

.ambig-tag {
  margin-left: 6px;
  font-size: 9.5px;
  padding: 0 5px;
  line-height: 15px;
  font-weight: 400;
  color: var(--warning);
  background: rgba(232, 163, 61, 0.14);
}

.alt-hint {
  margin-top: 8px;
  font-size: 10.5px;
  color: var(--text-muted);
  line-height: 1.5;
}
/* 和弦选择器的折叠标题 */
.picker-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 5px 0;
  font-family: inherit;
  font-size: 11px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
}
.picker-toggle:hover {
  color: var(--text-primary);
}
.picker-toggle .chev {
  display: inline-block;
  font-size: 9px;
  transition: transform 0.12s;
  color: var(--text-muted);
}
.picker-toggle .chev.open {
  transform: rotate(180deg);
}

.alt-hint code {
  font-family: inherit;
  padding: 0 3px;
  background: var(--bg-panel-alt);
  color: var(--text-secondary);
}

.alt-empty {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.6;
  padding: 8px 0;
}

.rel-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  padding: 4px 0;
  color: var(--text-secondary);
}
.rel-type {
  width: 42px;
  color: var(--text-muted);
  font-size: 10.5px;
}
.rel-chord {
  flex: 1;
  color: var(--track-chord);
}
.rel-count {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
}

.notes {
  width: 100%;
  resize: vertical;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 0;
  color: var(--text-primary);
  padding: 7px 8px;
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1.6;
  outline: none;
}
.notes:focus {
  border-color: var(--accent-dim);
}

.empty {
  padding: 30px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 11.5px;
}
</style>
