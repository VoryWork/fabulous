/**
 * useLibrary —— 曲库状态与自动分析流程。
 *
 * ## 自动分析流程
 *
 * ```
 * addSongs()          选文件 → importAudio（读指纹、建记录）
 *                       → 立刻 analyzeSong（自动开始）
 *                       → 进度事件驱动 progress map
 *                       → 完成后加载 analysis 并切换当前曲目
 * ```
 *
 * ## 为什么"导入即分析"
 *
 * 用户对这首歌的第一个期望就是"看到和弦和结构"，不需要再点一次。
 * 分析在后台跑（Rust 子进程），UI 不阻塞。
 *
 * ## 浏览器降级
 *
 * `bun run dev`（无 Tauri）时后端不可用，这里整体降级到
 * 「加载打包好的 analysis.json」，让 UI 仍可调试。
 */

import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import { open } from '@tauri-apps/plugin-dialog';
import analysisJson from '../timeline/demo/analysis.json';
import {
  analyzeSong,
  deleteSong,
  importAudio,
  isTauri,
  listSongs,
  loadAnalysis,
  songAudioPath,
  onAnalysisDone,
  onAnalysisFailed,
  onAnalysisPartial,
  onAnalysisProgress,
  scanMissingAudio,
  type SongListItem,
} from '../api/backend';

export type ProgressMap = Record<string, { stage: string; pct: number; message: string }>;

const AUDIO_EXTENSIONS = ['flac', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'wma'];

