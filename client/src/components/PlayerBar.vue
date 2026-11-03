<script setup lang="ts">
/**
 * 底部播放条：波形 + 播放控制 + 时间显示 + 循环。
 *
 * 播放已真正打通：
 *   - PlaybackController（usePlayback）驱动
 *   - 有音频文件时走 HTMLAudioElement，无音频时走静音推进
 *   - 播放头位置由引擎的 currentTime 驱动，经 TempoMap 换算成 tick
 *
 * 波形：从音频源解码出真峰值（`decodeAudioData`），每首歌算一次并缓存。
 * 解不出来（源不可读 / 格式不支持 / 太长）就**什么都不画** ——
 * 以前这里画的是随机数生成的假波形，看起来像真数据，比空着更糟。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { COLORS } from '../timeline/design/tokens';

const props = defineProps<{
  /** 总时长（秒） */
  durationSec: number;
  /** 当前位置（秒） */
  currentSec: number;
  /** 是否正在播放 */
  playing: boolean;
  /** 循环区间（秒），null 表示无 */
  loopA?: number | null;
  loopB?: number | null;
  /** 当前小节号（1 起） */
  barNumber?: number;
  /** 加载/播放错误 */
  error?: string | null;
  /** 是否有真实音频 */
  hasAudio?: boolean;
  /** 当前音频源（用来解码真实波形；为空则不画波形） */
  audioSrc?: string | null;
}>();

const emit = defineEmits<{
  (e: 'seek', sec: number): void;
  (e: 'toggle-play'): void;
  (e: 'nudge', deltaSec: number): void;
  (e: 'jump-bar', direction: -1 | 1): void;
  (e: 'toggle-loop'): void;
  (e: 'load-file', file: File): void;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const wrapRef = ref<HTMLDivElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const width = ref(800);

/**
 * 波形的固定分辨率。
 *
 * 独立于画布宽度：这样窗口缩放时不用重新解码，只在绘制时做一次索引映射。
 */
const PEAK_BINS = 1024;

/** 每首歌的峰值缓存（按音频源地址）。null = 解过但失败，不再重试。 */
const peaksBySrc = new Map<string, Float32Array | null>();
/** 当前音频源的峰值；null = 还没算好 / 算不出来 → 不画波形 */
const peaksRef = ref<Float32Array | null>(null);
let peaksLoading: string | null = null;

/**
 * 解码音频并算峰值（min/max per bin）。
 *
 * 为什么在前端算而不走 Rust：音频本来就已经交给 `<audio>` 解码播放了，
 * 这里再 `decodeAudioData` 一次就够了，不用新增一条后端命令和一套 IPC。
 * 4 分钟的歌大概几十毫秒到几百毫秒，异步、不挡 UI。
 */
async function computePeaks(src: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // OfflineAudioContext 只为拿到解码器，不需要真的播放
    const ac = new OfflineAudioContext(1, 1, 44100);
    const audio = await ac.decodeAudioData(buf);
    const chans: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
    const n = audio.length;
    if (!n) return null;

    const out = new Float32Array(PEAK_BINS * 2);
    const step = n / PEAK_BINS;
    for (let i = 0; i < PEAK_BINS; i++) {
      const s = Math.floor(i * step);
      const e = Math.min(n, Math.max(s + 1, Math.floor((i + 1) * step)));
      let lo = 0;
      let hi = 0;
      for (const data of chans) {
        for (let k = s; k < e; k++) {
          const v = data[k];
          if (v > hi) hi = v;
          else if (v < lo) lo = v;
        }
      }
      out[i * 2] = lo;
      out[i * 2 + 1] = hi;
    }
    return out;
  } catch (e) {
    console.warn('[player] 波形解码失败，改为不显示波形', e);
    return null;
  }
}

watch(
  () => props.audioSrc,
  async (src) => {
    peaksRef.value = null;
    if (!src) return;
    if (peaksBySrc.has(src)) {
      peaksRef.value = peaksBySrc.get(src) ?? null;
      draw();
      return;
    }
    if (peaksLoading === src) return;
    peaksLoading = src;
    const peaks = await computePeaks(src);
    // 缓存上限：每首 8KB，几百首也就几 MB，但别无限涨（blob: 源 revoke 后
    // 那份峰值再也用不上了）
    if (peaksBySrc.size > 64) peaksBySrc.clear();
    peaksBySrc.set(src, peaks);
    if (peaksLoading === src) peaksLoading = null;
    // 期间用户可能又切歌了，别把旧波形贴到新歌上
    if (props.audioSrc !== src) return;
    peaksRef.value = peaks;
    draw();
  },
);


