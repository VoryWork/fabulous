<script setup lang="ts">
/**
 * 编辑器首页 —— 假 UI 装配。
 *
 * 布局：
 *   顶部工具栏
 *   ├─ 左侧曲库  │  时间轴（轨名列 + 标尺 + 内容）  │  右侧检查器
 *   底部播放条
 *
 * M1 阶段：时间轴用假数据 + 真实 geometry，播放条用合成波形 + 假计时器。
 * 唯一"真"的东西是：Tick/BeatMap/MeterMap/Geometry 四个 domain 模块。
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import TopToolbar from './components/TopToolbar.vue';
import AnalyzingOverlay from './components/AnalyzingOverlay.vue';
import SongLibrary from './components/SongLibrary.vue';
import TimelineView, { type ChordEditSnapshot, type SectionEditSnapshot } from './components/TimelineView.vue';
import InspectorPanel from './components/InspectorPanel.vue';
import PlayerBar from './components/PlayerBar.vue';
import ResizeHandle from './components/ResizeHandle.vue';
import ReconnectDialog from './components/ReconnectDialog.vue';
import { useLibrary } from './composables/useLibrary';
import { convertFileSrc } from '@tauri-apps/api/core';

import analysisJson from './timeline/demo/analysis.json';
import {
  makeRealTempoMap,
  makeRealMeterMap,
  makeRealTracks,
  totalTicksOf,
  inferKey,
  makeBeatSnapper,
  fixDownbeats,
  makeDegreeTrack,
  type AnalysisFile,
  type RealClip,
  type RealTrack,
  type TempoSegment,
} from './timeline/demo/realData';
import { relatedMinor } from './timeline/domain/ChordNotation';
import { loadEdits, saveEdits, writeTextFile, type SongEdits, type SongListItem } from './api/backend';
import {
  buildFbsongBundle,
  buildLectureMarkdown,
  serializeFbsong,
  suggestFileName,
} from './export/exporters';
import { barAt, tickOfBar } from './timeline/domain/MeterMap';
import { tickToSec, bpmAt, createConstantTempoMap } from './timeline/domain/TempoMap';
import { usePlayback } from './timeline/audio/usePlayback';
import { SilentEngine, WebAudioEngine, type AudioEngine } from './timeline/audio/AudioEngine';

/**
 * 曲库（真实后端）。
 *
 * 浏览器模式下 useLibrary 会降级到打包好的 analysis.json，
 * 所以这里统一从 `library.currentAnalysis` 取数据。
 */
const library = useLibrary();

/** 解析当前曲目的分析结果 */
const analysis = computed<AnalysisFile | null>(() => {
  const raw = library.currentAnalysis.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AnalysisFile;
  } catch {
    return null;
  }
});

/**
 * 空谱面（还没有分析结果时用）。
 *
 * ⚠️ 这里**不能**回退到打包进项目的 `analysis.json`。
 *
 * 以前 `data = analysis ?? analysisJson`，后果是：点一首还没分析完的歌，
 * 时间轴照样画出 Refrain 的结构和和弦 —— 标题也是 Refrain。
 * 用户看到的是「编辑器还是那首默认的歌」，而不是「这首歌还没分析」。
 *
 * 所以空态必须是**真正空的**：没有小节、没有和弦，只剩一个占位时长
 * （用曲库里的 `duration_sec`，这样播放条是这首歌的长度）。
 */
function emptyAnalysis(song: SongListItem | null): AnalysisFile {
  const durationSec = song?.duration_sec || 0;
  return {
    song: {
      title: song?.title || '未命名',
      artist: song?.artist || '',
      durationSec,
    },
    source: { beats: '', chords: '', note: '尚未分析' },
    downbeatsSec: [],
    beatsSec: [],
    chords: {},
    sections: [],
    tempoSegments: [],
    meta: {
      beatsPerBar: 4,
      bpmMedian: 0,
      barSecMedian: 0,
      beatCount: 0,
      barCount: 0,
    },
  };
}

/**
 * 实际使用的数据 = 当前曲目的分析结果，没结果时用**空谱面**。
 *
 * 浏览器模式（无后端）例外：那时没有任何真实曲目，
 * 保持加载打包的示例数据，方便调试 UI。
 */
function pickRaw(): AnalysisFile {
  if (analysis.value) return analysis.value;
  // 浏览器模式下 `songs` 永远是空的（没有后端），示例数据是唯一能看的东西
  if (library.standalone) return analysisJson as unknown as AnalysisFile;
  // 有后端但当前歌还没分析完 → 真·空谱面
  return emptyAnalysis(library.current.value);
}

const data = computed<AnalysisFile>(() => {
  const raw = pickRaw();
  /**
   * 统一修正小节边界（倍速/半速检出）。
   *
   * 放在**这里**而不是各使用点：小节线用 downbeatsSec、和弦换算用
   * downbeatsSec、结构段换算还用 downbeatsSec —— 在入口修一次，
   * 下游不可能漏掉某一处（漏一处就是两套网格打架，非常难查）。
   *
   * 后端 analyze_song.py 已经会在分析时修好并写进 analysis.json，
   * 这里是给**磁盘上的旧产物**兜底（旧文件不会自动重算）。
   */
  if (!raw.downbeatsSec || raw.downbeatsSec.length < 3) return raw;
  /**
   * ⚠️ **不要在这里补开头虚拟小节**（做错过一次，已撤销）。
   *
   * 曾经加过 `padLeadingBar`：当第一个 downbeat 离 0 较远时，
   * 在它前面塞一个「虚拟小节起点」。目的是让前奏也落在网格里。
   *
   * 但「拍是一个**时刻**，不是一段区间」。凭空塞一个时刻进去，
   * 等于把所有后续拍的时刻**序号整体推后一位** ——
   * 用户看到的就是「第一条竖线不是第一拍」，即整体偏 1 拍。
   *
   * 更根本的问题：那个虚拟起点不是模型检出的拍，它不代表任何
   * 真实击打。为了「谱面别空着」而伪造一个拍，是拿正确性换观感。
   *
   * 前奏该空着就空着 —— 第一个真实拍就是第 1 拍。
   */
  const fixed = fixDownbeats(raw.downbeatsSec);
  // 没变化就返回原对象，避免下游 computed 全部失效重算
  const same = fixed.every((v, i) => v === raw.downbeatsSec[i]);
  return same ? raw : { ...raw, downbeatsSec: fixed };
});


const tempoSegments = ref<TempoSegment[]>([]);

/**
 * 切歌时重置速度段（曲目数据变 → 速度轨迹必须跟着变）。
 *
 * 两个坑：
 *   1. 原来 `if (!raw) return;` —— 切到一首**还没分析完**的歌时直接返回，
 *      于是速度轨上还挂着上一首的 BPM，和空谱面完全不匹配。
 *      现在 null 也处理：清空。
 *   2. 监听的是 `currentAnalysis` 而不是 `data`：因为 `data` 在浏览器模式下
 *      走的是示例数据分支，两者会打架。示例数据在下面单独兜一次。
 */
watch(
  () => library.currentAnalysis.value,
  (raw) => {
    if (!raw) {
      // 还没分析完：清空，让速度轨显示空白而不是残留值
      tempoSegments.value = [];
      return;
    }
    try {
      const a = JSON.parse(raw) as AnalysisFile;
      /**
       * 速度段的 `bar` 索引必须和**谱面**用同一套小节编号。
       *
       * `data` 在入口只做了 `fixDownbeats`（挪异常小节的**边界**，不改数量），
       * 数量本身不变，这里用同一个函数算一遍只是为了确保两边一致。
       * 若直接用 raw 的 `downbeatsSec.length`，速度段可能比谱面少一节。
       */
      const barCount = fixDownbeats(a.downbeatsSec).length;
      const shift = Math.max(0, barCount - a.downbeatsSec.length);
      tempoSegments.value =
        a.tempoSegments && a.tempoSegments.length > 0
          ? a.tempoSegments.map((s, i) => ({
              ...s,
              // 第一段必须从 bar 0 开始：`createTempoMap` 要求首个锚点 tick = 0
              startBar: i === 0 ? 0 : s.startBar + shift,
              endBar: s.endBar + shift,
            }))
          : [
              {
                startBar: 0,
                endBar: barCount,
                bpm: a.meta.bpmMedian,
              },
            ];
    } catch {
      tempoSegments.value = [];
    }
  },
  { immediate: true },
);

