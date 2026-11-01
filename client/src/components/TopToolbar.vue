<script setup lang="ts">
/**
 * 顶部工具栏：曲目信息 + 分析档位 + 视图操作。
 *
 * 假 UI 阶段：所有按钮可点击但不真正执行，档位切换会更新选中态以便检查视觉。
 * 「分析档位」是 ADR-0002 的三档，UI 必须说明差异是"记谱精细度"而非和弦判断。
 */
import { computed, ref } from 'vue';
import type { Window as WebviewWindow } from '@tauri-apps/api/window';
import KeyPicker from './KeyPicker.vue';

/**
 * 窗口控制。
 *
 * ## 为什么用动态 import 而不是顶层 import
 *
 * 浏览器模式（`bun run dev` 直接开 1420 端口调试）下没有 Tauri runtime，
 * 顶层 `import { getCurrentWindow } from '@tauri-apps/api/window'` 在调用时
 * 会抛错、整页白屏。动态 import + try/catch 让浏览器里这些按钮变成空操作，
 * 调试体验不受影响。
 */
async function withWindow(
  fn: (w: WebviewWindow) => Promise<unknown>,
): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await fn(getCurrentWindow());
  } catch {
    // 浏览器模式 / 权限不足：静默忽略
  }
}

const minimize = () => withWindow((w) => w.minimize());
const toggleMaximize = () => withWindow((w) => w.toggleMaximize());
const closeWindow = () => withWindow((w) => w.close());

interface Props {
  title: string;
  artist: string;
  bpm: number;
  keyName: string;
  /** 调性是否由用户手动指定（顶栏标「手动」而不是默认的自动推断） */
  keyIsManual?: boolean;
  /** 自动推断出来的调性（弹层里作对照显示） */
  autoKey?: { tonic: string; mode: string } | null;
  /** 当前生效的主音 + 调式（受控） */
  keyValue?: { tonic: string; mode: 'major' | 'minor' };
  /**
   * 调音偏差（音分）。非 0 且已校正时在调性旁标一个小标记，
   * 提醒用户「这首录音不是标准 440，和弦名是按校正后的音高分析的」。
   */
  tuningCents?: number;
  meter: string;
  dictionary: 'submission' | 'ismir2017' | 'full';
  bars: number;
  beats: number;
  segments: number;
  /** 当前缩放百分比（滑块受控） */
  zoomPercent?: number;
  canUndo?: boolean;
  canRedo?: boolean;
  /** 自动滚动（跟随播放头）开关 */
  autoScroll?: boolean;
  /** 当前曲目正在分析中（按钮禁用 + 换文案） */
  reanalyzing?: boolean;
  /** 有分析结果才允许导出（空谱面导出来是一份空报告，没意义） */
  canExport?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  zoomPercent: 100,
  canUndo: false,
  canRedo: false,
  autoScroll: true,
  reanalyzing: false,
  canExport: false,
});
const emit = defineEmits<{
  (e: 'zoom-in'): void;
  (e: 'zoom-out'): void;
  (e: 'zoom-fit'): void;
  (e: 'zoom-set', pct: number): void;
  (e: 'dictionary-change', v: 'submission' | 'ismir2017' | 'full'): void;
  (e: 'undo'): void;
  (e: 'redo'): void;
  (e: 'toggle-auto-scroll'): void;
  (e: 'reanalyze'): void;
  /** 用户手动指定调性 */
  (e: 'set-key', v: { tonic: string; mode: 'major' | 'minor' }): void;
  /** 恢复自动推断的调性 */
  (e: 'reset-key'): void;
  /** 导出讲解稿（Markdown，给人看） */
  (e: 'export-lecture'): void;
  /** 导出工程文件（.fbsong，完整 JSON） */
  (e: 'export-fbsong'): void;
}>();

/** 调性选择弹层开关 */
const keyOpen = ref(false);

/**
 * 当前生效的调性。
 *
 * `keyValue` 是受控 prop，但调用方可能没传 —— 兜底从 `keyName`
 * 反解出主音（形如 "A major"），避免 KeyPicker 拿到 undefined 直接崩。
 */
const keyValue = computed<{ tonic: string; mode: 'major' | 'minor' }>(() => {
  if (props.keyValue) return props.keyValue;
  const parts = (props.keyName || '').trim().split(/\s+/);
  return {
    tonic: parts[0] ?? '',
    mode: parts[1] === 'minor' ? 'minor' : 'major',
  };
});

function onKeyPick(v: { tonic: string; mode: 'major' | 'minor' }) {
  emit('set-key', v);
  // 选完不自动关：用户常要边看级数轨的变化边微调
}

/** 缩放条的范围：10% – 800% */
const ZOOM_MIN = 10;
const ZOOM_MAX = 800;

