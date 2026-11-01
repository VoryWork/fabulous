/**
 * usePlayback —— 播放控制器。
 *
 * 把「音频引擎 + TempoMap + 播放头 + 循环选区」串起来。
 *
 * ## 职责边界
 *
 *   引擎        只关心**秒**（不知道拍号）
 *   本模块      用 TempoMap 做 秒 ⇄ Tick 换算，维护播放状态
 *   组件        只渲染 `playheadTick`，不碰时间换算
 *
 * ## 为什么 Tick 换算必须在这里
 *
 * 变速歌曲里"1 秒前进多少 tick"是变化的。如果引擎或组件自己算，
 * 遇到变速段落播放头就会和音频脱节。
 * 统一用 `secToTick(tempoMap, sec)` 换算，变速自动正确。
 *
 * ## 循环选区
 *
 * PRD §6 B06「反向试听」要求点击案例时播放"前一小节 + 目标区间 + 后一小节"。
 * 所以循环区间以 **tick** 表达，这里换算成秒交给引擎。
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import { secToTick, tickToSec, type TempoMapData } from '../domain/TempoMap';
import { PPQ } from '../domain/Tick';
import type { AudioEngine } from '../audio/AudioEngine';

export interface UsePlaybackOptions {
  engine: Ref<AudioEngine>;
  tempoMap: Ref<TempoMapData>;
  /** 内容总 tick（用于 clamp） */
  totalTicks: Ref<number>;
}

export function usePlayback(opt: UsePlaybackOptions) {
  /** 播放头位置（秒）—— 引擎的权威值 */
  const playheadSec = ref(0);
  /** 是否正在播放 */
  const playing = ref(false);
  /** 循环区间（tick）；null 表示不循环 */
  const loopStartTick = ref<number | null>(null);
  const loopEndTick = ref<number | null>(null);
  /** 最近一次错误（音频加载失败等） */
  const error = shallowRef<string | null>(null);

  /** 播放头对应的 tick —— 用 TempoMap 换算，变速也正确 */
  const playheadTick = computed(() => {
    const t = opt.tempoMap.value;
    return Math.max(0, Math.min(opt.totalTicks.value, secToTick(t, playheadSec.value)));
  });

  // ---------------------------------------------------------------- 绑定引擎回调

  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    const e = opt.engine.value;
    e.onTimeUpdate((sec) => {
      playheadSec.value = sec;
    });
    e.onPlayStateChange((p) => {
      playing.value = p;
    });
    e.onEnded(() => {
      playing.value = false;
      // 播到结尾回到开头（不自动循环）
      playheadSec.value = 0;
      e.seek(0);
    });
  }

  // 引擎实例变化时重新绑定（例如从 silent 切到 web-audio）
  watch(
    () => opt.engine.value,
    () => {
      bound = false;
      bind();
    },
    { immediate: true },
  );

  // ---------------------------------------------------------------- 播放控制

  async function play() {
    try {
      error.value = null;
      await opt.engine.value.play();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      playing.value = false;
    }
  }

  function pause() {
    opt.engine.value.pause();
  }

  function toggle() {
    if (playing.value) pause();
    else void play();
  }

  /** 定位到某个秒 */
  function seekSec(sec: number) {
    const max = opt.engine.value.duration() || Number.POSITIVE_INFINITY;
    const clamped = Math.max(0, Math.min(sec, max));
    opt.engine.value.seek(clamped);
    playheadSec.value = clamped;
  }

  /** 定位到某个 tick */
  function seekTick(tick: number) {
    seekSec(tickToSec(opt.tempoMap.value, Math.max(0, tick)));
  }

  /** 相对跳转（秒），用于左右箭头 */
  function nudgeSec(delta: number) {
    seekSec(playheadSec.value + delta);
  }

  // ---------------------------------------------------------------- 循环选区

  /** 设置循环区间（tick）。传 null 取消。 */
  function setLoopTicks(startTick: number | null, endTick: number | null) {
    if (startTick == null || endTick == null || endTick <= startTick) {
      loopStartTick.value = null;
      loopEndTick.value = null;
      opt.engine.value.setLoop(null, null);
      return;
    }
    loopStartTick.value = startTick;
    loopEndTick.value = endTick;
    const t = opt.tempoMap.value;
    opt.engine.value.setLoop(tickToSec(t, startTick), tickToSec(t, endTick));

    // 若当前播放头在循环区外，跳到起点
    if (playheadTick.value < startTick || playheadTick.value > endTick) {
      seekTick(startTick);
    }
  }

  function clearLoop() {
    setLoopTicks(null, null);
  }

  /**
   * 反向试听：播放"目标区间 + 前后各一小节"。
   *
   * PRD §6 B06 要求默认前后各一小节。这是最常用的回听模式。
   */
  function previewRange(targetStartTick: number, targetEndTick: number, padBars = 1) {
    const pad = padBars * 4 * PPQ;
    setLoopTicks(
      Math.max(0, targetStartTick - pad),
      Math.min(opt.totalTicks.value, targetEndTick + pad),
    );
    seekTick(Math.max(0, targetStartTick - pad));
    void play();
  }

  /** 是否处于循环状态 */
  const hasLoop = computed(
    () => loopStartTick.value != null && loopEndTick.value != null,
  );

  return {
    // 状态
    playheadSec,
    playheadTick,
    playing,
    loopStartTick,
    loopEndTick,
    hasLoop,
    error,
    // 控制
    play,
    pause,
    toggle,
    seekSec,
    seekTick,
    nudgeSec,
    setLoopTicks,
    clearLoop,
    previewRange,
  };
}