/**
 * 用户编辑层：所有「不是模型产物」的歌曲信息（调性覆盖、追加级数轨）。
 *
 * ## 统一放在一个对象里
 *
 * 踩过的坑：这两个功能最初各写一个 ref，结果
 *   1. 都是全局的（切歌串成一片）
 *   2. 都没有持久化（重启就丢）
 *   3. 两套并行状态各自管读写，删歌要清两处，漏一处就是脏数据
 *
 * 现在统一成 `Record<songId, SongEdits>`：
 *   - 按歌曲 id 隔离（切歌不串）
 *   - 落盘到 `analyses.edits_json` + `songs/<id>/edits.json`
 *     （和 analysis.json 并列，一首歌的所有信息在同一个目录里）
 *
 * ## 为什么不并进 analysis.json
 *
 * 那是模型产物，重新分析会整份覆盖。用户的判断必须活得比分析结果长。
 *
 * ## ⚠️ 必须定义在下面那个加载 watch 之前
 *
 * 那个 watch 带 `immediate: true`，setup 期间就会执行并读 `songEdits`。
 * `const` 有暂时性死区，声明在后面会直接抛 ReferenceError，整页白屏 ——
 * 而且 typecheck 和单测都发现不了。
 */
const songEdits = ref<Record<string, SongEdits>>({});

/**
 * 这首歌的编辑层是否已经从磁盘加载完。
 *
 * ## 为什么需要这个标记
 *
 * 切歌时 `editKey` 立刻变（songId 变了），但编辑层是**异步**读盘的。
 * 如果时间轴这时就重建，拿到的是「未含落盘编辑」的 tracks，
 * 于是：编辑层初始化成原始数据 → emit → 被判定为「没改」→ 清掉 chordEdit
 * → **用户的编辑被自己覆盖没了**。
 *
 * 所以 load 完成后要再变一次 key，触发第二次（也是最终一次）重建。
 */
const editsReady = ref<Record<string, boolean>>({});

/** 当前歌曲的编辑层（没有则为空对象） */
const currentEdits = computed<SongEdits>(() => {
  const id = library.currentId.value;
  return (id && songEdits.value[id]) || {};
});

/**
 * 落盘策略：**惰性 + 内容去重 + 关键时机强制刷**。
 *
 * ## 为什么不能每次改都写
 *
 * 一次 `save_edits` 要写**两处**（`analyses.edits_json` 和
 * `songs/<id>/edits.json`），每次是整份快照（200 个和弦 ≈ 20KB）。
 * 原来防抖只有 250ms，拖动一个和弦就会每 250ms 写一次盘 ——
 * 用户提的「不要频繁消耗磁盘寿命」就是这个。
 *
 * 现在三道闸：
 *   1. **手势期间根本不报**（见 TimelineView 的 chord-edits-change），
 *      松手才报一次 —— 这是最大的一笔
 *   2. 防抖 1.2s：连续改（连点徽章、连续输入）合成一次
 *   3. **内容去重**：和上次落盘的 JSON 完全一样就不写
 *
 * ## 惰性不等于丢数据
 *
 * 下面这些时机强制刷盘，所以最坏情况只丢「最后一次操作」：
 *   - 切歌（离开前刷上一首）
 *   - 窗口隐藏 / 关闭
 */
const WRITE_DEBOUNCE_MS = 1200;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: { id: string; edits: SongEdits } | null = null;
const lastWritten = new Map<string, string>();

/** 立即把待写内容落盘（去重后真正写） */
function flushPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const job = pendingSave;
  pendingSave = null;
  if (!job) return;
  const json = JSON.stringify(job.edits);
  if (lastWritten.get(job.id) === json) return;
  lastWritten.set(job.id, json);
  void saveEdits(job.id, job.edits).catch(() => {
    /* 写盘失败不该打断编辑：内存里已经生效，下次改动会再试 */
    lastWritten.delete(job.id);
  });
}

/**
 * 写当前歌曲的编辑层（局部合并 + 惰性落盘）。
 *
 * 用**局部合并**而不是整体替换：调用方只关心自己改的那个字段，
 * 不该被要求把整个对象传全（漏一个字段就把它清掉了）。
 */
function patchCurrentEdits(patch: Partial<SongEdits>) {
  const id = library.currentId.value;
  if (!id) return;
  const next = { ...(songEdits.value[id] || {}), ...patch };
  songEdits.value = { ...songEdits.value, [id]: next };

  pendingSave = { id, edits: next };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushPendingSave();
  }, WRITE_DEBOUNCE_MS);
}

/**
 * 切歌时加载这首歌的编辑层（调性覆盖 / 追加级数轨）。
 *
 * 和 `tempoSegments` 那个 watch 分开：那个读的是 `analysis.json`（模型产物），
 * 这个读的是 `edits.json`（用户判断）。两者来源不同、生命周期也不同 ——
 * 重新分析只换前者，后者必须保留。
 *
 * 已经在内存里的不再读盘：`songEdits[id]` 有值时说明这次会话里改过，
 * 内存是更新的（落盘有 250ms 防抖，可能还没写进去）。
 */
/**
 * 切歌前先把上一首的待写内容刷盘。
 *
 * 落盘是惰性的（1.2s 防抖），不在这里刷就会丢：
 * `pendingSave` 只记住最后一次，切歌后再写的就是新歌了。
 */
watch(() => library.currentId.value, () => flushPendingSave(), { flush: 'pre' });

/**
 * 窗口隐藏 / 关闭时刷盘。
 *
 * Tauri 里关窗口不一定会走 `beforeunload`，但 `visibilitychange` 是可靠的
 * （最小化、切到别的窗口都会触发）。两个都挂上，尽量不漏。
 */
function onHide() {
  if (document.visibilityState === 'hidden') flushPendingSave();
}
window.addEventListener('visibilitychange', onHide);
window.addEventListener('beforeunload', flushPendingSave);
onBeforeUnmount(() => {
  flushPendingSave();
  window.removeEventListener('visibilitychange', onHide);
  window.removeEventListener('beforeunload', flushPendingSave);
});

watch(
  () => library.currentId.value,
  async (id) => {
    if (!id || library.standalone) return;
    if (songEdits.value[id]) {
      // 内存里已有（本次会话改过）→ 直接算就绪
      editsReady.value = { ...editsReady.value, [id]: true };
      return;
    }
    try {
      const e = await loadEdits(id);
      // 期间又切走了 → 丢弃，否则会把 A 歌的编辑层写到 B 歌上
      if (library.currentId.value !== id) return;
      if (e) songEdits.value = { ...songEdits.value, [id]: e };
    } catch {
      // 读不到就当没有编辑层，用模型默认值 —— 不该阻断打开歌曲
    }
    // 无论有没有编辑，都要标就绪：时间轴据此做**最终一次**重建
    editsReady.value = { ...editsReady.value, [id]: true };
  },
  { immediate: true },
);

/** 浏览器模式：示例数据的速度段（上面那个 watch 不会触发） */
if (library.standalone) {
  const demo = analysisJson as unknown as AnalysisFile;
  tempoSegments.value =
    demo.tempoSegments ??
    [{ startBar: 0, endBar: demo.downbeatsSec.length, bpm: demo.meta.bpmMedian }];
}