function onZoomSlide(e: Event) {
  const v = Number((e.target as HTMLInputElement).value);
  emit('zoom-set', v);
}

const dict = ref(props.dictionary);
const dictOpen = ref(false);

const DICT_INFO = {
  submission: { label: 'submission', desc: '通用（推荐）', rows: 25, ms: '241ms' },
  ismir2017: { label: 'ismir2017', desc: '研究对比，抹掉转位/低音', rows: 14, ms: '136ms' },
  full: { label: 'full', desc: '爵士、复杂和声', rows: 381, ms: '2.0s' },
} as const;

function pickDict(v: 'submission' | 'ismir2017' | 'full') {
  dict.value = v;
  dictOpen.value = false;
  emit('dictionary-change', v);
}

const current = computed(() => DICT_INFO[dict.value]);
</script>

<template>
  <!--
    无边框窗口的标题栏。

    `data-tauri-drag-region` 是 Tauri 2 提供的：按住这块区域拖动 = 拖窗口。
    注意它**只在直接命中该元素本身时生效**，子元素会吞掉事件 ——
    所以下面每个视觉子块都单独标了，否则只有空隙能拖，手感很怪。
  -->
  <header class="toolbar" data-tauri-drag-region>
    <!-- 曲目信息 -->
    <div class="song-info" data-tauri-drag-region>
      <div class="song-title">{{ title }}</div>
      <div class="song-meta">
        <span>{{ artist }}</span>
        <span class="dot">·</span>
        <!--
          空谱面（分析中/待分析）时这些值全是 0 或空串，直接显示会变成
          「0.0 BPM · C major · 0 小节」，看着像分析结果其实是占位。
          统一降级成「—」。
        -->
        <span class="stat"><b>{{ bpm > 0 ? bpm.toFixed(1) : '—' }}</b> BPM</span>
        <span class="dot">·</span>
        <span class="stat">
          <!--
            调性可点开修改。
            自动推断会错（转调歌、关系调歧义、调式音阶），
            而用户往往一眼就知道正确调性 —— 不给改会一直别扭。
          -->
          <button
            class="key-btn"
            :class="{ manual: keyIsManual }"
            :title="keyIsManual
              ? '手动指定（点击可重新选择或恢复自动）'
              : '自动推断（点击可手动指定）'"
            :disabled="bars === 0"
            @click="keyOpen = !keyOpen"
          >
            <b>{{ keyName || '—' }}</b>
            <span v-if="keyIsManual" class="key-manual-tag">手动</span>
          </button>
          <span
            v-if="tuningCents"
            class="tuning-badge"
            :title="`录音实测偏低/偏高 ${Math.abs(tuningCents).toFixed(0)} 音分（非标准 A=440），分析前已校正。若按原调弹奏，和弦名需整体移调。`"
          >±{{ Math.abs(tuningCents).toFixed(0) }}¢</span>

          <!-- 调性选择弹层 -->
          <div v-if="keyOpen" class="key-pop" @click.stop>
            <KeyPicker
              :model-value="keyValue"
              :auto-key="autoKey"
              :is-overridden="keyIsManual === true"
              @update:model-value="onKeyPick"
              @reset="emit('reset-key')"
            />
          </div>
        </span>
        <span class="dot">·</span>
        <span class="stat"><b>{{ bars > 0 ? meter : '—' }}</b></span>
        <span class="dot">·</span>
        <span class="stat">
          <template v-if="bars > 0">{{ bars }} 小节 / {{ beats }} 拍 / {{ segments }} 和弦段</template>
          <template v-else>等待分析结果</template>
        </span>
      </div>
    </div>

    <div class="spacer" />

    <!-- 分析档位 -->
    <div class="dict-wrap">
      <button class="dict-btn" :class="{ open: dictOpen }" @click="dictOpen = !dictOpen">
        <span class="dict-label">档位</span>
        <span class="dict-value">{{ current.label }}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path d="M1 3l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>

      <div v-if="dictOpen" class="dict-menu">
        <button
          v-for="(info, k) in DICT_INFO"
          :key="k"
          :class="['dict-item', { active: dict === k }]"
          @click="pickDict(k as 'submission' | 'ismir2017' | 'full')"
        >
          <div class="di-main">
            <span class="di-name">{{ info.label }}</span>
            <span class="di-desc">{{ info.desc }}</span>
          </div>
          <div class="di-meta">
            <span>{{ info.rows }} 行</span>
            <span>{{ info.ms }}</span>
          </div>
        </button>
        <div class="dict-note">档位影响记谱精细度（转位/低音是否保留），不影响和弦判断</div>
      </div>
    </div>

    <div class="divider" />

    <!-- 视图操作 -->
    <div class="group">
      <button class="tb-btn" title="缩小" @click="emit('zoom-out')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          <path d="M5 7h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
      <button class="tb-btn" title="放大" @click="emit('zoom-in')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          <path d="M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
      <button class="tb-btn" title="适应宽度" @click="emit('zoom-fit')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2 5V2h3M14 5V2h-3M2 11v3h3M14 11v3h-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <!-- 横向缩放滑块：精确控制，比只有 +/− 按钮直观 -->
      <div class="zoom-slider" title="横向缩放">
        <input
          type="range"
          :min="ZOOM_MIN"
          :max="ZOOM_MAX"
          :value="props.zoomPercent"
          @input="onZoomSlide"
        />
        <span class="zoom-value">{{ props.zoomPercent }}%</span>
      </div>

      <!-- 自动滚动开关：播放时让时间轴跟随播放头 -->
      <button
        class="tb-btn follow-btn"
        :class="{ on: props.autoScroll }"
        :title="props.autoScroll ? '自动滚动：开（播放时跟随播放头）' : '自动滚动：关'"
        @click="emit('toggle-auto-scroll')"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2 8h3M11 8h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          <path d="M6 5v6M10 5v6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          <path d="M4.5 6L2.5 8l2 2M11.5 6l2 2-2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <div class="divider" />

    <div class="group">
      <button
        class="tb-btn"
        :disabled="props.canUndo === false"
        title="撤销 (Ctrl+Z)"
        @click="emit('undo')"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M3 8h6a3.5 3.5 0 110 7H7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" transform="rotate(180 8 8) translate(0 -3)" />
          <path d="M5 5L2.5 8 5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -2)" />
        </svg>
      </button>
      <button
        class="tb-btn"
        :disabled="props.canRedo === false"
        title="重做 (Ctrl+Shift+Z)"
        @click="emit('redo')"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M13 8H7a3.5 3.5 0 100 7h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" transform="translate(0 -3)" />
          <path d="M11 5l2.5 3L11 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -2)" />
        </svg>
      </button>
    </div>

    <div class="divider" />

    <!-- 主要动作 -->
    <button
      class="act-btn"
      :disabled="reanalyzing"
      :title="reanalyzing ? '分析进行中…' : '丢掉当前分析结果，从头重跑一遍'"
      @click="emit('reanalyze')"
    >
      {{ reanalyzing ? '分析中…' : '重新分析全曲' }}
    </button>
    <!--
      两种导出，定位完全不同：
        导出讲解 → Markdown，给人读（笔记 / 分享 / 教学），丢掉精度换可读性
        导出 .fbsong → 完整 JSON，给程序读（备份 / 迁移 / 再导入），不裁任何字段
      所以并列成两个按钮，而不是一个「导出」加格式下拉 ——
      用户点的时候心里已经明确「我要给人看」还是「我要备份」。
    -->
    <button
      class="act-btn"
      :disabled="!canExport"
      title="生成一份可读的和声讲解（Markdown）"
      @click="emit('export-lecture')"
    >
      导出讲解
    </button>
    <button
      class="act-btn primary"
      :disabled="!canExport"
      title="完整导出为 .fbsong（纯文本 JSON，可用于备份/迁移）"
      @click="emit('export-fbsong')"
    >
      导出 .fbsong
    </button>

    <!--
      窗口控制按钮。
      自己画的理由：Windows 原生标题栏在深色/自定义配色下永远显得是"别人的"，
      而且高度、圆角、图标粗细都和界面不搭。

      注意：**无边框窗口不能用 CSS 变量之外的主题色直接画**，否则
      悬停时的红色关闭键会和界面的橙色主色打架 —— 这里关闭键的红色
      是系统惯例，保留（用户对红色 × 的认知比配色统一更重要）。
    -->
    <div class="win-ctrls">
      <button class="win-btn" title="最小化" @click="minimize()">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 5h10" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
      <button class="win-btn" title="最大化" @click="toggleMaximize()">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
      <button class="win-btn close" title="关闭" @click="closeWindow()">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.toolbar {
  height: 52px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  /* 右边距 0：窗口按钮要贴到窗口边缘（系统惯例），由按钮自己提供内边距 */
  padding: 0 0 0 14px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  /* 无边框窗口：选区/拖拽时禁止文字被选中，否则拖窗口会顺手选中标题 */
  user-select: none;
}

