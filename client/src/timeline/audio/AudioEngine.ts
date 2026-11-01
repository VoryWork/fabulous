/**
 * AudioEngine —— 播放引擎抽象。
 *
 * ## 为什么先做抽象
 *
 * PRD 要求音频必须走 Rust 后端（ASIO/WASAPI 才能做到采样级精确定位）。
 * 但 M2 还没开工，前端现在就要能"打通播放"验证交互。
 *
 * 所以定义统一接口，两个实现：
 *   - `WebAudioEngine`  用 HTMLAudioElement（临时，精度受浏览器限制）
 *   - `SilentEngine`    没有音频文件时静音推进（播放头照常走，便于验证时间轴）
 *
 * M2 之后加 `TauriAudioEngine`（调 Rust 的 playTick），**上层代码不用改**。
 *
 * ## 时间语义
 *
 * 引擎只关心**秒**。Tick ⇄ 秒的换算由调用方用 TempoMap 做
 * （因为变速时"1 秒前进多少 tick"是变化的，引擎不该知道拍号）。
 */

export type EngineKind = 'web-audio' | 'silent' | 'tauri';

export interface AudioEngine {
  readonly kind: EngineKind;

  /** 加载音频；silent 模式下忽略 */
  load(src: string | null): Promise<void>;

  play(): Promise<void>;
  pause(): void;

  /** 定位到某个秒 */
  seek(sec: number): void;

  /** 当前播放位置（秒） */
  currentTime(): number;

  /** 音频总时长（秒）；silent 模式下是外部传入的时长 */
  duration(): number;

  isPlaying(): boolean;

  /**
   * 设置循环区间（秒）。`b === null` 表示不循环。
   *
   * PRD §6 B06「反向试听」需要这个：默认播放"前一小节 + 目标区间 + 后一小节"。
   */
  setLoop(a: number | null, b: number | null): void;

  /** 每次播放位置变化时回调（帧级） */
  onTimeUpdate(cb: (sec: number) => void): void;

  /** 播放到结尾时回调 */
  onEnded(cb: () => void): void;

  /** 播放状态变化时回调 */
  onPlayStateChange(cb: (playing: boolean) => void): void;

  dispose(): void;
}

/**
 * WebAudioEngine —— 基于 HTMLAudioElement。
 *
 * 能达到的精度：约 20–50ms（受浏览器解码/调度影响）。
 * 够做"粗听 + 定位"，但**不够**做 PRD A12 要求的采样级 A/B 对比。
 * 所以它只是 M2 之前的过渡实现。
 */
export class WebAudioEngine implements AudioEngine {
  readonly kind: EngineKind = 'web-audio';

  private el: HTMLAudioElement;
  private raf = 0;
  private loopA: number | null = null;
  private loopB: number | null = null;
  private timeCb: ((sec: number) => void) | null = null;
  private endedCb: (() => void) | null = null;
  private playStateCb: ((playing: boolean) => void) | null = null;
  private disposed = false;

  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.addEventListener('ended', this.handleEnded);
    this.el.addEventListener('play', this.handlePlay);
    this.el.addEventListener('pause', this.handlePause);
  }

  private handleEnded = () => {
    if (this.loopA != null && this.loopB != null) {
      this.el.currentTime = this.loopA;
      void this.el.play();
      return;
    }
    this.endedCb?.();
  };

  private handlePlay = () => {
    this.playStateCb?.(true);
    this.startTicker();
  };

  private handlePause = () => {
    this.playStateCb?.(false);
    this.stopTicker();
  };

  private startTicker() {
    if (this.raf) return;
    const tick = () => {
      if (this.disposed) return;
      const t = this.el.currentTime;

      // 循环检查（比 ended 事件更及时，能处理不精确的区间边界）
      if (this.loopA != null && this.loopB != null && t >= this.loopB) {
        this.el.currentTime = this.loopA;
      }

      this.timeCb?.(this.el.currentTime);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopTicker() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    // 暂停时也推一次最终位置
    this.timeCb?.(this.el.currentTime);
  }

  async load(src: string | null): Promise<void> {
    if (!src) {
      this.el.removeAttribute('src');
      this.el.load();
      return;
    }
    this.el.src = src;
    await new Promise<void>((resolve, reject) => {
      const onCanPlay = () => {
        this.el.removeEventListener('canplay', onCanPlay);
        this.el.removeEventListener('error', onErr);
        resolve();
      };
      const onErr = () => {
        this.el.removeEventListener('canplay', onCanPlay);
        this.el.removeEventListener('error', onErr);
        reject(new Error(`无法加载音频：${src}`));
      };
      this.el.addEventListener('canplay', onCanPlay);
      this.el.addEventListener('error', onErr);
      this.el.load();
    });
  }

  async play(): Promise<void> {
    await this.el.play();
  }

  pause(): void {
    this.el.pause();
  }

  seek(sec: number): void {
    this.el.currentTime = Math.max(0, Math.min(sec, this.duration() || sec));
    this.timeCb?.(this.el.currentTime);
  }

  currentTime(): number {
    return this.el.currentTime;
  }

  duration(): number {
    const d = this.el.duration;
    return Number.isFinite(d) ? d : 0;
  }

  isPlaying(): boolean {
    return !this.el.paused && !this.el.ended;
  }

  setLoop(a: number | null, b: number | null): void {
    this.loopA = a;
    this.loopB = b;
  }

  onTimeUpdate(cb: (sec: number) => void): void {
    this.timeCb = cb;
  }
  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }
  onPlayStateChange(cb: (playing: boolean) => void): void {
    this.playStateCb = cb;
  }

  dispose(): void {
    this.disposed = true;
    this.stopTicker();
    this.el.pause();
    this.el.removeEventListener('ended', this.handleEnded);
    this.el.removeEventListener('play', this.handlePlay);
    this.el.removeEventListener('pause', this.handlePause);
    this.el.removeAttribute('src');
    this.el.load();
  }
}