/**
 * 时间换算的权威表。
 *
 * ## 为什么默认用 `makeRealTempoMap`（逐小节真实时长）
 *
 * 原来用的是 `makeTempoMapFromSegments`：**全曲一个平均 BPM 均匀推进**。
 * 但谱面和和弦走的是 `beatsSec`（真实拍点，有 ±2% 抖动）。
 * 两套网格一旦不同源，偏差就会随播放累积 ——
 * 用户看到的就是「有时候对、有时候滞后两拍」这种没规律的表现。
 *
 * `makeRealTempoMap` 把每个小节的**实际时长**换算成该小节的 BPM，
 * 于是 tick ↔ 秒 与 downbeats 严格一致，播放头和谱面永远不会分家。
 *
 * ## 为什么**不再**按「用户改过 BPM」切换成 segments
 *
 * 之前有一个 `tempoEdited` 开关：用户改过速度轨的 BPM 就改用
 * `makeTempoMapFromSegments`（全曲均匀推进）。结果用户发现
 * 「有时候对、有时候滞后」—— 因为只要这个开关被打开，
 * 时间换算就悄悄换成了另一套网格，而这个状态是不可见的。
 *
 * 时间换算必须**只有一个来源**（真实 downbeat 时长），否则
 * 播放头和音频的关系会随一个看不见的开关变化，极难排查。
 * 改 BPM 仍然会更新速度轨的显示，但不再影响 tick ↔ 秒。
 */
const tempoMap = computed(() => {
  /**
   * 兜底：`createTempoMap` 对非法输入抛 RangeError，而 computed 抛错
   * 会让整个页面白屏。哪怕上游已经做了防御，这里再包一层。
   *
   * 白屏是最糟的失败方式 —— 用户看不到任何信息，也没法自己恢复。
   * 退化成「120 BPM 的空白时间轴」至少还能操作。
   */
  try {
    return makeRealTempoMap(data.value);
  } catch (e) {
    console.warn('[tempo] 构建 TempoMap 失败，退回占位值', e);
    return createConstantTempoMap(120, Math.max(1, data.value.song.durationSec || 1), 0);
  }
});

const meterMap = computed(() => makeRealMeterMap());
const totalTicks = computed(() => totalTicksOf(data.value));

/**
 * 空态提示（谱面为空时覆盖在时间轴上）。
 *
 * 三种情况要在文案上区分开，因为用户下一步该做的事完全不同：
 *   - 正在分析  → 什么都不用做，等着，告诉他分析到哪一步了
 *   - 待分析    → 该点「重新分析全曲」
 *   - 分析失败  → 该看错误信息 / 重新分析
 *
 * 返回 null 表示不显示（有内容可画，或浏览器模式的示例数据）。
 */
const emptyHint = computed<{ icon: string; title: string; sub: string } | null>(() => {
  // 浏览器模式永远有示例数据，不需要空态
  if (library.standalone) return null;
  // 已经有内容了（哪怕只是拍点网格）就不挡视线
  if (totalTicks.value > 0) return null;
  if (!library.currentId.value) return null;

  const song = library.current.value;
  const prog = song ? library.progress.value[song.id] : undefined;

  if (prog) {
    return {
      icon: '◌',
      title: `正在分析「${song?.title || '未命名'}」`,
      sub: `${prog.message || '准备中…'}　${Math.round(prog.pct * 100)}%`,
    };
  }
  if (song?.status === 'failed') {
    return {
      icon: '!',
      title: '分析失败',
      sub: song.error || '点右上角「重新分析全曲」重试',
    };
  }
  return {
    icon: '♫',
    title: '这首歌还没有分析结果',
    sub: '点右上角「重新分析全曲」开始分析',
  };
});

/**
 * 秒 → tick 的映射。
 *
 * **用真实拍点，不用 TempoMap**（用户要求："分析的时候先对 bpm，再对和声在哪个拍上"）。
 *
 * 原因：TempoMap 是由 BPM 段派生的，而 BPM 是平均值估计。
 * 用平均值转 153 小节的谱面会累积误差（0.5% × 153 小节 ≈ 半拍漂移）。
 *
 * 用实测拍点则精确：和弦的秒找最近拍 → tick = 拍序号 × 960。
 *
 * 副作用（符合预期）：
 *   用户之后改 BPM 时，和弦的 tick 不变（位置不动），
 *   只有播放走时速度变 —— 于是"和声对不上"是正常的，
 *   因为用户主动修改了速度假设。
 */
const beatSnapper = computed(() =>
  makeBeatSnapper(data.value.beatsSec, data.value.downbeatsSec),
);

function secToTickReal(sec: number): number {
  const v = beatSnapper.value(sec);
  return Math.max(0, Math.min(totalTicks.value, v));
}

/**
 * 分析结果指纹。
 *
 * 用户对和弦的编辑是**按歌曲保存**的，但重新分析后模型产出的和弦全变了。
 * 此时若还把旧编辑盖上去，就会出现「编辑过的和弦压在全新分析结果上」，
 * 看起来像数据错乱。所以要能判断「这份编辑是基于哪次分析」。
 *
 * 用拍数 + 小节数 + 和弦段数 + 时长：重新分析几乎必然改变其中至少一项。
 * 不用时间戳是因为它拿不到（`load_analysis` 只返回 raw_json）。
 */
const analysisKey = computed(() => {
  const a = data.value;
  return [
    a.beatsSec.length,
    a.downbeatsSec.length,
    (a.chords?.submission ?? []).length,
    a.song.durationSec.toFixed(1),
  ].join('-');
});

/**
 * 传给时间轴的「换数据」判据：歌曲 id + 分析指纹。
 *
 * 带上 songId 是因为两首歌的指纹（拍数/段数/时长）可能恰好一样，
 * 那时若只比指纹就会漏掉重建，界面上表现为「切歌后还显示上一首的块」。
 */
const editKey = computed(() => {
  const id = library.currentId.value ?? '';
  // 末尾的 r/x 是「编辑层是否加载完」：切歌时会先 x 后 r，
  // 时间轴因此重建两次 —— 第二次才拿到含落盘编辑的 tracks。
  // ## 编辑层未就绪时，key 必须**不随数据变化**
  //
  // `analysisKey` 依赖 `data`（异步加载），如果把它写进未就绪的 key，
  // 就会出现这个时序灾难：
  //
  //   切歌 → reset（空数据）
  //   data 加载完 → analysisKey 变 → 再 reset（此时 edits 还没回来，
  //                tracks 里没有用户编辑）
  //   → 编辑层被灌成「模型原始结构」→ emit → 判定「没改过」→ 清空已存的编辑
  //   edits 终于加载完 → 已经晚了
  //
  // 所以加载期间给一个**恒定值**，只有 ready 之后才带上真指纹。
  if (!id) return '';
  if (!editsReady.value[id]) return `${id}:pending`;
  return `${id}:${analysisKey.value}:r`;
});

/**
 * 把用户编辑过的和弦块盖回分析结果上。
 *
 * 编辑存的是**整份快照**（见 `SongEdits.chordEdit`），所以这里直接替换
 * 和弦轨的 clips。指纹对不上说明分析重跑过，编辑作废。
 */
function applyChordEdits(base: RealTrack[]): RealTrack[] {
  const ce = currentEdits.value.chordEdit;
  if (!ce || ce.basedOn !== analysisKey.value || !ce.clips.length) return base;
  return base.map((t) =>
    t.kind === 'chord'
      ? {
          ...t,
          clips: ce.clips.map((c) => ({
            id: c.id,
            startTick: c.startTick,
            endTick: c.endTick,
            label: c.label,
            state: (c.state ?? 'draft') as RealClip['state'],
          })),
        }
      : t,
  );
}

/**
 * 把用户编辑过的结构段盖回模型结果上。
 *
 * ## 和 `applyChordEdits` 的区别：**不看分析指纹**
 *
 * 和弦是模型产物，重分析后新结果通常更可信 → 旧编辑该失效。
 * 结构是人工判断（用户亲手划的段、标的调性），不该被重跑模型覆盖。
 * 所以只要有 `sections` 就用它。想回模型结果走「恢复为 AI 结构」。
 */
