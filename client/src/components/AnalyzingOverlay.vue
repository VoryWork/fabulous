<!--
  分析进行中的覆盖层。

  ## 为什么分析时要盖住编辑区

  分析中的谱面是**半成品**：拍点可能还会重算、和弦还会大段增删。
  这时让用户编辑有三个坏结果：
    1. 改完被后续结果覆盖（还以为是 bug）
    2. 用户改的和模型推的混在一起，分不清谁是谁
    3. 撤销栈里混进跨阶段的命令，Ctrl+Z 行为诡异

  所以分析期间**锁住编辑**，并且明确告诉用户「在跑、跑到哪了」。

  ## 动画设计

  不用转圈 loader —— 那和这个界面的气质（波形、和弦、时间轴）无关。
  这里用「一条被逐段点亮的轨道」：

    - 底层是静态的虚线轨道（暗示"还没填满的位置"）
    - 上层是按进度生长的光带，带柔和的尾焰
    - 光带前端有一个脉冲点，用 box-shadow 呼吸
    - 背后有极淡的斜纹缓慢平移，表示"正在处理"

  三段并行的细条表示分析的三个主要阶段（拍点 / 和弦 / 结构），
  已完成的是实色，正在跑的呼吸，未开始的是灰虚线。
-->
<template>
  <div class="analyzing-overlay">
    <div class="ao-inner">
      <!-- 标题行 -->
      <div class="ao-title">
        <span class="ao-dot" />
        正在分析
      </div>
      <div class="ao-song">{{ title || '未命名' }}</div>

      <!-- 阶段条 -->
      <div class="ao-stages">
        <div
          v-for="s in stages"
          :key="s.key"
          :class="['ao-stage', s.state]"
        >
          <span class="ao-stage-name">{{ s.label }}</span>
          <span class="ao-stage-bar">
            <span class="ao-stage-fill" :style="{ width: s.pct * 100 + '%' }" />
          </span>
        </div>
      </div>

      <!-- 主进度：光带 -->
      <div class="ao-track">
        <div class="ao-track-base" />
        <div class="ao-track-glow" :style="{ width: pct * 100 + '%' }">
          <span class="ao-track-head" />
        </div>
      </div>

      <!-- 文案 + 已用时（阶段内部长时间没进度时，这个数字在动 = 没死） -->
      <div class="ao-foot">
        <span class="ao-msg">{{ message }}</span>
        <span v-if="elapsedMs" class="ao-elapsed">{{ elapsedText }}</span>
      </div>

      <!-- 切走提示：用户不知道「可以切到别的歌」会干等 -->
      <div class="ao-hint">
        可以先切到其他歌曲，分析会在后台继续
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  /** 曲名（用于提示"在分析哪首"） */
  title?: string;
  /** 0~1 总进度 */
  pct: number;
  /** 当前阶段描述（来自后端 progress.message） */
  message?: string;
  /** 后端阶段名（beats / chords / structure / tuning …） */
  stage?: string;
  /**
   * 已推送到前端的部分结果阶段（partial 事件）。
   * 有拍点就说明 beats 那段跑完了 —— 用它点亮阶段条。
   */
  doneStages?: string[];
  /** 本次分析已用时（毫秒）。阶段内部没进度时，这个数字在涨就是"还活着"。 */
  elapsedMs?: number;
}>();

/**
 * 三个主阶段。
 *
 * 顺序和后端一致（analyze_song.py）：tuning → beats → chords → structure。
 * tuning 很快且大多数歌不需要校正，不单独占一条，并进 beats 一起显示。
 */
/**
 * 三个主阶段，**区间必须和后端 `analyze_file_with` 里的 pct 对齐**：
 *
 *   probe+tuning 0.00–0.14 → beats 0.14–0.46 → chords 0.46–0.87 → structure 0.87–0.97
 *
 * 第一段把「读音频 / 调音」也算进去（用户视角那就是"节拍阶段在准备"），
 * 否则一开始三条都空着、主进度条却已经动了一点，看着像错位。
 */
const STAGE_DEFS = [
  { key: 'beats', label: '节拍', from: 0, to: 0.46 },
  { key: 'chords', label: '和弦', from: 0.46, to: 0.87 },
  { key: 'structure', label: '结构', from: 0.87, to: 0.98 },
] as const;

const done = computed(() => new Set(props.doneStages ?? []));

/**
 * 把「总进度」和「阶段完成情况」合成每条阶段条的状态。
 *
 * 为什么不用后端给的 pct 直接切分：pct 是后端自己报的，
 * 和这里的阶段定义不一定对齐（比如后端把 tuning 算进 0.03~0.04）。
 * 用 partial 事件（真实数据到达）来判定「完成」最可靠，
 * 进度条只负责给"正在跑的那条"画生长动画。
 */
const stages = computed(() => {
  const p = Math.max(0, Math.min(1, props.pct || 0));
  const out: { key: string; label: string; state: string; pct: number }[] = [];
  for (const d of STAGE_DEFS) {
    const isDone = done.value.has(d.key);
    const started = p >= d.from;
    // 阶段内进度 = 总进度落在 [from, to] 里的比例
    const span = d.to - d.from;
    const local = isDone
      ? 1
      : started
        ? Math.max(0, Math.min(1, (p - d.from) / span))
        : 0;
    out.push({
      key: d.key,
      label: d.label,
      state: isDone ? 'done' : started ? 'running' : 'pending',
      pct: local,
    });
  }
  return out;
});