/**
 * SilentEngine —— 静音推进引擎。
 *
 * 用途：没有音频文件时也能验证播放头、循环、缩放跟随。
 * 它用 `requestAnimationFrame` + 真实时间差推进，按 TempoMap 换算 tick。
 *
 * **这不是玩具**：M2 之前它就是默认引擎，因为假数据阶段没有音频；
 * 而且它是"未来 Rust 引擎"的对照基准 —— 两者应给出相同的播放头轨迹。
 */
export class SilentEngine implements AudioEngine {
  readonly kind: EngineKind = 'silent';

  private posSec = 0;
  private totalSec: number;
  private playing = false;
  private raf = 0;
  private lastTs = 0;
  private loopA: number | null = null;
  private loopB: number | null = null;
  private timeCb: ((sec: number) => void) | null = null;
  private endedCb: (() => void) | null = null;
  private playStateCb: ((playing: boolean) => void) | null = null;

  constructor(durationSec: number) {
    this.totalSec = durationSec;
  }

  setDuration(d: number) {
    this.totalSec = d;
  }

  async load(): Promise<void> {
    /* 无音频，忽略 */
  }

  async play(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    this.playStateCb?.(true);
    this.lastTs = performance.now();
    const tick = (ts: number) => {
      if (!this.playing) return;
      const dt = (ts - this.lastTs) / 1000;
      this.lastTs = ts;
      this.posSec += dt;

      if (this.loopA != null && this.loopB != null && this.posSec >= this.loopB) {
        this.posSec = this.loopA;
      } else if (this.posSec >= this.totalSec) {
        this.posSec = this.totalSec;
        this.playing = false;
        this.playStateCb?.(false);
        this.timeCb?.(this.posSec);
        this.endedCb?.();
        return;
      }

      this.timeCb?.(this.posSec);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.playStateCb?.(false);
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.timeCb?.(this.posSec);
  }

  seek(sec: number): void {
    this.posSec = Math.max(0, Math.min(sec, this.totalSec));
    this.lastTs = performance.now();
    this.timeCb?.(this.posSec);
  }

  currentTime(): number {
    return this.posSec;
  }

  duration(): number {
    return this.totalSec;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  setLoop(a: number | null, b: number | null): void {
    this.loopA = a;
    this.loopB = b;
  }

  onTimeUpdate(cb: (sec: number) => void): void {
    this.timeCb = cb;
  }
  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }
  onPlayStateChange(cb: (playing: boolean) => void): void {
    this.playStateCb = cb;
  }

  dispose(): void {
    this.pause();
    this.timeCb = null;
    this.endedCb = null;
    this.playStateCb = null;
  }
}