function applySectionEdits(base: RealTrack[]): RealTrack[] {
  const se = currentEdits.value.sections;
  if (!se?.clips.length) return base;
  return base.map((t) =>
    t.kind === 'section'
      ? {
          ...t,
          clips: se.clips.map((c) => ({
            id: c.id,
            startTick: c.startTick,
            endTick: c.endTick,
            label: c.label,
            key: c.key,
            state: 'draft' as RealClip['state'],
          })),
        }
      : t,
  );
}

/**
 * 模型产出的原始轨道（**不含用户编辑**）。
 *
 * 单独留一份是为了判断「用户到底改了没有」：`onChordEditsChange` 拿它
 * 和编辑层的快照比对，一致就不写盘、也不生成 `chordEdit`。
 * 否则切歌时编辑层重建会顺带把「未编辑的原始数据」当成编辑存下来。
 */
const baseTracks = computed(() =>
  makeRealTracks(data.value, {
    dict: 'submission',
    bySecToTick: secToTickReal,
    /**
     * 导入时吸附到小节线（**1/4 小节 = 1 拍**以内才吸）。
     *
     * ## 为什么是 0.25，不是更大
     *
     * 实测《満ちてゆく》110 个和弦起点的分布是**两极**的：
     *
     *   距小节线 0~0.02  小节 : 60 个  ← 本来就在小节线上
     *   距小节线 0.25~0.38 小节: 31 个  ← 落在「第 2 拍」
     *   距小节线 ≥ 0.5    小节 : 18 个  ← 「第 3 拍」附近
     *
     * 中间（0.02~0.25）**一个都没有** —— 说明和弦边界是**整数拍**，
     * 不是「抖在小节线附近」。所以 0.15 这类小阈值完全不生效（实测 0.08~0.2
     * 结果与 0 相同），到 0.25 才把第 2 拍上的和弦吸到小节线。
     *
     * 再往上（0.5）会到 100%，但那是把「第 3 拍起」的和弦也强行挪到小节线，
     * 会真的改变音乐的听感位置。
     *
     * ## 为什么 minBeats 保持 1
     *
     * 曾经试过 `snapToBar: 0.45 + minBeats: 2`，把 D/F#（5/7）、Esus4 这类
     * **经过和弦**吃掉了 —— 它们只有 1 拍，但音乐上真实存在
     * （对照 Song Master Pro，它的 `5/7` 也只有约 1 拍）。
     *
     * 实测 0.25 + minBeats=1 的效果：块数 109 → **109（一个都没丢）**，
     * 落在小节线的比例 55% → **83%**。两全。
     */
    snapToBar: 0.25,
    minBeats: 1,
  }),
);

/** 最终轨道 = 原始轨道 + 用户落盘的编辑 */
const tracks = computed(() => applySectionEdits(applyChordEdits(baseTracks.value)));


/** 当前歌曲追加的级数轨 */
const extraDegreeTracks = computed(() => currentEdits.value.degreeTracks ?? []);

/** 级数轨 id 序号（只需保证同一首歌内不重） */
let degreeTrackSeq = 0;

/**
 * 和弦轨编辑变化 → 存进这首歌的编辑层。
 *
 * 用户的编辑原本只活在 `useClipEditing` 的内存快照里，切歌就没了。
 * 按「所有可保存的信息都是会话级」这条原则，它必须落盘到
 * `analyses.edits_json` + `songs/<id>/edits.json`。
 *
 * 防抖在 `patchCurrentEdits` 里（250ms）—— 拖动时这里会被调用很多次。
 */
function onChordEditsChange(clips: ChordEditSnapshot[]) {
  if (!library.currentId.value) return;

  /**
   * 和「模型原始产出」一致 → 用户其实没改，不要存。
   *
   * 为什么必须比：编辑层重建（切歌、分析推进）会 emit 一次当前内容，
   * 内容就是原始数据。若照存不误，会写出一份和原始一模一样的
   * `chordEdit`，既浪费又会在下次分析指纹变化时干扰判断。
   */
  const orig = baseTracks.value.find((t) => t.kind === 'chord')?.clips ?? [];
  const same =
    clips.length === orig.length &&
    clips.every((c, i) =>
      c.id === orig[i].id &&
      c.label === orig[i].label &&
      c.startTick === orig[i].startTick &&
      c.endTick === orig[i].endTick,
    );
  if (same) {
    // ## 不要在这里「清空 chordEdit」
    //
    // 原来写的是 `patchCurrentEdits({ chordEdit: undefined })`，想法是
    // 「内容和原始一样 = 用户撤销了所有编辑，顺手清理」。但它有个致命前提：
    // **必须确定编辑层里的内容就是用户真实看到的**。
    //
    // 加载期间编辑层可能被临时灌成模型数据（data 已到、edits 未到），
    // 这时 emit 出来的就是原始内容 → 判定 same → 把**已落盘的编辑删掉**。
    // 用户看到的现象就是「改过的结构，一重启又回来了」。
    //
    // 清理交给显式的「恢复为 AI 结果」入口，自动判定一律不删。
    return;
  }

  patchCurrentEdits({ chordEdit: { basedOn: analysisKey.value, clips } });
}

/**
 * 结构轨编辑变化 → 存进这首歌的编辑层。
 *
 * 比和弦少一道「和原始一样就不存」的检查：结构段的**调性**是新增字段，
 * 模型产出里没有它，所以「有调性」本身就是用户改过的证据。
 * 其余字段照样要比，避免「拖走又拖回原位」时白写一次盘。
 */
function onSectionEditsChange(clips: SectionEditSnapshot[]) {
  if (!library.currentId.value) return;

  const orig = baseTracks.value.find((t) => t.kind === 'section')?.clips ?? [];
  const same =
    clips.length === orig.length &&
    clips.every((c, i) =>
      c.id === orig[i].id &&
      c.label === orig[i].label &&
      c.startTick === orig[i].startTick &&
      c.endTick === orig[i].endTick &&
      !c.key,
    );
  if (same) {
    // 同上：**绝不能自动清空 sections**。加载时序会让编辑层短暂等于模型数据，
    // 那时清空等于把用户划好的段落删了。清空只走「恢复为 AI 结构」。
    return;
  }

  patchCurrentEdits({ sections: { clips } });
}


/** 丢弃用户的结构编辑，回到模型给的结构 */
function onRestoreAiSections() {
  patchCurrentEdits({ sections: undefined });
}
/**
 * 追加一条级数轨。
 *
 * 默认用「关系小调」—— 这是最常见的对照需求（判断这首歌到底是 A 大调
 * 还是 F# 小调），而不是让用户从 24 个组合里再选一次。
 */
function addDegreeTrack() {
  const songId = library.currentId.value;
  const cur = effectiveKey.value;
  if (!songId || !cur.tonic) return;
  const rel = relatedMinor(cur.tonic);
  degreeTrackSeq += 1;
  patchCurrentEdits({
    degreeTracks: [
      ...extraDegreeTracks.value,
      // 轨道 id 带上歌曲前缀：同一个 id 在两首歌里出现会让编辑层串块
      { id: songId + '-deg-' + degreeTrackSeq, tonic: rel, mode: 'minor' },
    ],
  });
}

function removeDegreeTrack(id: string) {
  if (!library.currentId.value) return;
  patchCurrentEdits({
    degreeTracks: extraDegreeTracks.value.filter((t) => t.id !== id),
  });
}

function updateDegreeTrackKey(id: string, k: { tonic: string; mode: 'major' | 'minor' }) {
  if (!library.currentId.value) return;
  patchCurrentEdits({
    degreeTracks: extraDegreeTracks.value.map((t) => (t.id === id ? { ...t, ...k } : t)),
  });
}