function draw() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = width.value;
  const h = canvas.clientHeight || 44;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const bins = Math.max(1, Math.floor(w / 2));
  const peaks = peaksRef.value;
  const mid = h / 2;
  const dur = Math.max(0.001, props.durationSec);
  const playedX = (props.currentSec / dur) * w;

  // 循环区间高亮
  if (props.loopA != null && props.loopB != null) {
    const x1 = (props.loopA / dur) * w;
    const x2 = (props.loopB / dur) * w;
    ctx.fillStyle = 'rgba(253, 101, 26, 0.10)';
    ctx.fillRect(x1, 0, x2 - x1, h);
    ctx.strokeStyle = 'rgba(253, 101, 26, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x1) + 0.5, 0);
    ctx.lineTo(Math.round(x1) + 0.5, h);
    ctx.moveTo(Math.round(x2) + 0.5, 0);
    ctx.lineTo(Math.round(x2) + 0.5, h);
    ctx.stroke();
  }

  // 有真实峰值才画；没有就只剩轨道 + 播放头（不画假数据）
  if (peaks) {
    for (let i = 0; i < bins; i++) {
      const x = i * 2;
      // 固定 1024 bin → 画布 bin 的映射（窗口缩放时不用重新解码）
      const p = Math.min(
        PEAK_BINS - 1,
        Math.floor((i / bins) * PEAK_BINS),
      );
      const min = peaks[p * 2];
      const max = peaks[p * 2 + 1];
      const played = x <= playedX;
      ctx.fillStyle = played ? COLORS.accent : COLORS.trackBeat;
      ctx.globalAlpha = played ? 0.9 : 0.5;
      const y1 = mid - max * (mid - 3);
      const y2 = mid - min * (mid - 3);
      ctx.fillRect(x, y1, 1.4, Math.max(1, y2 - y1));
    }
    ctx.globalAlpha = 1;
  }

  // 播放头
  ctx.strokeStyle = COLORS.playhead;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const px = Math.round(playedX) + 0.5;
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.stroke();
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  if (wrapRef.value) {
    width.value = wrapRef.value.clientWidth;
    ro = new ResizeObserver(() => {
      const w = wrapRef.value?.clientWidth ?? width.value;
      if (w !== width.value) width.value = w;
      draw();
    });
    ro.observe(wrapRef.value);
  }
  draw();
});
onBeforeUnmount(() => {
  ro?.disconnect();
});

watch([() => props.currentSec, () => props.loopA, () => props.loopB, width, () => props.durationSec], draw);

// ---------------------------------------------------------------- 波形上拖动定位

function onWaveDown(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  seekFromEvent(e);
  // window 级监听：拖出波形也能继续
  const onMove = (ev: PointerEvent) => seekFromEvent(ev);
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function seekFromEvent(e: PointerEvent) {
  const rect = canvasRef.value?.getBoundingClientRect();
  if (!rect) return;
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  emit('seek', ratio * props.durationSec);
}

// ---------------------------------------------------------------- 文件加载

function pickFile() {
  fileInputRef.value?.click();
}
function onFileChange(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) emit('load-file', f);
  (e.target as HTMLInputElement).value = '';
}