export function useLibrary() {
  const songs = ref<SongListItem[]>([]);
  const currentId = ref<string | null>(null);
  /** 当前曲目的分析 JSON（字符串） */
  const currentAnalysis = shallowRef<string | null>(null);
  /**
   * 当前曲目的音频绝对路径。
   *
   * 单独存一份，而不是让上层去 `songs` 里翻 —— 这样切歌时它和
   * `currentAnalysis` 是**同一次 await 的产物**，不会出现
   * 「谱面已换、音频还没换」的中间态。
   */
  const currentAudioPath = shallowRef<string | null>(null);
  /**
   * 当前曲目最近一次阶段性结果来自哪个阶段（beats / chords / structure）。
   *
   * `null` = 没有部分结果（要么还没开始，要么已经拿到完整的）。
   * UI 用它告诉用户「现在看到的是半成品」。
   */
  const partialStage = shallowRef<string | null>(null);
  /** 每首歌的分析进度 */
  const progress = ref<ProgressMap>({});
  /** 需要重连的歌曲（音频路径失效） */
  const missingIds = ref<string[]>([]);
  const error = ref<string | null>(null);
  const busy = ref(false);

  // 浏览器模式：直接用打包的 analysis.json 兜底
  const standalone = !isTauri();
  if (standalone) {
    currentAnalysis.value = JSON.stringify(analysisJson);
  }

  const unlisteners: Array<() => void> = [];

  async function init() {
    if (standalone) return;
    try {
      songs.value = await listSongs();
      // 启动时检查音频路径
      const missing = await scanMissingAudio();
      missingIds.value = missing;
      if (missing.length) {
        songs.value = await listSongs();
      }
      // 默认选中第一首已完成的
      const first = songs.value.find((s) => s.status === 'done') ?? songs.value[0];
      if (first) await select(first.id);
    } catch (e) {
      error.value = fmtErr(e);
    }

    // 订阅分析事件
    unlisteners.push(
      await onAnalysisProgress((ev) => {
        progress.value = {
          ...progress.value,
          [ev.id]: { stage: ev.stage, pct: ev.pct, message: ev.message },
        };
      }),
      await onAnalysisDone(async (id) => {
        progress.value = { ...progress.value };
        delete progress.value[id];
        // 完整结果要来了，不再是"半成品"
        if (currentId.value === id) partialStage.value = null;
        await refresh();
        // 如果完成的正是当前曲目，重新加载分析
        if (currentId.value === id) await select(id);
      }),
      /**
       * 阶段性结果：**只更新正在看的这首歌**。
       *
       * 判断 `currentId === id` 很重要 —— 后台可能在分析别的歌，
       * 把它画到当前曲目上就成了"串台"（也正是用户之前报的
       * 「编辑器还是另一首歌」那类问题）。
       */
      await onAnalysisPartial((id, stage, json) => {
        if (currentId.value !== id) return;
        currentAnalysis.value = json;
        partialStage.value = stage;
      }),
      await onAnalysisFailed((id, err) => {
        progress.value = { ...progress.value };
        delete progress.value[id];
        error.value = `分析失败：${err}`;
        void refresh();
      }),
    );
  }

  onBeforeUnmount(() => {
    unlisteners.forEach((fn) => fn());
  });

  async function refresh() {
    if (standalone) return;
    songs.value = await listSongs();
  }

  /** 添加音乐：选文件 → 导入 → 自动分析 */
  async function addSongs() {
    if (standalone) {
      error.value = '浏览器模式不支持导入（需要 Tauri 后端）';
      return;
    }
    error.value = null;
    const picked = await open({
      multiple: true,
      directory: false,
      title: '添加音乐',
      filters: [{ name: '音频文件', extensions: AUDIO_EXTENSIONS }],
    });
    if (!picked) return;

    const paths = Array.isArray(picked) ? picked : [picked];
    busy.value = true;
    try {
      for (const p of paths) {
        const item = await importAudio(p);
        await refresh();
        // 自动开始分析（不等待，后台跑）
        void startAnalysis(item.id);
      }
    } catch (e) {
      error.value = fmtErr(e);
    } finally {
      busy.value = false;
    }
  }

  async function startAnalysis(id: string) {
    if (standalone) return;
    try {
      progress.value = { ...progress.value, [id]: { stage: 'starting', pct: 0, message: '准备分析…' } };
      await analyzeSong(id);
    } catch (e) {
      error.value = fmtErr(e);
      const p = { ...progress.value };
      delete p[id];
      progress.value = p;
    }
  }

  /**
   * 切换当前曲目。
   *
   * **必须同时更新音频地址**：之前只换 `currentAnalysis`，结果切歌后
   * 时间轴换成了新歌的谱面，播放器还挂着上一首的音频（或者干脆是
   * 静音引擎）—— 用户看到的就是「编辑器和音乐不是同一首」。
   *
   * 两件事一起做，任一步失败都不留下「新谱面 + 旧音频」的半截状态：
   *   - 分析 JSON：没分析完时为 null（时间轴显示空态，可接受）
   *   - 音频路径：文件丢了时为 null（引擎回退静音，但谱面仍可编辑）
   */
  async function select(id: string) {
    if (standalone) return;
    currentId.value = id;
    const [json, audio] = await Promise.all([
      loadAnalysis(id),
      // 音频取不到不该阻断谱面加载，所以这里单独兜住
      songAudioPath(id).catch(() => null),
    ]);
    currentAudioPath.value = audio;
    currentAnalysis.value = json;
    partialStage.value = null;
  }

  async function remove(id: string) {
    if (standalone) return;
    await deleteSong(id);
    if (currentId.value === id) {
      currentId.value = null;
      currentAnalysis.value = null;
      currentAudioPath.value = null;
      partialStage.value = null;
    }
    await refresh();
  }

  /** 重连成功后的回调 */
  async function onReconnected(id: string) {
    missingIds.value = missingIds.value.filter((x) => x !== id);
    await refresh();
    // 路径修好后自动重新分析（因为可能换了来源，旧结果要重算）
    await startAnalysis(id);
  }

  const current = computed(() => songs.value.find((s) => s.id === currentId.value) ?? null);

  const analyzingCount = computed(
    () => Object.keys(progress.value).length,
  );

  return {
    // 状态
    songs,
    current,
    currentId,
    currentAnalysis,
    currentAudioPath,
    partialStage,
    progress,
    missingIds,
    error,
    busy,
    standalone,
    analyzingCount,
    // 操作
    init,
    refresh,
    addSongs,
    startAnalysis,
    select,
    remove,
    onReconnected,
  };
}

function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return JSON.stringify(e);
}