/**
 * 全部轨道 = 分析生成的三条 + 用户追加的级数轨。
 *
 * 追加轨用**当前实时和弦块**（`allTracks` 里的和弦轨）当父级，
 * 而不是原始 `data.value` —— 否则用户手动补的和弦不会反映到新轨上。
 */
const allTracks = computed(() => {
  const base = tracks.value;
  if (extraDegreeTracks.value.length === 0) return base;
  const chordTrack = base.find((t) => t.kind === 'chord');
  const chords = chordTrack?.clips ?? [];
  const extra = extraDegreeTracks.value.map((t) =>
    makeDegreeTrack(chords, t.tonic, t.mode, t.id),
  );
  return [...base, ...extra];
});

/**
 * 用户手动指定的调性（覆盖自动推断）。
 *
 * ## 为什么要能覆盖
 *
 * `inferKey` 是统计出来的 —— 按调内功能给每个候选主音打分。它对付常规
 * 流行歌没问题，但遇到下面几种情况会错，而且**用户一眼就能看出来**：
 *
 *   - 转调歌：整首歌只有一个调中心，实际前后换了调
 *   - 关系调歧义：A 大调和 F# 小调配和弦完全重合，光看和弦分不出
 *   - 调式音阶 / 蓝调：大量 bVII、bIII，打分函数会把主音判偏
 *   - 分析刚出来时按半成品算的，和弦补齐后结果会变
 *
 * 覆盖值**不写回 analysis.json**：它是用户的判断，不是分析产物。
 * 将来如果要做持久化，应该单独存一列，而不是污染模型结果。
 *
 * ## 必须按歌曲 id 存，不能是单个值
 *
 * 踩过的坑：最初写成 `ref<... | null>(null)` 一个全局值，结果在某首歌上
 * 手动指定调性后，**切到别的歌也沿用那个调** —— 用户看到另一首歌的调性
 * 被莫名其妙改掉了，而且改回去第一首也跟着变。
 *
 * 测试里也不容易发现：单曲场景永远是对的，只有切换歌曲才暴露。
 */
/** 当前歌曲手动指定的调性（没有则 null = 走自动推断） */
const currentKeyOverride = computed(() => currentEdits.value.key ?? null);

/**
 * 实际生效的调性。
 *
 * 优先用用户指定的，否则用自动推断的。
 * 注意 `inferKey` 在空谱面时返回空串 —— 这时 `tonic` 为空，
 * 下游（级数计算）要能容忍，不能当成 "C 大调" 硬算。
 *
 * ⚠️ 必须定义在 `SONG` **之前**：`SONG` 的 computed 里会读它，
 * 而 computed 首次求值发生在 setup 期间（`SONG.value.dictionary`）。
 * 放在后面会报「Cannot access 'effectiveKey' before initialization」，
 * 而且整页白屏 —— const 有暂时性死区，不是 undefined 而是直接抛错。
 */
const effectiveKey = computed(() => {
  const ov = currentKeyOverride.value;
  if (ov) return ov;
  const k = inferKey(data.value);
  return {
    tonic: k.tonic,
    // 空谱面时 mode 也是空串，统一归一到 major 只为了类型，
    // 真正用的时候都先判 `tonic` 非空
    mode: (k.mode === 'minor' ? 'minor' : 'major') as 'major' | 'minor',
  };
});

/**
 * 自动推断出来的调性（不管用户有没有覆盖）。
 *
 * 弹层里当对照显示：「自动推断：A major / 你手动指定：F# minor」。
 * 只给 UI 用，级数计算一律用 `effectiveKey`。
 */
const autoKeyInfo = computed(() => {
  const k = inferKey(data.value);
  return { tonic: k.tonic, mode: k.mode };
});

function onSetKey(v: { tonic: string; mode: 'major' | 'minor' }) {
  if (!library.currentId.value) return;
  patchCurrentEdits({ key: v });
}

/**
 * 删歌：连同它的编辑层一起清掉。
 *
 * 不清的话：删掉又导入同一路径的同一首歌时，会沿用上次手动指定的调性 ——
 * 用户会觉得「为什么新导入的歌调性是手动状态」。
 *
 * 磁盘上的 `songs/<id>/` 目录已由 `delete_song` 一并删除，这里只需清内存。
 */
async function onDeleteSong(id: string) {
  if (id in songEdits.value) {
    const next = { ...songEdits.value };
    delete next[id];
    songEdits.value = next;
  }
  await library.remove(id);
}

/** 恢复当前歌曲的自动推断调性（只清这一首的 key 字段） */
function onResetKey() {
  if (!library.currentId.value) return;
  // 显式写 null 而不是 delete：落盘后要能用 `"key": null` 表达"恢复自动"
  patchCurrentEdits({ key: undefined });
}

/**
 * 曲目信息。
 *
 * ⚠️ 每个字段都要 `?? 0` / `?? ''` 兜底。
 *
 * 分析结果来自 JSON.parse，字段缺失（老版本产物、partial 结果、损坏文件）
 * 时会得到 `undefined`，直接传给子组件的 `Number` prop → Vue 报
 * 「Invalid prop: type check failed for prop "bpm". Expected Number ...
 * got Undefined」，并且 `bpm.toFixed()` 会抛 TypeError 打断渲染。
 */
const SONG = computed(() => {
  const a = data.value;
  const key = effectiveKey.value;
  return {
    title: a.song?.title ?? '未命名',
    artist: a.song?.artist ?? '',
    durationSec: a.song?.durationSec ?? 0,
    bpm: a.meta?.bpmMedian ?? 0,
    bars: a.meta?.barCount ?? 0,
    beats: a.meta?.beatCount ?? 0,
    segments: (a.chords?.['submission'] ?? []).length,
    /** 调性：用户指定优先，否则自动推断；未知时不拼 "major" */
    key: key.tonic ? `${key.tonic} ${key.mode}` : '',
    /** 调性是否被用户改过（顶栏标注「手动」而不是「自动推断」） */
    keyIsManual: currentKeyOverride.value !== null,
    meter: '4/4',
    /** 调音偏差（已校正过才非 0） */
    tuningCents: a.tuning?.corrected ? a.tuning.deviationCents : undefined,
    /** 当前分析档位 */
    dictionary: 'submission' as 'submission' | 'ismir2017' | 'full',
  };
});

const dictionary = ref<'submission' | 'ismir2017' | 'full'>(SONG.value.dictionary);

/** 修改某段 BPM（速度轨双击编辑） */

/** 修改某段 BPM（速度轨双击编辑） */
function onTempoChange(payload: { index: number; bpm: number }) {
  // 只更新速度轨的**显示值**。时间换算仍然只用真实 downbeat 时长 ——
  // 改 BPM 不该让播放头和音频分家（见 tempoMap 的说明）。
  tempoSegments.value = tempoSegments.value.map((s, i) =>
    i === payload.index ? { ...s, bpm: payload.bpm } : s,
  );
}

// ---------------------------------------------------------------- 曲库

/** 需要重连的歌曲（音频路径失效） */
const reconnectTargetId = ref<string | null>(null);
const reconnectSong = computed(() =>
  library.songs.value.find((s) => s.id === reconnectTargetId.value) ?? null,
);

function onAddSongs() {
  void library.addSongs();
}
function onSelectSong(id: string) {
  void library.select(id);
}
function onReconnectRequest(id: string) {
  reconnectTargetId.value = id;
}

/**
 * 「重新分析全曲」。
 *
 * 之前这个按钮在模板里是个空壳（没有 `@click`、也没有对应 emit），
 * 点了完全没反应。
 *
 * 几个判断：
 *   - 没有选中曲目 → 无事可做（按钮本就该禁用，这里再兜一层）
 *   - 正在分析中   → 后端会返回「这首歌正在分析中」，与其弹错误，
 *                    不如直接忽略（按钮此时已禁用）
 *   - 浏览器模式   → 没有后端，直接返回
 *
 * 注意**不清空现有谱面**：重新分析是"再来一遍"，不是"先删后建"。
 * 旧的拍点/和弦继续显示着，新结果到了会被 `resetTracks` 整体替换；
 * 中途失败也能保住原来的数据。
 */