function fmt(sec: number) {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const remain = computed(() => Math.max(0, props.durationSec - props.currentSec));
</script>

<template>
  <footer class="player">
    <!-- 播放控制 -->
    <div class="ctl">
      <button class="play-btn" :title="playing ? '暂停 (Space)' : '播放 (Space)'" @click="emit('toggle-play')">
        <svg v-if="!playing" width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.5 2.8v10.4c0 .5.6.9 1 .6l8-5.2a.7.7 0 000-1.2l-8-5.2c-.4-.3-1 .1-1 .6z" />
        </svg>
        <svg v-else width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
          <rect x="4" y="3" width="3" height="10" rx=".7" />
          <rect x="9" y="3" width="3" height="10" rx=".7" />
        </svg>
      </button>
      <button class="skip-btn" title="上一小节" @click="emit('jump-bar', -1)">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 3v10h1.6V3H4zm8 0L5.8 8l6.2 5V3z" />
        </svg>
      </button>
      <button class="skip-btn" title="下一小节" @click="emit('jump-bar', 1)">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12 3v10h-1.6V3H12zM4 3l6.2 5L4 13V3z" />
        </svg>
      </button>
      <button
        class="loop-btn"
        :class="{ on: loopA != null && loopB != null }"
        title="循环选区"
        @click="emit('toggle-loop')"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path
            d="M3 8a5 5 0 015-5h4M13 8a5 5 0 01-5 5H4"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
          <path d="M10.5 1.5L12.5 3l-2 1.5M5.5 14.5L3.5 13l2-1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <!-- 时间 -->
    <div class="time">
      <span class="t-now">{{ fmt(currentSec) }}</span>
      <span class="t-sep">/</span>
      <span class="t-total">{{ fmt(durationSec) }}</span>
      <span class="t-remain">-{{ fmt(remain) }}</span>
    </div>

    <!-- 小节号 -->
    <div class="position">
      <span class="pos-bar">第 {{ barNumber ?? 1 }} 小节</span>
    </div>

    <!-- 波形 -->
    <div ref="wrapRef" class="wave-wrap" @pointerdown="onWaveDown">
      <canvas ref="canvasRef" class="wave" />
    </div>

    <!-- 右侧：音频源 -->
    <div class="right">
      <button
        class="dev-btn"
        :class="{ warn: !hasAudio }"
        :title="hasAudio ? '换一个音频文件（不改变曲库记录）' : '未加载音频（静音推进），可手动指定一个音频文件'"
        @click="pickFile"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path d="M2 6h2.5L8 3v10L4.5 10H2V6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          <path d="M10.5 5.5a3.5 3.5 0 010 5M12.5 3.5a6 6 0 010 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <span class="dev-name">{{ hasAudio ? '更换音频源' : '选择音频' }}</span>
      </button>
      <input ref="fileInputRef" type="file" accept="audio/*" class="hidden-input" @change="onFileChange" />
    </div>

    <!-- 错误提示 -->
    <div v-if="error" class="err" :title="error">音频错误</div>
  </footer>
</template>

<style scoped>
.player {
  height: 58px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
}

.ctl {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
}
.play-btn {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 0;
  background: var(--accent);
  color: #fff;
  transition: background 0.12s;
  box-shadow: 0 1px 3px rgba(253, 101, 26, 0.35);
}
.play-btn:hover {
  background: var(--accent-hover);
}
.skip-btn,
.loop-btn {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 0;
  color: var(--text-secondary);
}
.skip-btn:hover,
.loop-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.loop-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.time {
  display: flex;
  align-items: baseline;
  gap: 3px;
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
  font-size: 11.5px;
}
.t-now {
  color: var(--text-primary);
  font-weight: 500;
}
.t-sep {
  color: var(--text-muted);
  opacity: 0.6;
}
.t-total {
  color: var(--text-muted);
}
.t-remain {
  color: var(--text-muted);
  font-size: 10.5px;
  margin-left: 5px;
  opacity: 0.75;
}

.position {
  flex: 0 0 auto;
  padding: 1px 7px;
  background: var(--bg-panel-alt);
  border: 1px solid var(--border);
  font-size: 10.5px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.wave-wrap {
  flex: 1;
  min-width: 0;
  height: 30px;
  position: relative;
  cursor: pointer;
}
.wave {
  display: block;
  width: 100%;
  height: 30px;
}

.right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.dev-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  color: var(--text-secondary);
  font-size: 10.5px;
  border: 1px solid var(--border);
  background: var(--bg-panel-alt);
}
.dev-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.dev-btn.warn {
  color: var(--warning);
  border-color: rgba(232, 163, 61, 0.4);
}
.dev-name {
  white-space: nowrap;
}
.hidden-input {
  display: none;
}

.err {
  font-size: 10.5px;
  color: var(--danger);
  border: 1px solid rgba(229, 72, 77, 0.4);
  padding: 1px 7px;
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