/** 已用时文案：<10s 显示一位小数，超过 1 分钟显示 m:ss */
const elapsedText = computed(() => {
  const ms = props.elapsedMs ?? 0;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
});

const pct = computed(() => Math.max(0, Math.min(1, props.pct || 0)));
</script>

<style scoped>
.analyzing-overlay {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  /* 半透明 + 模糊：底下的谱面轮廓还在，用户知道"东西在哪"，但看不清细节 */
  background: rgba(250, 251, 252, 0.82);
  backdrop-filter: blur(2.5px);
  animation: ao-fade 220ms ease-out;
}

@keyframes ao-fade {
  from {
    opacity: 0;
  }
}

.ao-inner {
  width: 320px;
  padding: 22px 24px 20px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow:
    0 1px 2px rgba(16, 24, 40, 0.04),
    0 12px 32px -8px rgba(16, 24, 40, 0.12);
}

/* ---- 标题 ---- */
.ao-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text, #1f2328);
}
.ao-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, #e8722d);
  animation: ao-pulse 1.4s ease-in-out infinite;
}
@keyframes ao-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(232, 114, 45, 0.45);
    opacity: 1;
  }
  50% {
    box-shadow: 0 0 0 5px rgba(232, 114, 45, 0);
    opacity: 0.75;
  }
}
.ao-song {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-dim, #8a8f98);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 阶段条 ---- */
.ao-stages {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ao-stage {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 11px;
}
.ao-stage-bar {
  position: relative;
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: var(--border-soft, #eceef1);
  overflow: hidden;
}
.ao-stage-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 2px;
  background: var(--accent, #e8722d);
  transition: width 380ms cubic-bezier(0.4, 0, 0.2, 1);
}
.ao-stage.pending .ao-stage-fill {
  background: transparent;
}
.ao-stage.running .ao-stage-fill {
  /* 生长中：加一道流动的高光，表示"还在动" */
  background: linear-gradient(
    90deg,
    rgba(232, 114, 45, 0.5),
    var(--accent, #e8722d),
    rgba(232, 114, 45, 0.5)
  );
  background-size: 200% 100%;
  animation: ao-flow 1.3s linear infinite;
}
@keyframes ao-flow {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}
.ao-foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
}
.ao-elapsed {
  flex: none;
  font-size: 10.5px;
  color: var(--text-dim, #8a8f98);
  font-variant-numeric: tabular-nums;
}
.ao-stage-name {
  width: 28px;
  text-align: left;
  flex: none;
  color: var(--text-dim, #8a8f98);
  flex: none;
}
.ao-stage.done .ao-stage-name,
.ao-stage.running .ao-stage-name {
  color: var(--text, #1f2328);
}

/* ---- 主进度光带 ---- */
.ao-track {
  position: relative;
  height: 22px;
  margin-top: 16px;
  display: flex;
  align-items: center;
}
.ao-track-base {
  position: absolute;
  inset: 50% 0 auto 0;
  height: 2px;
  transform: translateY(-50%);
  border-radius: 1px;
  /* 虚线 = 还没填满的位置 */
  background: repeating-linear-gradient(
    90deg,
    var(--border-soft, #e6e9ed) 0 5px,
    transparent 5px 9px
  );
}
.ao-track-glow {
  position: absolute;
  inset: 50% 0 auto 0;
  height: 2px;
  transform: translateY(-50%);
  border-radius: 1px;
  background: linear-gradient(90deg, rgba(232, 114, 45, 0.15), var(--accent, #e8722d));
  box-shadow: 0 0 10px rgba(232, 114, 45, 0.55);
  transition: width 380ms cubic-bezier(0.4, 0, 0.2, 1);
}
.ao-track-head {
  position: absolute;
  right: -3px;
  top: 50%;
  width: 7px;
  height: 7px;
  margin-top: -3.5px;
  border-radius: 50%;
  background: #fff;
  border: 1.5px solid var(--accent, #e8722d);
  box-shadow: 0 0 0 3px rgba(232, 114, 45, 0.18);
  animation: ao-head 1.4s ease-in-out infinite;
}
@keyframes ao-head {
  0%,
  100% {
    box-shadow: 0 0 0 3px rgba(232, 114, 45, 0.18);
  }
  50% {
    box-shadow: 0 0 0 7px rgba(232, 114, 45, 0);
  }
}

/* ---- 文案 ---- */
.ao-msg {
  /* 间距由 .ao-foot 统一给；这里只管省略号 */
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text, #1f2328);
  /* 高度固定：文案长短变化时卡片不跳 */
  min-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ao-hint {
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--text-dim, #9aa0a8);
}

@media (prefers-reduced-motion: reduce) {
  .ao-dot,
  .ao-stage.running .ao-stage-fill,
  .ao-track-head {
    animation: none;
  }
}
</style>