async function onReanalyze() {
  const id = library.currentId.value;
  if (!id || library.standalone) return;
  if (library.progress.value[id]) return; // 已在分析中
  await library.startAnalysis(id);
}

/* ---------------------------------------------------------------- 导出 */

/** 有和弦或拍点数据才允许导出（空谱面导出来是一份空报告） */
const hasAnalyzableData = computed(() => (data.value.chords?.submission?.length ?? 0) > 0 || totalTicks.value > 0);

/**
 * 让用户选保存位置并写文件。
 *
 * 用 `dialog.save()` 拿路径（用户亲手选的），再交给 Rust 写 ——
 * 这样不需要 `plugin-fs` 的目录白名单，也不受 webview 下载限制。
 */
async function saveTextWithDialog(args: {
  fileName: string;
  content: string;
  filterName: string;
  extensions: string[];
}): Promise<void> {
  if (library.standalone) {
    // 浏览器模式：退化成下载链接，至少能用
    const blob = new Blob([args.content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = args.fileName;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }

  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({
    defaultPath: args.fileName,
    filters: [{ name: args.filterName, extensions: args.extensions }],
  });
  if (!path) return; // 用户取消
  await writeTextFile(path, args.content);
}

/** 导出讲解稿（Markdown，给人看） */
async function onExportLecture() {
  if (!hasAnalyzableData.value) return;
  const md = buildLectureMarkdown({
    analysis: data.value,
    tracks: allTracks.value,
    key: effectiveKey.value,
    keyIsManual: currentKeyOverride.value != null,
    bpm: SONG.value.bpm,
  });
  await saveTextWithDialog({
    fileName: suggestFileName(SONG.value.title, 'md'),
    content: md,
    filterName: 'Markdown',
    extensions: ['md'],
  });
}

/** 导出 .fbsong（完整 JSON，给程序读） */
async function onExportFbsong() {
  if (!hasAnalyzableData.value) return;
  const bundle = buildFbsongBundle({
    analysis: data.value,
    edits: currentEdits.value,
    key: effectiveKey.value,
    bpm: SONG.value.bpm,
  });
  await saveTextWithDialog({
    fileName: suggestFileName(SONG.value.title, 'fbsong'),
    content: serializeFbsong(bundle),
    filterName: 'fbsong 工程文件',
    extensions: ['fbsong'],
  });
}

/** 当前曲目是否正在分析（顶栏按钮用） */
/**
 * 当前歌曲是否正在分析。
 *
 * **这是「锁住编辑器」的唯一判据**：只要当前歌在 progress 里，
 * 它的谱面就是半成品，改什么都会被后续结果覆盖。
 *
 * 注意和 `reanalyzing` 的区别：
 *   - `reanalyzing` 只关心「当前这首」，用于按钮文案/禁用
 *   - 这个用于遮罩和只读锁，语义等同但独立命名，将来若要加
 *     「后台还有别的歌在跑」的提示不会混在一起
 */
const analyzingCurrent = computed(() => {
  const id = library.currentId.value;
  return !!id && !!library.progress.value[id];
});

/** 分析进度信息（遮罩用） */
const analyzingInfo = computed(() => {
  const id = library.currentId.value;
  return id ? library.progress.value[id] : undefined;
});

/**
 * 已经推送到前端的阶段（用于点亮遮罩里的阶段条）。
 *
 * partial 事件在 beats / chords / structure 各推一次，
 * `partialStage` 是最后一次推的阶段名 —— 说明**它之前**的都完成了。
 */
const doneStages = computed<string[]>(() => {
  const order = ['beats', 'chords', 'structure'];
  const cur = library.partialStage.value;
  if (!cur) return [];
  const i = order.indexOf(cur);
  // 未知阶段名（后端新增的）就不点亮任何条，避免误标
  return i < 0 ? [] : order.slice(0, i + 1);
});

const reanalyzing = computed(() => {
  const id = library.currentId.value;
  return !!id && !!library.progress.value[id];
});
async function onReconnected() {
  const id = reconnectTargetId.value;
  reconnectTargetId.value = null;
  if (id) await library.onReconnected(id);
}

// 启动时加载曲库
void library.init();

/**
 * 侧栏宽度（用户可拖拽调整）。
 *
 * 为什么需要：中间时间轴被两侧挤压时只有 912px，
 * 用户反馈"太挤"。让侧栏可收窄是直接的解法。
 *
 * 存 localStorage，下次打开保持用户习惯。
 */
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;
const INSPECTOR_MIN = 220;
const INSPECTOR_MAX = 460;

function loadWidth(key: string, def: number, min: number, max: number): number {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

const sidebarWidth = ref(loadWidth('tl.sidebarWidth', 260, SIDEBAR_MIN, SIDEBAR_MAX));
const inspectorWidth = ref(loadWidth('tl.inspectorWidth', 280, INSPECTOR_MIN, INSPECTOR_MAX));

/** 自动滚动（跟随播放头）—— 默认开启 */
const autoScroll = ref(
  (typeof localStorage !== 'undefined' ? localStorage.getItem('tl.autoScroll') : null) !== '0',
);
watch(autoScroll, (v) => {
  try {
    localStorage.setItem('tl.autoScroll', v ? '1' : '0');
  } catch {
    /* ignore */
  }
});

function persistWidth(key: string, v: number) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* ignore */
  }
}

watch(sidebarWidth, (v) => persistWidth('tl.sidebarWidth', v));
watch(inspectorWidth, (v) => persistWidth('tl.inspectorWidth', v));

/**
 * 播放引擎。
 *
 * 现在用 SilentEngine（无音频文件，播放头按真实时间推进）。
 * 用户选择本地音频文件后切到 WebAudioEngine。
 * M2 接入 Rust 后端时，只需换成 TauriAudioEngine，**上层代码不动**。
 */
const engine = shallowRef<AudioEngine>(new SilentEngine(SONG.value.durationSec));
const hasAudio = ref(false);
let objectUrl: string | null = null;

const playback = usePlayback({
  engine,
  tempoMap: tempoMap,
  totalTicks: totalTicks,
});

const currentSec = playback.playheadSec;
const playheadTick = playback.playheadTick;

/** 当前小节号（显示用，1 起） */
const currentBar = computed(() => barAt(meterMap.value, playheadTick.value) + 1);

/** 当前 BPM（播放条/状态栏显示用） */
const currentBpm = computed(() => bpmAt(tempoMap.value, playheadTick.value));

/**
 * 诊断用：把当前 tick 用 tempoMap 反算回秒。
 *
 * 它应该永远等于 `currentSec`（引擎回报的音频位置）。
 * 两者不等 = 播放头和谱面不是同一套时间换算，那就是「滞后」的来源。
 */
const mapSec = computed(() => tickToSec(tempoMap.value, playheadTick.value));

/** 循环区间的秒表示（给播放条画高亮） */
const loopSecA = computed(() =>
  playback.loopStartTick.value != null
    ? tickToSec(tempoMap.value, playback.loopStartTick.value)
    : null,
);
/** 播放条显示的总时长：有音频用音频时长，否则用曲目元信息 */
const playbackDuration = computed(() => {
  const d = engine.value.duration();
  return d > 0 ? d : SONG.value.durationSec;
});

const loopSecB = computed(() =>
  playback.loopEndTick.value != null
    ? tickToSec(tempoMap.value, playback.loopEndTick.value)
    : null,
);

/**
 * 把播放引擎换成指向某个音频源的实例。
 *
 * 抽成公共函数是因为「浏览器选文件」和「切曲库歌曲」两条路径要做的事完全一样：
 * 建新引擎 → load → 换掉旧的 → 释放旧的。以前只有前者有这段代码，
 * 后者（切歌）根本没碰引擎 —— 于是切歌后播放的还是上一首（或静音）。
 *
 * 失败时**回退到静音引擎**而不是留着旧引擎：留着旧的会让人以为
 * 「音频换过来了但进度不对」，比直接没声音更难排查。
 */
async function swapEngine(src: string, label: string): Promise<void> {
  /**
   * 换引擎时**保住播放位置**。
   *
   * ## 踩过的坑（用户报「从头播放时光标先往前跑一阵，然后跳回开头」）
   *
   * 音频是在后台异步加载的，加载期间用的是 `SilentEngine`（按真实时间推进）。
   * 用户这时点了播放，光标正常往前走；音频一加载完就切到 `WebAudioEngine`，
   * 而这里原本无条件 `seekSec(0)` —— 光标被硬拽回开头。
   *
   * 现在保留位置：本来在播就接着播，暂停就停在原处。
   */
  const wasPlaying = playback.playing.value;
  const pos = playback.playheadSec.value;
  const next = new WebAudioEngine();
  try {
    await next.load(src);
    engine.value.dispose();
    engine.value = next;
    hasAudio.value = true;
    playback.seekSec(pos);
    if (wasPlaying) void playback.play();
  } catch (e) {
    console.warn(`[audio] ${label} 加载失败，回退静音模式`, e);
    next.dispose();
    const silent = new SilentEngine(SONG.value.durationSec);
    engine.value.dispose();
    engine.value = silent;
    hasAudio.value = false;
    playback.seekSec(Math.min(pos, SONG.value.durationSec));
  }
}

/** 加载本地音频文件（M2 之前的临时方案：浏览器 File API） */
async function loadAudioFile(file: File) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  await swapEngine(objectUrl, file.name);
}