/* 主要动作按钮和窗口按钮之间留出呼吸距离 */
.act-btn.primary {
  margin-right: 10px;
}

/* ---- 窗口控制按钮 ---- */
.win-ctrls {
  display: flex;
  align-self: stretch;
  margin-left: 6px;
  flex: none;
}
.win-btn {
  width: 44px;
  height: 100%;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-dim, #6b7280);
  cursor: default;
  transition: background 90ms linear, color 90ms linear;
}
.win-btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--text, #1f2328);
}
.win-btn:active {
  background: rgba(0, 0, 0, 0.1);
}
/* 关闭键的红色是系统惯例 —— 比配色统一更重要的用户预期 */
.win-btn.close:hover {
  background: #e81123;
  color: #fff;
}
.win-btn.close:active {
  background: #c50f1f;
}

.song-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
}
.song-title {
  font-size: 14.5px;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.25;
}
.song-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--text-muted);
  white-space: nowrap;
}

/* 右上「分析中…」等状态区：调性按钮和调音徽章需要并排布局 */
.stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  position: relative;
}

/* ---- 调性按钮 ---- */
.key-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 5px;
  margin: -1px -2px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition: background 90ms linear, border-color 90ms linear;
}
.key-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.04);
  border-color: var(--border);
}
.key-btn:disabled {
  cursor: default;
  opacity: 0.6;
}
/* 手动指定的调性和自动推断要在视觉上能区分 —— 否则用户改了也看不出来 */
.key-btn.manual b {
  color: var(--accent, #e8722d);
}
.key-manual-tag {
  font-size: 9px;
  line-height: 12px;
  padding: 0 3px;
  border-radius: 2px;
  background: rgba(232, 114, 45, 0.12);
  color: var(--accent, #e8722d);
}

/* 调性选择弹层 */
.key-pop {
  position: absolute;
  top: calc(100% + 8px);
  left: -8px;
  z-index: 60;
  width: 210px;
  padding: 10px 11px 11px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel, #fff);
  box-shadow: 0 8px 24px -6px rgba(16, 24, 40, 0.18);
  /* 弹层里要能选中文字（整个标题栏 user-select: none） */
  user-select: text;
}

/* 调音偏差徽章 */
.tuning-badge {
  font-size: 9.5px;
  font-weight: 400;
  padding: 0 4px;
  line-height: 14px;
  border-radius: 2px;
  color: var(--warning, #e8a33d);
  background: rgba(232, 163, 61, 0.14);
  cursor: help;
}
.song-meta b {
  color: var(--text-secondary);
  font-weight: 500;
}
.dot {
  opacity: 0.5;
}

.spacer {
  flex: 1;
}

.divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  flex: 0 0 auto;
}

.group {
  display: flex;
  gap: 1px;
}

.tb-btn {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 0;
  color: var(--text-secondary);
  transition: all 0.1s;
}
.tb-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.tb-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.tb-btn:disabled:hover {
  background: none;
  color: var(--text-secondary);
}

/* 自动滚动开关：开启时高亮 */
.tb-btn.follow-btn.on {
  color: var(--accent);
  background: var(--accent-soft);
}
.tb-btn.follow-btn.on:hover {
  background: var(--accent-dim);
}

/* 横向缩放滑块 */
.zoom-slider {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
}
.zoom-slider input[type='range'] {
  width: 96px;
  height: 14px;
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  cursor: pointer;
}
.zoom-slider input[type='range']::-webkit-slider-runnable-track {
  height: 3px;
  background: var(--border-strong);
}
.zoom-slider input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 10px;
  height: 10px;
  margin-top: -3.5px;
  background: var(--accent);
  border-radius: 50%;
}
.zoom-slider input[type='range']:hover::-webkit-slider-thumb {
  background: var(--accent-hover);
}
.zoom-value {
  font-size: 10.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 34px;
  text-align: right;
}

.act-btn {
  height: 28px;
  padding: 0 11px;
  font-size: 11.5px;
  border-radius: 0;
  background: var(--bg-panel-alt);
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
  white-space: nowrap;
  transition: all 0.12s;
}
.act-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.act-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 500;
}
.act-btn.primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

