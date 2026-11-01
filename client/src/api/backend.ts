/**
 * 后端调用封装 —— 与 Rust 命令一一对应。
 *
 * 所有 invoke 都集中在这里，好处：
 *   1. 前端其他地方不直接依赖 `@tauri-apps/api`
 *   2. 浏览器里跑（`bun run dev` 无 Tauri）时可以整体降级到 mock
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** 歌单条目 */
export interface SongListItem {
  id: string;
  title: string;
  artist: string;
  audio_path: string;
  duration_sec: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'missing_audio';
  error: string | null;
  created_at: string;
  audio_alive: boolean;
}

/** 音频指纹（重连 dialog 展示用） */
export interface AudioFingerprint {
  duration_sec: number;
  sample_rate: number;
  channels: number;
  headtail_sha1: string;
  file_size: number;
}

/** 重连评估结果 */
export interface ReconnectVerdict {
  accepted: boolean;
  duration_delta_sec: number;
  duration_ok: boolean;
  hash_ok: boolean;
  expected: AudioFingerprint;
  actual: AudioFingerprint;
}

export interface AnalysisProgressEvent {
  id: string;
  stage: string;
  pct: number;
  message: string;
}

/** 是否运行在 Tauri 里（浏览器里没有 window.__TAURI_INTERNALS__） */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ---------------------------------------------------------------- 命令

export async function importAudio(path: string): Promise<SongListItem> {
  return invoke<SongListItem>('import_audio', { path });
}

export async function analyzeSong(id: string): Promise<void> {
  return invoke<void>('analyze_song', { id });
}

export async function listSongs(): Promise<SongListItem[]> {
  return invoke<SongListItem[]>('list_songs');
}

export async function loadAnalysis(id: string): Promise<string | null> {
  return invoke<string | null>('load_analysis', { id });
}

/**
 * 用户编辑层（调性覆盖 / 额外级数轨）的持久化。
 *
 * ## 为什么不并进 analysis.json
 *
 * analysis.json 是**模型产物**，重新分析时会被整份覆盖。用户的判断
 * （「这首歌是 F# 小调」「再加一条 A 大调对照轨」）必须活得比分析结果长，
 * 所以单独存 `analyses.edits_json`，磁盘上另有一份
 * `songs/<id>/edits.json` 作为可移植副本。
 *
 * 结构上和 analysis.json 并列 —— 一首歌的所有信息都在 `songs/<id>/` 下。
 */
export interface SongEdits {
  /** 手动指定的调性；null / 缺省 = 走自动推断 */
  key?: { tonic: string; mode: 'major' | 'minor' };
  /** 追加的级数轨（按另一个调性解释同一批和弦） */
  degreeTracks?: { id: string; tonic: string; mode: 'major' | 'minor' }[];
  /**
   * 用户对和弦轨的编辑结果（改名 / 拖动 / 删除 / 新增）。
   *
   * ## 为什么存整份快照，而不是 diff
   *
   * 和弦块可以被拖动、拉伸、删除、新建，用 diff 要记四种操作，
   * 恢复时还要按顺序重放 —— 一旦中间某步对不上就整条轨乱掉。
   * 直接存「用户视角的最终结果」最稳，体积也可忽略（一首歌 200 块 ≈ 20KB）。
   *
   * ## `basedOn` 的作用
   *
   * 重新分析后模型产出的和弦全变了，旧编辑必须**自动失效**，否则会出现
   * 「编辑过的和弦盖在全新分析结果上」，看起来像数据错乱。
   * 这里存分析的指纹，加载时对不上就丢弃。
   */
  chordEdit?: {
    basedOn: string;
    clips: {
      id: string;
      startTick: number;
      endTick: number;
      label: string;
      state?: string;
    }[];
  };
  /**
   * 用户编辑过的**歌曲结构**（段落划分 + 每段调性）。
   *
   * ## 为什么不绑 `basedOn` 指纹（和 `chordEdit` 不一样）
   *
   * 和弦是模型产物，重新分析后新结果通常更可信，所以旧编辑该失效。
   * 结构是**人工判断** —— 用户亲手划的段落和标的调性，不该因为
   * 重跑一次模型就被覆盖掉。模型给的 sections 只在没有用户编辑时使用。
   *
   * 想回到模型结果时，菜单里有「恢复为 AI 结构」。
   */
  sections?: {
    clips: {
      id: string;
      startTick: number;
      endTick: number;
      /** 字典里的标准名（见 SectionLabels.ts） */
      label: string;
      /** 这段的调性（可选，只作标注提示，不参与级数计算） */
      key?: { tonic: string; mode: 'major' | 'minor' };
    }[];
  };
}

export async function saveEdits(id: string, edits: SongEdits): Promise<void> {
  return invoke<void>('save_edits', { id, edits: JSON.stringify(edits) });
}

export async function loadEdits(id: string): Promise<SongEdits | null> {
  const raw = await invoke<string | null>('load_edits', { id });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SongEdits;
  } catch {
    // 损坏的 edits 不该让整首歌打不开 —— 当没有编辑层处理
    return null;
  }
}

export async function deleteSong(id: string): Promise<void> {
  return invoke<void>('delete_song', { id });
}

export async function scanMissingAudio(): Promise<string[]> {
  return invoke<string[]>('scan_missing_audio');
}

export async function getFingerprint(id: string): Promise<AudioFingerprint> {
  return invoke<AudioFingerprint>('get_fingerprint', { id });
}

export async function evaluateReconnectCandidate(
  id: string,
  candidatePath: string,
): Promise<ReconnectVerdict> {
  return invoke<ReconnectVerdict>('evaluate_reconnect_candidate', {
    id,
    candidatePath,
  });
}

export async function confirmReconnect(id: string, candidatePath: string): Promise<void> {
  return invoke<void>('confirm_reconnect', { id, candidatePath });
}

/**
 * 取某首歌的音频绝对路径（`null` = 文件已不存在）。
 *
 * 前端不直接用曲库列表里的 `audio_path`：那个值在列表刷新前可能是旧的
 * （用户重连换过路径）。以后端为唯一真值。
 */
export async function songAudioPath(id: string): Promise<string | null> {
  return invoke<string | null>('song_audio_path', { id });
}

// ---------------------------------------------------------------- 事件

export function onAnalysisProgress(
  cb: (e: AnalysisProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<AnalysisProgressEvent>('analysis:progress', (ev) => cb(ev.payload));
}

/**
 * 阶段性结果（拍点出来了、和弦出来了……）。
 *
 * 分析分三阶段，每阶段结束推一份"目前拿到的全部内容"，
 * 前端可以边分析边把它画出来，而不是等全部分析完才刷新。
 */
export function onAnalysisPartial(
  cb: (id: string, stage: string, json: string) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; stage: string; json: string }>(
    'analysis:partial',
    (ev) => cb(ev.payload.id, ev.payload.stage, ev.payload.json),
  );
}

export function onAnalysisDone(cb: (id: string) => void): Promise<UnlistenFn> {
  return listen<{ id: string }>('analysis:done', (ev) => cb(ev.payload.id));
}

export function onAnalysisFailed(
  cb: (id: string, error: string) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; error: string }>('analysis:failed', (ev) =>
    cb(ev.payload.id, ev.payload.error),
  );
}