/**
 * 切歌后重新加载音频。
 *
 * 依赖 `library.currentAudioPath`（和 `currentAnalysis` 同一次 await 的产物），
 * 所以不会出现「谱面是新歌、音频还是旧歌」。
 */
watch(
  () => library.currentAudioPath.value,
  async (path) => {
    // 浏览器模式没有后端，音频只能靠用户手动选文件
    if (library.standalone) return;
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    if (!path) {
      const silent = new SilentEngine(SONG.value.durationSec);
      engine.value.dispose();
      engine.value = silent;
      hasAudio.value = false;
      playback.seekSec(0);
      return;
    }
    // file:// 在 WebView 里会被拦，必须转成 asset:// / http://asset.localhost
    await swapEngine(convertFileSrc(path), path);
  },
);

/** 跳到上一/下一小节 */
const barStarts = computed(() => {
  const out: number[] = [];
  for (let b = 0; b < data.value.downbeatsSec.length; b++) out.push(tickOfBar(meterMap.value, b));
  return out;
});

function jumpBar(dir: -1 | 1) {
  const cur = playheadTick.value;
  if (dir < 0) {
    // 找当前小节起点，若已在起点附近则跳到上一小节
    const idx = barAt(meterMap.value, cur);
    const start = tickOfBar(meterMap.value, idx);
    const target = cur - start > 400 ? start : tickOfBar(meterMap.value, Math.max(0, idx - 1));
    playback.seekTick(target);
  } else {
    const idx = barAt(meterMap.value, cur);
    playback.seekTick(tickOfBar(meterMap.value, idx + 1));
  }
}
void barStarts;

/** 循环开关：以当前小节为区间 */
function toggleLoop() {
  if (playback.hasLoop.value) {
    playback.clearLoop();
    return;
  }
  const idx = barAt(meterMap.value, playheadTick.value);
  const a = tickOfBar(meterMap.value, idx);
  const b = tickOfBar(meterMap.value, idx + 2);
  playback.setLoopTicks(a, b);
}

// 空格 = 播放/暂停（PRD §4.4 快捷键）
function onGlobalKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') {
    e.preventDefault();
    playback.toggle();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onGlobalKey);
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onGlobalKey);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  engine.value.dispose();
});

const timelineRef = ref<InstanceType<typeof TimelineView> | null>(null);

/** 时间轴内部状态（缩放百分比 / 撤销可用性）—— 由 TimelineView 通过 expose 提供 */
const tlState = computed(() => {
  const t = timelineRef.value as unknown as {
    zoomPercent?: number;
    canUndoFlag?: boolean;
    canRedoFlag?: boolean;
  } | null;
  return {
    zoomPercent: t?.zoomPercent ?? 100,
    canUndo: t?.canUndoFlag === true,
    canRedo: t?.canRedoFlag === true,
  };
});

function onZoomSet(pct: number) {
  (timelineRef.value as unknown as { setZoomPercent?: (p: number) => void } | null)?.setZoomPercent?.(pct);
}
/**
 * 用户从检查器的「候选和弦」里点了一项 → 替换当前选中段。
 *
 * 走 `editing.setLabel`，所以：
 *   - 记进撤销历史（Ctrl+Z 可回退）
 *   - 级数解释轨会自动跟着变（它从父和弦投影）
 *   - 改完的块 `state` 仍是 draft，用户还可以再点「确认」
 *
 * 注意**不改 `confidence`**：那个值描述的是「模型有多确定」，
 * 用户手动换了和弦并不代表模型改主意了。留着它反而有用 ——
 * 低置信度的地方本来就是人要重点看的地方。
 */
function onPickChord(chord: string) {
  (timelineRef.value as unknown as { setSelectedLabel?: (label: string) => boolean } | null)
    ?.setSelectedLabel?.(chord);
}

/**
 * 右键菜单「编辑」→ 选中该片段并**展开检查器里的和弦选择器**。
 *
 * 改名统一走右侧（双击就地编辑已移除）。选中本身由 TimelineView 完成，
 * 这里只需要让选择器自动展开 —— 否则用户右键「编辑」后还得再点一下
 * 折叠标题，等于两步做一件事。
 */
const openPickerNonce = ref(0);
function onRequestEdit(_clipId: string) {
  openPickerNonce.value++;
}

function onUndo() {
  (timelineRef.value as unknown as { undo?: () => void } | null)?.undo?.();
}
function onRedo() {
  (timelineRef.value as unknown as { redo?: () => void } | null)?.redo?.();
}

/**
 * 当前选中的片段（检查器用）。
 *
 * ## 必须读**编辑层**，不能读 `tracks`
 *
 * `tracks` 是从 `data`（分析结果）算出来的静态数据。
 * 用户改和弦（点候选）、确认/拒绝，只发生在编辑层的 `clipsByTrack` 里。
 * 拿 `tracks` 去找片段的话：
 *   - 点了候选和弦 → 时间轴上的块变成新的，检查器还显示旧和弦
 *   - 点了确认 → 状态标记不变，看起来像没生效
 *
 * 所以直接从组件暴露的 `selectedClipLive` 读（它就是编辑层里那份，
 * 而且带拖动预览）。`tracks` 只作为兜底（比如刚挂载还没 expose 完）。
 */
const selectedClip = computed(() => {
  type Live = {
    id: string;
    label: string;
    sublabel?: string;
    startTick: number;
    endTick: number;
    state?: 'draft' | 'confirmed' | 'rejected';
    confidence?: number;
    alternatives?: ReadonlyArray<{ chord: string; prob: number }>;
    trackId: string;
  };
  const ref = timelineRef.value as unknown as {
    selectedClipLive?: Live | null;
  } | null;

  const live = ref?.selectedClipLive;
  if (!live) return undefined;

  // 从轨道 id 反推轨道种类（检查器里要显示 kind）
  const track = tracks.value.find((t) => t.id === live.trackId);

  return {
    kind: (track?.kind as string) ?? 'chord',
    label: live.label,
    sublabel: live.sublabel,
    startSec: tickToSec(tempoMap.value, live.startTick),
    endSec: tickToSec(tempoMap.value, live.endTick),
    state: (live.state ?? 'draft') as 'draft' | 'confirmed' | 'rejected',
    confidence: live.confidence,
    alternatives: live.alternatives,
    source: 'lv-chordia s0–s4',
    rawStartSec: tickToSec(tempoMap.value, live.startTick) - 0.02,
    rawEndSec: tickToSec(tempoMap.value, live.endTick) + 0.03,
  };
});