/* 档位下拉 */
.dict-wrap {
  position: relative;
}
.dict-btn {
  height: 30px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 0;
  background: var(--bg-panel-alt);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 11.5px;
}
.dict-btn:hover,
.dict-btn.open {
  background: var(--bg-hover);
  border-color: #c8c8cc;
}
.dict-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.dict-value {
  color: var(--accent);
  font-weight: 500;
}

.dict-menu {
  position: absolute;
  top: 34px;
  right: 0;
  width: 268px;
  background: var(--bg-panel-alt);
  border: 1px solid var(--border-strong);
  border-radius: 0;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
  padding: 4px;
  z-index: 100;
}
.dict-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 0;
  text-align: left;
}
.dict-item:hover {
  background: var(--bg-hover);
}
.dict-item.active {
  background: rgba(253, 101, 26, 0.09);
}
.di-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.di-name {
  font-size: 11.5px;
  color: var(--text-primary);
  font-weight: 500;
}
.dict-item.active .di-name {
  color: var(--accent);
}
.di-desc {
  font-size: 10.5px;
  color: var(--text-muted);
}
.di-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-size: 10px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}
.dict-note {
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.45;
  padding: 6px 8px 4px;
  border-top: 1px solid var(--border);
  margin-top: 4px;
}
</style>