</script>

<template>
  <div class="app-shell">
    <!-- 顶部工具栏 -->
    <TopToolbar
      :title="SONG.title"
      :artist="SONG.artist"
      :bpm="SONG.bpm"
      :key-name="SONG.key"
      :tuning-cents="SONG.tuningCents"
      :meter="SONG.meter"
      :dictionary="dictionary"
      :bars="SONG.bars"
      :beats="SONG.beats"
      :segments="SONG.segments"
      :zoom-percent="tlState.zoomPercent"
      :can-undo="tlState.canUndo"
      :can-redo="tlState.canRedo"
      :auto-scroll="autoScroll"
      @zoom-in="timelineRef?.zoomIn()"
      @zoom-out="timelineRef?.zoomOut()"
      @zoom-fit="timelineRef?.zoomFit()"
      @zoom-set="onZoomSet"
      @undo="onUndo"
      @redo="onRedo"
      @toggle-auto-scroll="autoScroll = !autoScroll"
      @dictionary-change="dictionary = $event"
      :reanalyzing="reanalyzing"
      @reanalyze="onReanalyze"
      :can-export="hasAnalyzableData"
      @export-lecture="onExportLecture"
      @export-fbsong="onExportFbsong"
      :key-is-manual="SONG.keyIsManual"
      :auto-key="autoKeyInfo"
      :key-value="effectiveKey"
      @set-key="onSetKey"
      @reset-key="onResetKey"
    />

    <!-- 主体三栏 -->
    <div class="main">
      <SongLibrary
        :width="sidebarWidth"
        :songs="library.songs.value"
        :current-id="library.currentId.value"
        :progress="library.progress.value"
        :missing-ids="library.missingIds.value"
        :busy="library.busy.value"
        :standalone="library.standalone"
        @add="onAddSongs"
        @select="onSelectSong"
        @reconnect="onReconnectRequest"
        @delete="onDeleteSong"
      />
      <ResizeHandle
        v-model="sidebarWidth"
        side="right"
        :min="SIDEBAR_MIN"
        :max="SIDEBAR_MAX"
        :default-value="260"
      />

      <div class="center">
        <!--
          空态提示。
          谱面为空 = 这首歌还没分析完（或分析失败）。
          以前这里什么都不显示，用户只看到一片空白的时间轴，
          以为界面坏了 —— 其实是在跑分析。
        -->
        <div v-if="emptyHint" class="empty-hint">
          <div class="empty-hint-icon">{{ emptyHint.icon }}</div>
          <div class="empty-hint-title">{{ emptyHint.title }}</div>
          <div class="empty-hint-sub">{{ emptyHint.sub }}</div>
        </div>

        <!--
          分析遮罩：盖住编辑区并锁编辑。

          为什么不是只灰掉工具栏：编辑有 5 条入口（双击新建、拖拽移动、
          边缘改长、Delete、右键菜单），靠 UI 禁用一定漏。真正的锁在
          useClipEditing 的写操作入口（readonly 回调），这里负责
          「让用户知道为什么点不动」。
        -->
        <AnalyzingOverlay
          v-if="analyzingCurrent"
          :title="SONG.title"
          :pct="analyzingInfo?.pct ?? 0"
          :message="analyzingInfo?.message"
          :stage="analyzingInfo?.stage"
          :done-stages="doneStages"
        />

        <TimelineView
          ref="timelineRef"
          :tracks="allTracks"
          :playhead-tick="playheadTick"
          :meter-map="meterMap"
          :total-ticks="totalTicks"
          :bpm-median="SONG.bpm"
          :key-tonic="effectiveKey.tonic"
          :key-mode="effectiveKey.mode"
          :analysis-key="editKey"
          :readonly="analyzingCurrent"
          :auto-scroll="autoScroll"
          :playing="playback.playing.value"
          :tempo-segments="tempoSegments"
          @seek-tick="playback.seekTick"
          @tempo-change="onTempoChange"
          @request-edit="onRequestEdit"
          @add-degree-track="addDegreeTrack"
          @remove-degree-track="removeDegreeTrack"
          @change-degree-track-key="updateDegreeTrackKey"
          @chord-edits-change="onChordEditsChange"
          @section-edits-change="onSectionEditsChange"
          @restore-ai-sections="onRestoreAiSections"
        />
      </div>

      <ResizeHandle
        v-model="inspectorWidth"
        side="left"
        :min="INSPECTOR_MIN"
        :max="INSPECTOR_MAX"
        :default-value="280"
      />
      <InspectorPanel
        :clip="selectedClip"
        :width="inspectorWidth"
        :open-picker-signal="openPickerNonce"
        @pick-chord="onPickChord"
      />
    </div>

    <!-- 底部播放条 -->
    <PlayerBar
      :duration-sec="playbackDuration"
      :current-sec="currentSec"
      :playing="playback.playing.value"
      :loop-a="loopSecA"
      :loop-b="loopSecB"
      :bar-number="currentBar"
      :error="playback.error.value"
      :has-audio="hasAudio"
      @seek="playback.seekSec"
      @toggle-play="playback.toggle"
      @nudge="playback.nudgeSec"
      @jump-bar="jumpBar"
      @toggle-loop="toggleLoop"
      @load-file="loadAudioFile"
    />

    <!-- 音频失效：重新匹配 dialog -->
    <ReconnectDialog
      v-if="reconnectSong"
      :song="reconnectSong"
      :expected-duration-sec="reconnectSong.duration_sec"
      @resolved="onReconnected"
      @cancel="reconnectTargetId = null"
    />


    <!-- 开发期角标：提示这是假 UI -->
    <div class="dev-badge">
      第 {{ currentBar }} 小节 · ♩={{ currentBpm.toFixed(1) }} · tick {{ playheadTick }}
      <!--
        对齐诊断三件套：
          ① 引擎回报的音频秒数（currentSec）
          ② 用 tempoMap 把当前 tick 反算回秒（mapSec）
          ③ 起点的秒数（data.downbeatsSec[0]）

        ①② 应该永远相等 —— 不等说明 tempoMap 和播放头不是同一套换算。
        ③ 变了说明 data 被重建（HMR / 重新加载）过。
      -->
      · {{ currentSec.toFixed(2) }}s
      · map {{ mapSec.toFixed(2) }}s
      · 起点 {{ data.downbeatsSec[0]?.toFixed(2) ?? '—' }}s
      <span v-if="!hasAudio"> · 静音推进</span>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
  min-height: 0;
  position: relative;
}

.main {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}

.center {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  position: relative;
}

/* 空态提示：盖在时间轴上方居中（不挡轨道头，所以垂直方向偏上一点） */
.empty-hint {
  position: absolute;
  left: 0;
  right: 0;
  top: 38%;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none; /* 别挡住下面的交互 */
  text-align: center;
  padding: 0 24px;
}
.empty-hint-icon {
  font-size: 30px;
  line-height: 1;
  color: var(--text-muted);
  opacity: 0.55;
}
.empty-hint-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}
.empty-hint-sub {
  font-size: 12px;
  color: var(--text-muted);
  max-width: 420px;
}


.dev-badge {
  position: fixed;
  right: 12px;
  bottom: 64px;
  padding: 3px 9px;
  border-radius: 0;
  background: rgba(232, 163, 61, 0.14);
  border: 1px solid rgba(232, 163, 61, 0.4);
  color: var(--warning);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  z-index: 50;
}
</style>
