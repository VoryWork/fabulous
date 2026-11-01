<script setup lang="ts">
/**
 * 时间轴视口 —— Canvas 网格 + DOM 片段 + 顶部标尺。
 *
 * 假 UI 阶段的目标：
 *   1. 验证"Canvas 与 DOM 消费同一个 Viewport 快照"确实能对齐（PRD A09）
 *   2. 验证视觉层次：小节线 / 拍线 / 片段 / 播放头 的相对关系
 *   3. 支持缩放与横向滚动，证明 Geometry 模块可用
 *
 * 尚未实现（后续 1.2.4+）：拖动、Resize、Snap、自动滚动、选区。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { COLORS, SIZES, sectionColor, trackStyle, type TrackKind } from '../timeline/design/tokens';
import KeyPicker from './KeyPicker.vue';
import SectionPicker from './SectionPicker.vue';
import {
  MAX_PIXELS_PER_TICK,
  clampZoom,
  MIN_PIXELS_PER_TICK,
  createViewport,
  fitToContent,
  scrollByPixels,
  tickToX,

  snapPx,
  snapPxLine,
  tickRangeToIntRect,
  visibleRange,
  zoomAtX,
  type Viewport,
} from '../timeline/domain/TimelineGeometry';
import { barAt, barLinesInRange, beatLinesInBar, meterAt, tickOfBar } from '../timeline/domain/MeterMap';
import { useClipEditing } from '../timeline/interaction/useClipEditing';
import { degreeTonicOf, shouldHighlightDegree } from '../timeline/demo/realData';
import ContextMenu, { type MenuItem } from './ContextMenu.vue';
import type { ClipState } from '../timeline/domain/EditCommands';
import type { TrackKindC } from '../timeline/domain/ConstraintEngine';
import { UNRECOGNIZED_LABEL, chordToNumber, type RealTrack } from '../timeline/demo/realData';
import type { MeterMapData } from '../timeline/domain/MeterMap';

/**
 * 和弦轨编辑快照（落盘用）。
 *
 * 只留渲染必需的字段：`parentId` / `sublabel` / `layer` 都能从轨道重新推出，
 * 存进去只让 JSON 变大。
 */
export interface ChordEditSnapshot {
  id: string;
  startTick: number;
  endTick: number;
  label: string;
  state?: string;
}

/**
 * 结构段编辑快照（落盘用）。
 *
 * 带 `key` 是因为段调性是这一轮新加的信息：用户标注「这段转调了」，
 * 必须跟着结构一起存，否则重开就丢了。
 */
export interface SectionEditSnapshot {
  id: string;
  startTick: number;
  endTick: number;
  label: string;
  key?: { tonic: string; mode: 'major' | 'minor' };
}

/** 自动聚焦指令（就地编辑输入框用） */
const vFocus = {
  mounted: (el: HTMLInputElement) => {
    el.focus();
    el.select();
  },
};

const emit = defineEmits<{
  /** 请求跳转播放位置（tick） */
  (e: 'seek-tick', tick: number): void;
  /** 修改某个速度段的 BPM */
  (e: 'tempo-change', payload: { index: number; bpm: number }): void;
  /** 请求编辑某个片段的文本（右键菜单 → 编辑）；父组件负责聚焦输入框 */
  (e: 'request-edit', clipId: string): void;
  /** 追加一条按其他调性解释的级数轨 */
  (e: 'add-degree-track'): void;
  /** 删除某条追加的级数轨 */
  (e: 'remove-degree-track', id: string): void;
  /** 改某条追加级数轨的调性（主音 + 大小调，见 pickTrackKey） */
  (e: 'change-degree-track-key', id: string, v: { tonic: string; mode: 'major' | 'minor' }): void;
  /**
   * 和弦轨被用户改了（改名 / 拖动 / 删除 / 新增）。
   *
   * 父组件据此落盘到按歌曲隔离的 `edits_json` —— 编辑是会话级数据，
   * 不能只活在内存里（切歌就没了）。
   */
  (e: 'chord-edits-change', clips: ChordEditSnapshot[]): void;
  /**
   * 结构轨被用户改了（新建 / 删除 / 改名 / 拆分 / 合并 / 拖边界 / 标调性）。
   *
   * 和 `chord-edits-change` 同一套思路：结构是会话级数据，必须按歌曲落盘。
   * 区别是它**不绑分析指纹** —— 结构是人工判断，不该被重分析覆盖。
   */
  (e: 'section-edits-change', clips: SectionEditSnapshot[]): void;
  /** 请求给某个结构段设置调性（父组件弹 KeyPicker） */
  (e: 'request-section-key', clipId: string): void;
  /** 请求给某个结构段改名字（父组件弹字典选择器） */
  (e: 'request-section-rename', clipId: string): void;
  /** 请求丢弃用户的结构编辑，回到模型给的结构 */
  (e: 'restore-ai-sections'): void;
}>();


const props = defineProps<{
  tracks: RealTrack[];
  /** 播放头位置（tick） */
  playheadTick?: number;
  /** 拍号表（由真实 downbeat 数据构造） */
  meterMap: MeterMapData;
  /** 内容总 tick */
  totalTicks: number;
  /** 整体 BPM（速度轨显示用） */
  bpmMedian?: number;
  /**
   * 调性主音（如 `Ab`）。
   *
   * 级数轨要用它把和弦换算成级数。必须由父组件传：调性是从整份分析和弦
   * 推断出来的，TimelineView 手里只有轨道数据，算不出来。
   * 用户改了和弦后级数要重新算，所以这里必须拿**当前**的调性。
   */
  /**
   * 只读（歌曲正在分析时）。
   *
   * 分析中的谱面是**半成品**：拍点可能还会变、和弦还会增删。
   * 这时让用户编辑，改完的结果会被随后的分析结果覆盖掉，
   * 或者跟半成品数据打架 —— 所以分析期间一律锁住。
   */
  readonly?: boolean;
  keyTonic?: string;
  /**
   * 全局调式。只用于「级数解释」那条自动轨的调性标注 ——
   * 它没有自己的 `degreeTonic`，调性完全跟随全局。
   */
  keyMode?: 'major' | 'minor';
  /**
   * 分析结果指纹（父组件传 `${songId}:${拍数-小节数-和弦段数-时长}`）。
   *
   * 编辑层用它判断「是不是换了一份数据」，变了才全量重建。
   * **不能**用 `tracks` 结构判断：那里面含用户编辑，会形成
   * 「编辑 → 重建 → 丢撤销历史」的循环。
   */
  analysisKey?: string;
  /**
   * 播放时自动跟随播放头滚动。
   *
   * 开启后：播放头接近视口右边缘时，滚动时间轴让它回到左侧，
   * 这样播放过程中始终能看到当前小节。
   * 关闭后：播放头可以移出视口（用户自己手动滚动浏览）。
   */
  autoScroll?: boolean;
  /** 是否正在播放（只有播放时才自动滚动） */
  playing?: boolean;
  /**
   * 速度段（BPM 变化）。速度轨渲染这些段，支持双击改 BPM。
   * 不传时退化为单一 BPM（用 bpmMedian）。
   */
  tempoSegments?: { startBar: number; endBar: number; bpm: number }[];
}>();

/**
 * 从追加级数轨的名字里解析出「主音 调式」。
 *
 * 为什么不另开一个 prop：轨道名本身就是 `级数 · A 小调`。
 * 要给轨道头显示当前调性就得有地方存它 —— 与其加一个和 tracks
 * 平行的 map（两份状态会不同步），不如从 track 自己身上解析。
 *
 * 返回 null 表示这不是追加轨（分析生成的那条不带开关）。
 */
function degreeTrackKeyOf(id: string): string | null {
  const t = props.tracks.find((x) => x.id === id);
  if (!t || t.kind !== 'degree') return null;
  // `级数 · A 小调` → `A 小调`
  const m = /^级数 · (.+)$/.exec(t.name);
  return m ? m[1] : null;
}

/**
 * 轨道头的那行小字（副标题）。
 *
 * 级数解释轨（自动推断那条）的调性是**生成时写死**在 `layer` 上的，
 * 用户手动改全局主调后它不会变 —— 于是出现「数字按 D 大调算、
 * 小字还写着 G major」的自相矛盾。这里让自动轨动态跟随全局。
 *
 * 自定义级数轨保留自己的 `layer`（就写「手动指定」），
 * 它的调性由旁边的徽章单独显示。
 */
function trackLayerOf(t: { kind: TrackKind; layer?: string; degreeTonic?: string }): string {
  if (t.kind !== 'degree' || t.degreeTonic) return t.layer ?? '';
  const tonic = props.keyTonic;
  if (!tonic) return t.layer ?? '';
  return `${tonic} ${props.keyMode === 'minor' ? 'minor' : 'major'}（自动推断）`;
}

/**
 * 追加级数轨的调性选择弹层。
 *
 * ## 为什么不再用「点一下切大/小调」
 *
 * 最初图省事做成循环切换，结果用户根本没法用 —— **改不了主音**。
 * 用户最常见的需求恰恰是「这条轨按 F# 小调解释」，而自动给的可能是
 * 任意主音，只能切大小调等于没得选。
 *
 * 现在点徽章弹出和顶栏同一个 KeyPicker（12 主音 × 2 调式），
 * 交互一致，不用学第二套。
 */
const keyPopFor = ref<string | null>(null);

/**
 * 弹层打开的时间戳（毫秒）。
 *
 * 用来区分「打开弹层的那次点击」和「之后点外面的点击」——
 * 两者都是 document 上的事件，光看 target 分不出来。
 *
 * ⚠️ 必须在 `toggleKeyPop` **之前**声明：`let` 是暂时性死区，
 * 声明在使用之后就抛 ReferenceError，而且首次打开时才触发、
 * 被 Vue 的事件处理吞掉，表现为「点了没反应」—— 极难查。
 */
let keyPopOpenedAt = 0;

/** 弹层当前用的调性值（从轨道名解析） */
function degreeTrackKeyValue(id: string): { tonic: string; mode: 'major' | 'minor' } {
  const t = props.tracks.find((x) => x.id === id);
  // 优先读轨道自己身上的字段（生成时就写好的，比解析名字可靠）
  if (t?.degreeTonic) {
    return { tonic: t.degreeTonic, mode: t.degreeMode ?? 'major' };
  }
  // 老数据没有字段，退回从名字解析
  const m = t ? /^级数 · (.+?) (大调|小调)$/.exec(t.name) : null;
  if (!m) return { tonic: 'C', mode: 'major' };
  return { tonic: m[1], mode: m[2] === '小调' ? 'minor' : 'major' };
}

/** 弹层固定定位坐标（Teleport 到 body，靠按钮的屏幕坐标算） */
const keyPopStyle = ref<Record<string, string>>({});

function toggleKeyPop(id: string, e: MouseEvent) {
  if (keyPopFor.value === id) {
    keyPopFor.value = null;
    return;
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  // 优先往按钮下方展开；空间不够就往上
  const POP_H = 210;
  const below = r.bottom + 4;
  const top = below + POP_H > window.innerHeight ? r.top - POP_H - 4 : below;
  keyPopStyle.value = {
    position: 'fixed',
    left: Math.max(8, r.left) + 'px',
    top: Math.max(8, top) + 'px',
  };
  keyPopFor.value = id;
  keyPopOpenedAt = Date.now();
}

function pickTrackKey(id: string, v: { tonic: string; mode: 'major' | 'minor' }) {
  emit('change-degree-track-key', id, v);
  keyPopFor.value = null;
}

/**
 * 点弹层外面关闭。
 *
 * 不监听的话弹层会一直挂着，用户点别处以为已经切走、其实没生效。
 */
/**
 * 点弹层外面关闭。
 *
 * ## 为什么用 mousedown 而不是 click
 *
 * 踩过的坑：用 `click` 时，打开弹层的**那一次**点击也会冒泡到 document，
 * 于是弹层刚一出现就被关掉 —— 表现为「点徽章没反应」。
 *
 * 换成 `mousedown` 也不行（同一次按下同样冒泡），所以还要加一层判定：
 * 打开弹层时记录时间戳，同一个事件循环内的 mousedown 直接忽略。
 */
function onDocPointerDown(e: MouseEvent) {
  if (!keyPopFor.value) return;
  // 刚打开（同一个交互内）→ 不关
  if (Date.now() - keyPopOpenedAt < 150) return;
  const el = e.target as HTMLElement | null;
  // 弹层已经 Teleport 到 body，不在轨道头里
  if (el?.closest('.key-pop') || el?.closest('.track-key-btn')) return;
  keyPopFor.value = null;
}
onMounted(() => document.addEventListener('mousedown', onDocPointerDown));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocPointerDown));

/** 用 props 传入的真实数据，不再用假数据 */
const meterMap = props.meterMap;

/**
 * 顶部「拍号 tag 轨」的数据：拍号变化点。
 *
 * 用户的设计：拍号做成最上面的 tag 轨，**只改变尺子分组，不改变格子间隔**。
 * 所以这里只需要列出「在哪里变、变成什么」，格子密度由 CELL_TICKS 恒定控制。
 */
/**
 * 拍号标记（**标签式**，不是覆盖整段的色块）。
 *
 * 参照 Song Master 的做法：拍号只在**变化点**打一个小标签（如 `4/4`），
 * 中间保持空白。这样：
 *   - 视觉干净，不会被大色块淹没
 *   - 一眼能看出"哪里变了"
 *   - 用户可以双击标签改拍号
 */
const meterTags = computed(() =>
  meterMap.events.map((e, i) => ({
    key: `meter-${i}`,
    tick: e.startTick,
    label: `${e.numerator}/${e.denominator}`,
    index: i,
  })),
);

/** 每小节 tick 数 */
const BAR_TICKS = 4 * 960;

/**
 * 速度标记（**标签式**）。
 *
 * 与旧版的区别：旧版把每个 BPM 段渲染成覆盖整段的色块，视觉上很吵。
 * 现在只在**每个段的起点**打一个标签（`♩ = 130`），段之间保持空白。
 *
 * 这符合「BPM 是标签、拍时间轴是基准」的语义：
 *   - BPM 标记告诉你"从这里开始按这个速度走"
 *   - 它不"拥有"一段时间区间，只是改变走时速度
 */
const tempoTags = computed(() => {
  const segs = props.tempoSegments;
  if (segs && segs.length > 0) {
    return segs.map((s, i) => ({
      key: `tempo-${i}`,
      tick: s.startBar * BAR_TICKS,
      endBar: s.endBar,
      label: s.bpm.toFixed(1),
      bpm: s.bpm,
      index: i,
    }));
  }
  const bpm = props.bpmMedian ?? 0;
  if (!bpm) return [];
  return [{ key: 'tempo-all', tick: 0, endBar: 0, label: bpm.toFixed(1), bpm, index: -1 }];
});

// ---------------------------------------------------------------- 速度段编辑

/** 正在编辑的速度段索引（双击进入） */
const editingTempo = ref<{ index: number; value: string } | null>(null);

function onTempoDoubleClick(tag: { index: number; bpm: number }) {
  if (tag.index < 0) return;
  editingTempo.value = { index: tag.index, value: String(tag.bpm) };
}

function commitTempoEdit() {
  const e = editingTempo.value;
  if (!e) return;
  const bpm = Number(e.value);
  editingTempo.value = null;
  if (!Number.isFinite(bpm) || bpm <= 0 || bpm > 400) return;
  emit('tempo-change', { index: e.index, bpm });
}

/**
 * 内容总长（tick）。
 *
 * ⚠️ 必须是 `computed`，**不能**写成 `const totalTicks = props.totalTicks`。
 *
 * 那是快照：只在 setup 时取一次值。而这首歌的数据是**异步到位**的
 * （先在曲库列表里出现，分析完才有谱面），首次挂载时 `props.totalTicks`
 * 往往是 0，等数据来了、`props` 变成 199 小节，组件里的 `totalTicks`
 * 还是 0 —— 于是：
 *   - `maxScrollTick` 永远是 0 → 横向滚动条拖不动
 *   - `canScroll` 永远是 false → 滚动条显示为禁用态
 *   - `zoomFit` / 点击定位也被夹在 0
 *
 * 表现就是用户报的「横向滚动失效了」。
 */
const totalTicks = computed(() => props.totalTicks);

/**
 * 编辑状态（手势 + 约束 + 吸附 + 历史）。
 *
 * 注意：这里把 props.tracks 转成可变的 ClipState 列表。
 * 真实实现里这部分数据来自后端；现在是本地内存态。
 */
const trackKindMap: Record<string, TrackKindC> = {
  section: 'section',
  key: 'key',
  chord: 'chord',
  degree: 'degree',
  lyric: 'lyric',
} as const;

const editing = useClipEditing({
  // 每次调用取最新值：分析完成后 readonly 变 false，编辑立刻恢复，
  // 不用重建编辑层（那会丢掉撤销历史）
  readonly: () => props.readonly === true,
  tracks: toEditableTracks(props.tracks),
  toX: (tick) => tickToX(viewport.value, tick),
  xToTick: (x) => Math.round(xToTickFloatLocal(x)),
  pixelsPerTick: () => viewport.value.pixelsPerTick,
  scrollTick: () => viewport.value.scrollTick,
  barStarts: () => {
    const out: number[] = [];
    const range = visibleRange(viewport.value, 0.5);
    const first = barAt(meterMap, range.startTick);
    const last = barAt(meterMap, range.endTick) + 1;
    for (let b = first; b <= last; b++) out.push(tickOfBar(meterMap, b));
    return out;
  },
});

/**
 * 把和弦轨的编辑结果报给父组件，用于按歌曲落盘。
 *
 * ## 为什么由这里报，而不是父组件自己看 props
 *
 * 用户的编辑只存在编辑层（`useClipEditing` 的内部快照），**不回写**
 * `props.tracks` —— 那是分析结果，改它会让「重新分析」无从判断。
 * 所以只有这里知道「用户最终看到的和弦是什么」。
 *
 * ## 为什么手势期间不报（省磁盘）
 *
 * 拖动一个和弦，`clipsByTrack` 每帧都在变（60fps）。原来每一帧都 emit，
 * 靠父组件 250ms 防抖兜 —— 一秒仍然写 4 次盘，一次写两处 20KB 快照。
 * 用户提的「不要频繁消耗磁盘寿命」就是这个。
 *
 * 现在**拖动/拉伸过程中一次都不报**，松手（手势回到 idle）才报一次。
 * 拖动中途崩溃最多丢这一次拖动，不影响已有结果。
 */
function reportChordEdits() {
  const chordTrack = props.tracks.find((t) => t.kind === 'chord');
  if (!chordTrack) return;
  const clips = editing.clipsByTrack.value[chordTrack.id];
  if (!clips) return;
  emit(
    'chord-edits-change',
    clips.map((c) => ({
      id: c.id,
      startTick: c.startTick,
      endTick: c.endTick,
      label: c.label,
      state: c.state,
    })),
  );
}

/**
 * 把结构轨的编辑结果报给父组件（按歌曲落盘）。
 *
 * ## 为什么还要单独报 `key`
 *
 * `ClipState` 只有 id/tick/label/state，没有 section 的调性字段。
 * 调性是用户后来标注上去的，只存在 `clipsByTrack` 的运行时对象里
 * （见 `useClipEditing.setSectionKey`），所以这里要显式取出来 ——
 * 漏了它，用户标的段调性在切歌后就没了。
 */
function reportSectionEdits() {
  const secTrack = props.tracks.find((t) => t.kind === 'section');
  if (!secTrack) return;
  const clips = editing.clipsByTrack.value[secTrack.id];
  if (!clips) return;
  emit(
    'section-edits-change',
    clips.map((c) => ({
      id: c.id,
      startTick: c.startTick,
      endTick: c.endTick,
      label: c.label,
      key: (c as { key?: { tonic: string; mode: 'major' | 'minor' } }).key,
    })),
  );
}

watch(
  () => editing.clipsByTrack.value,
  () => {
    // 手势进行中：不报。松手时下面的 watch 会补报一次
    if (editing.gesture.value.kind !== 'none') return;
    reportChordEdits();
    reportSectionEdits();
  },
  { deep: true },
);

/**
 * 手势结束 → 补报一次。
 *
 * 拖动过程中被跳过的那些变化，必须在这里补上，否则「拖完不松手直接切歌」
 * 这类操作会丢掉最后一次位置。
 */
watch(
  () => editing.gesture.value.kind,
  (kind, prev) => {
    if (prev !== 'none' && kind === 'none') {
      reportChordEdits();
      reportSectionEdits();
    }
  },
);

/**
 * 把 props.tracks 转成编辑层要的形状（setup 初始化 + 后续 reset 共用）。
 */
function toEditableTracks(list: readonly RealTrack[]) {
  return list.map((t) => ({
    id: t.id,
    kind: (trackKindMap[t.kind] ?? 'chord') as TrackKindC,
    clips: t.clips.map<ClipState>((c) => ({
      id: c.id,
      trackId: t.id,
      startTick: c.startTick,
      endTick: c.endTick,
      label: c.label,
      sublabel: c.sublabel,
      state: c.state,
      layer: t.layer,
      parentId: c.parentId,
      confidence: c.confidence,
      alternatives: c.alternatives,
      // 结构段的调性必须带上：漏了它，切歌 / 重启后编辑层里就没有调性了
      // （`ClipState` 的字段里没有 key，只能靠这里透传）。
      key: (c as { key?: { tonic: string; mode: 'major' | 'minor' } }).key,
    })),
  }));
}

/**
 * ## 编辑层为什么需要外部同步
 *
 * `useClipEditing` 只在 setup 时读一次 `props.tracks`，之后内部是独立快照。
 * 没有同步，切歌后 `props.tracks` 换了、时间轴却一直画最初那份数据 ——
 * 表现就是「切到新歌还显示上一首的块」。
 *
 * 但同步要分两种粒度，**不能一律全量重建**：
 *
 *   1. **换数据**（切歌 / 分析结果从拍点推进到和弦）→ `resetTracks`
 *      必须清掉选中、手势、撤销历史 —— 旧 clipId 在新数据里不存在。
 *   2. **只换级数轨**（改调性 / 加一条 / 删一条）→ `syncDerivedTracks`
 *      级数轨是纯派生数据，不承载用户编辑；此时若也全量重建，
 *      用户在和弦轨上的改名/拖动/删除和撤销历史会**一起丢失**。
 */
/**
 * 编辑层什么时候全量重建 —— **只看分析指纹**，不看 `props.tracks`。
 *
 * ## 为什么不能用「tracks 结构变了」当判据
 *
 * `tracks` 里现在包含**用户编辑过的和弦**（父组件把落盘的编辑盖回
 * 分析结果上）。于是会变成：
 *
 *   用户改一个和弦 → emit → 父组件存盘 → tracks 重算（含这次编辑）
 *   → 结构变了 → resetTracks → 撤销历史清空 → 又 emit 一次
 *
 * 编辑一次丢一次历史，还多写一次盘。所以判据必须是**分析指纹**：
 * 它只在切歌或重新分析后变化，跟用户编辑无关。
 *
 * 父组件传 `${songId}:${分析指纹}` —— 带 songId 是防止两首歌恰好
 * 拍数/段数/时长全一样时漏掉重建。
 */
watch(
  // 判据是**分析指纹**，不是 tracks 结构 —— 后者包含用户编辑，
  // 会让「改一个和弦 → 重建 → 丢历史」形成循环。见上方注释。
  () => props.analysisKey,
  () => {
    editing.resetTracks(toEditableTracks(props.tracks));
  },
);

/**
 * 只换级数轨（改调性 / 加一条 / 删一条）→ 只重建级数轨。
 *
 * **保留用户在和弦轨上的编辑和撤销历史**。之前这里和上面共用一个
 * `watch(() => props.tracks, ..., { deep: true })`，结果是用户改一次
 * 级数轨调性，之前所有和弦改名 / 拖动 / 删除全部丢失。
 */
watch(
  () => props.tracks
    .filter((t) => t.kind === 'degree')
    .map((t) => t.id + '@' + (t.degreeTonic ?? '') + (t.degreeMode ?? ''))
    .join('|'),
  () => {
    editing.syncDerivedTracks(toEditableTracks(props.tracks));
  },
);


function xToTickFloatLocal(x: number): number {
  return x / viewport.value.pixelsPerTick + viewport.value.scrollTick;
}

// ---------------------------------------------------------------- 视口状态
const contentRef = ref<HTMLDivElement | null>(null);
const gridCanvasRef = ref<HTMLCanvasElement | null>(null);
/**
 * 内容区宽度。
 *
 * 初始值用 **0** 而不是猜一个 1200：
 *   - 猜的值会和真实值"撞车"（真实恰好接近 1200 时，`w !== width` 不成立，
 *     于是某些「宽度变了才处理」的逻辑被跳过）
 *   - 任何用 width 算出来的东西都会基于假数据，看起来能跑、其实是错的
 * 0 表示"还不知道"，各处按"无效宽度"处理，等 ResizeObserver 给真值。
 */
const width = ref(0);

/**
 * 视口占位值。
 *
 * 只是为了让 `viewport.value` 在拿到真实宽度前不为 null —— 此时
 * `width = 0`，任何渲染都不会发生（见 `clampViewport` / 绘制入口的守卫）。
 * 真正有意义的值由 `initViewport()` 在拿到真实宽度后算出。
 */
const viewport = ref<Viewport>(createViewport(MIN_PIXELS_PER_TICK, 0, 1));

/**
 * 初始缩放：显示前 DEFAULT_VISIBLE_BARS 个小节。
 *
 * 不用 fitToContent(全部 40 小节)：那样每个和弦块只有 ~22px，
 * 放不下和弦名，第一眼看不到任何文字，反而像坏了。
 * 真实编辑器也应默认"能读清内容"的缩放，而不是"塞下全部"。
 */
const DEFAULT_VISIBLE_BARS = 16;

/**
 * 按「显示前 DEFAULT_VISIBLE_BARS 小节」重算视口。
 *
 * ⚠️ **宽度为 0 时必须放弃**，不能拿它去算 `pixelsPerTick`。
 *
 * 踩过的坑：`onMounted` 里 DOM 已经挂上，但布局未必完成，
 * `clientWidth` 经常还是 0。这时 `w / visibleTicks = 0`，
 * 再经 `Math.max(MIN_PIXELS_PER_TICK, 0)` 就**夹到了最小缩放** ——
 * 一屏能塞下 178 小节，每个和弦块只有几个像素，字全看不见。
 *
 * 更麻烦的是它「看起来像是生效了」：ResizeObserver 随后会把 `width`
 * 纠正成真实值，但**不会重算 `pixelsPerTick`**，于是错误缩放被永久留下，
 * 顶栏一直显示 9%。
 *
 * 所以：宽度无效就直接返回，交给 ResizeObserver 的首次回调去做。
 */
function initViewportWith(w: number): boolean {
  if (!(w > 0)) return false;
  width.value = w;
  const visibleTicks = tickOfBar(meterMap, DEFAULT_VISIBLE_BARS);
  const ppt = Math.min(
    MAX_PIXELS_PER_TICK,
    Math.max(MIN_PIXELS_PER_TICK, w / visibleTicks),
  );
  viewport.value = clampViewport(createViewport(ppt, 0, w));
  return true;
}

/** 用当前 DOM 宽度初始化视口（宽度无效时返回 false，等 ResizeObserver） */
function initViewport(): boolean {
  return initViewportWith(contentRef.value?.clientWidth ?? 0);
}

/** 缩放到能看到整首曲子（工具栏"适应宽度"按钮用） */
function zoomFitAll() {
  viewport.value = clampViewport(fitToContent(viewport.value, totalTicks.value));
}

/**
 * 内容区宽度变化 → 按比例调整缩放，**保持「可见小节数」不变**。
 *
 * ## 为什么不只是更新 width
 *
 * `pixelsPerTick` 是"每 tick 多少像素"，它和宽度共同决定"一屏显示几小节"：
 *
 *     可见小节数 = width / (pixelsPerTick × 3840)
 *
 * 只改 width、不改 ppt，可见小节数就会变。实测踩坑：
 * 初始化时布局还没完成，拿到的宽度是 1154px（真实是 1560px），
 * 算出 ppt = 1154/(16×3840)；之后宽度纠正成 1560，
 * 一屏就变成了 21.6 小节 —— 顶栏显示 74%（相对 16 小节基准），
 * 而且往后每次改窗口尺寸，缩放都会漂。
 *
 * 所以宽度变化时按 `新宽/旧宽` 同比缩放 ppt，用户看到的"显示多少小节"
 * 保持不变。这也符合直觉：把窗口拉宽，应该看到更多像素、同样多的小节，
 * 而不是把内容缩小塞更多小节进来。
 */
watch(width, (w, prevW) => {
  const vp = viewport.value;
  // 视口宽度已经等于新宽度 → 是 initViewportWith 自己设置的，不要重复缩放
  if (vp.width === w) return;
  if (!(prevW > 0) || !(w > 0) || w === prevW) {
    viewport.value = { ...vp, width: w > 0 ? w : vp.width };
    return;
  }
  const scaled = clampZoom(vp.pixelsPerTick * (w / prevW));
  viewport.value = clampViewport({ ...vp, pixelsPerTick: scaled, width: w });
});

/**
 * 曲目长度变了 → 重新夹一遍视口。
 *
 * 挂载时 `totalTicks` 常常是 0（分析还没完成），此时 `clampViewport` 把
 * `scrollTick` 咬死在 0。等谱面到位、总长变成 199 小节后，虽然滑块能拖了，
 * 但当前视口仍是"0 长"时代的残留状态；同时 `pixelsPerTick` 也可能因为
 * 用户之前点过「适应宽度」而针对旧长度算过，需要按新长度重算。
 *
 * 只在长度**真的变化**时处理，避免和用户的缩放操作打架。
 */
watch(
  () => props.totalTicks,
  (next, prev) => {
    if (next === prev) return;
    // 长度变了就重新夹取，保证 scrollTick 在新范围内
    viewport.value = clampViewport({ ...viewport.value });
    scheduleDraw();
  },
);

// ---------------------------------------------------------------- 播放时自动滚动

/**
 * 跟随播放头滚动（DAW 的 "follow playhead" 功能）。
 *
 * 策略：**翻页式**（page scroll），不是居中式。
 *   - 播放头越过视口 85% 位置 → 滚动让它出现在 15% 位置
 *   - 只在**播放中**触发，暂停时不滚（否则用户没法手动浏览）
 *   - 播放头在视口外（比如用户手动滚远了）→ 也拉回来
 *
 * 为什么不用居中跟随：居中会让整个画面持续移动，长时间观看容易晕；
 * 翻页式大部分时间是静止的，只在跨屏时跳一下，更符合阅读习惯。
 */
const FOLLOW_TRIGGER_RATIO = 0.85;
const FOLLOW_LANDING_RATIO = 0.15;

watch(
  () => props.playheadTick,
  (tick) => {
    if (!props.autoScroll || !props.playing || tick == null) return;

    const vp = viewport.value;
    const x = tickToX(vp, tick);
    const triggerX = vp.width * FOLLOW_TRIGGER_RATIO;

    // 播放头在视口右侧过远，或已跑出视口
    if (x > triggerX || x < 0) {
      const landingPx = vp.width * FOLLOW_LANDING_RATIO;
      const nextScroll = tick - landingPx / vp.pixelsPerTick;
      viewport.value = clampViewport({ ...vp, scrollTick: nextScroll });
    }
  },
);

// ---------------------------------------------------------------- 网格绘制
function drawGrid() {
  const canvas = gridCanvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = width.value;
  const h = canvas.clientHeight || 600;

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const vp = viewport.value;
  const range = visibleRange(vp, 0.3);
  const pxPerBeat = vp.pixelsPerTick * 960;

  // ---- 拍线（只在足够放大时画）
  if (pxPerBeat >= 6) {
    ctx.strokeStyle = COLORS.gridBeat;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const firstBar = barAt(meterMap, range.startTick);
    const lastBar = barAt(meterMap, range.endTick);
    for (let b = firstBar; b <= lastBar; b++) {
      for (const beatTick of beatLinesInBar(meterMap, b)) {
        if (beatTick < range.startTick || beatTick > range.endTick) continue;
        const x = snapPxLine(tickToX(vp, beatTick));
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
    }
    ctx.stroke();
  }

  // ---- 小节线
  //
  // ⚠️ 必须按 `props.totalTicks` 截止。
  //
  // `barLinesInRange` 只会按**可见范围**画（默认最多 4000 条），
  // 它不知道这首歌有多长。空谱面（totalTicks = 0）时可见范围仍有几百小节，
  // 于是整屏铺满小节线 —— 看起来还是一首正经的歌，用户根本无法判断
  // 「这首歌还没分析」。裁剪到 totalTicks 之后，空态就是一片干净的空白。
  const lines = barLinesInRange(meterMap, range.startTick, range.endTick).filter(
    (line) => line.tick <= totalTicks.value,
  );
  for (const line of lines) {
    const x = snapPxLine(tickToX(vp, line.tick));
    const isChange = line.isMeterChange;
    ctx.strokeStyle = isChange
      ? COLORS.trackDegree
      : line.barIndex % 4 === 0
        ? COLORS.gridBarStrong
        : COLORS.gridBar;
    ctx.lineWidth = isChange ? 2 : line.barIndex % 4 === 0 ? 1.4 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // ---- 播放头
  if (props.playheadTick != null) {
    const x = tickToX(vp, props.playheadTick);
    if (x >= -2 && x <= w + 2) {
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(snapPxLine(x), 0);
      ctx.lineTo(snapPxLine(x), h);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------- 标尺绘制
const rulerCanvasRef = ref<HTMLCanvasElement | null>(null);
/**
 * 绘制标尺 —— 小节号 + 拍刻度。
 *
 * 层次（自上而下）：
 *   1. 小节号文本（每 1/2/4/8 小节标一次，随缩放自适应）
 *   2. 节拍分组线（每 4 小节一根，稍深）
 *   3. 拍刻度：强拍（小节第一拍）长、弱拍短
 *
 * 设计稿里标尺在轨道上方、贴着第一条轨道，高度约 30px。
 */
/**
 * 绘制标尺 —— 小节号 + 拍刻度。
 *
 * 层次（自上而下）：
 *   小节号文本（顶部 4px 起）
 *   ↓
 *   拍刻度：强拍（小节第一拍）长 11px、弱拍短 6px
 *   底部贴边有一条基线
 *
 * 节拍组：每 4 小节加粗一次，便于扫读。
 * 缩放很小的时候自动稀疏小节号（1/2/4/8 小节一标）。
 */
function drawRuler() {
  const canvas = rulerCanvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = width.value;
  const h = SIZES.rulerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const vp = viewport.value;
  const range = visibleRange(vp, 0.2);
  const barPx = vp.pixelsPerTick * 3840;
  const beatPx = barPx / 4;

  const firstBar = Math.max(0, barAt(meterMap, range.startTick) - 1);
  /**
   * 小节号不该画到歌曲之外。
   *
   * 空谱面（还没分析完）时 `totalTicks = 0`，若仍按可见范围画，
   * 标尺会出现 1、2、3……一路到几百，看着像一首超长的歌。
   * 截断到「歌曲实际最后一个小节」可以一眼看出这是空态。
   */
  const lastBarBySong = Math.floor(totalTicks.value / 3840);
  const lastBar = Math.min(barAt(meterMap, range.endTick) + 1, Math.max(0, lastBarBySong));

  // ---- 1) 弱拍刻度（最短，从底部往上 6px）
  if (beatPx >= 6) {
    ctx.strokeStyle = COLORS.gridBar;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let b = firstBar; b <= lastBar; b++) {
      const bStart = tickOfBar(meterMap, b);
      const meter = meterAt(meterMap, bStart);
      const beatTick = (960 * 4) / meter.denominator;
      for (let k = 1; k < meter.numerator; k++) {
        const t = bStart + k * beatTick;
        if (t < range.startTick || t > range.endTick) continue;
        const x = snapPxLine(tickToX(vp, t));
        ctx.moveTo(x, h - 7);
        ctx.lineTo(x, h);
      }
    }
    ctx.stroke();
  }

  /**
   * ---- 1b) **拍号**（1 / 2 / 3 / 4）
   *
   * 只有刻度线的话，用户没法一眼判断「这个和弦落在第几拍上」。
   * 拍是一个**时刻**，标上序号才看得出它属于小节的第几拍。
   *
   * 数字画在**该拍的区间中点**（`x + beatPx/2`），不是压在刻度线上 ——
   * 刻度线是拍的起点，数字代表这一整拍的位置。
   *
   * 空间不够（`beatPx < 22`）时整体隐藏：挤在一起反而看不清。
   */
  if (beatPx >= 22) {
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `500 10px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const labelY = h - 15;
    for (let b = firstBar; b <= lastBar; b++) {
      const bStart = tickOfBar(meterMap, b);
      const meter = meterAt(meterMap, bStart);
      const beatTick = (960 * 4) / meter.denominator;
      for (let k = 0; k < meter.numerator; k++) {
        const t = bStart + k * beatTick;
        if (t < range.startTick || t > range.endTick) continue;
        const x = snapPxLine(tickToX(vp, t)) + beatPx / 2;
        if (x < -20 || x > w + 20) continue;
        // 第 1 拍加粗一点：它是小节的锚点
        ctx.fillStyle = k === 0 ? COLORS.textSecondary : COLORS.textMuted;
        ctx.fillText(String(k + 1), x, labelY);
      }
    }
    ctx.textAlign = 'start';
  }

  // ---- 2) 小节刻度（强拍，11px）+ 小节号
  const step = barPx < 14 ? 8 : barPx < 28 ? 4 : barPx < 56 ? 2 : 1;

  for (let b = firstBar; b <= lastBar; b++) {
    const tick = tickOfBar(meterMap, b);
    if (tick < range.startTick - 3840 || tick > range.endTick + 3840) continue;
    const x = snapPxLine(tickToX(vp, tick));
    if (x < -40 || x > w + 40) continue;

    const isGroup = b % 4 === 0;

    // 强拍刻度线
    ctx.strokeStyle = isGroup ? COLORS.textSecondary : COLORS.textMuted;
    ctx.lineWidth = isGroup ? 1.2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, h - 13);
    ctx.lineTo(x, h);
    ctx.stroke();

    // 小节号
    const showNum = b % step === 0 || isGroup;
    if (showNum) {
      ctx.fillStyle = isGroup ? COLORS.textPrimary : COLORS.textMuted;
      ctx.font = `${isGroup ? '600 ' : '400 '}${SIZES.rulerFont} system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(String(b + 1), x + 4, 3);
    }
  }

  // ---- 3) 底部基线
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(w, h - 0.5);
  ctx.stroke();

  // ---- 4) 播放头标记（橙色三角 + 竖线贯穿标尺）
  if (props.playheadTick != null) {
    const x = tickToX(vp, props.playheadTick);
    if (x >= -6 && x <= w + 6) {
      // 竖线
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(snapPxLine(x), 0);
      ctx.lineTo(snapPxLine(x), h);
      ctx.stroke();
      // 三角
      ctx.fillStyle = COLORS.playhead;
      ctx.beginPath();
      ctx.moveTo(x - 4.5, h - 9);
      ctx.lineTo(x + 4.5, h - 9);
      ctx.lineTo(x, h - 1);
      ctx.closePath();
      ctx.fill();
    }
  }
}

let raf = 0;
function scheduleDraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    drawGrid();
    drawRuler();
  });
}

watch([viewport, () => props.playheadTick], scheduleDraw, { deep: true });

// ---------------------------------------------------------------- 滚动 / 缩放交互

/** 内容总像素宽（含一点右侧留白，让最后一小节不贴边） */
const contentPx = computed(() => {
  const vp = viewport.value;
  return (totalTicks.value + 3840 * 2) * vp.pixelsPerTick;
});

/** 可滚动的最大 scrollTick */
const maxScrollTick = computed(() => {
  const vp = viewport.value;
  const visibleTicks = vp.width / vp.pixelsPerTick;
  return Math.max(0, totalTicks.value + 3840 * 2 - visibleTicks);
});

/** 把 scrollTick 夹到合法范围 */
function clampViewport(vp: Viewport): Viewport {
  const visibleTicks = vp.width / vp.pixelsPerTick;
  const maxScroll = Math.max(0, totalTicks.value + 3840 * 2 - visibleTicks);
  const t = Math.min(Math.max(0, vp.scrollTick), maxScroll);
  return t === vp.scrollTick ? vp : { ...vp, scrollTick: t };
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const rect = contentRef.value?.getBoundingClientRect();
  const x = e.clientX - (rect?.left ?? 0);

  if (e.ctrlKey || e.metaKey) {
    // Ctrl+滚轮 = 以鼠标位置为锚点缩放
    const factor = Math.exp(-e.deltaY * 0.002);
    viewport.value = clampViewport(zoomAtX(viewport.value, x, factor));
  } else {
    // 普通滚轮 = 横向滚动
    viewport.value = clampViewport(scrollByPixels(viewport.value, e.deltaY + e.deltaX));
  }
}

// ---------------------------------------------------------------- 横向滚动条
const scrollRef = ref<HTMLDivElement | null>(null);

/** 滑块宽度占轨道的比例 */
const scrollThumbRatio = computed(() => {
  const vp = viewport.value;
  const total = contentPx.value;
  return Math.min(1, vp.width / Math.max(1, total));
});

/** 滑块左边位置占轨道的比例（0 ~ 1-thumbRatio） */
const scrollThumbLeft = computed(() => {
  const vp = viewport.value;
  const max = maxScrollTick.value;
  if (max <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, vp.scrollTick / max));
  // 把 0..1 映射到 0..(1-thumb)
  return ratio * (1 - scrollThumbRatio.value);
});

const canScroll = computed(() => scrollThumbRatio.value < 0.999);

let dragging = false;
let dragStartX = 0;
let dragStartScroll = 0;
let dragTrackW = 1;

function onThumbDown(e: PointerEvent) {
  if (!canScroll.value) return;
  const track = scrollRef.value;
  if (!track) return;
  dragging = true;
  dragStartX = e.clientX;
  dragStartScroll = viewport.value.scrollTick;
  dragTrackW = track.clientWidth;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onThumbMove(e: PointerEvent) {
  if (!dragging) return;
  // 滑块移动的像素 → scrollTick 的换算：
  // 滑块可移动的轨道长度 = trackW * (1 - thumbRatio)
  // 对应的 scrollTick 范围 = maxScrollTick
  const thumbRatio = scrollThumbRatio.value;
  const movablePx = dragTrackW * (1 - thumbRatio);
  if (movablePx <= 0) return;
  const deltaPx = e.clientX - dragStartX;
  const ratio = deltaPx / movablePx;
  const next = dragStartScroll + ratio * maxScrollTick.value;
  viewport.value = { ...viewport.value, scrollTick: Math.max(0, Math.min(maxScrollTick.value, next)) };
}

function onThumbUp(e: PointerEvent) {
  if (!dragging) return;
  dragging = false;
  try {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

/** 点击滚动条轨道空白处 → 翻页 */
function onTrackDown(e: PointerEvent) {
  if (e.target !== e.currentTarget) return; // 点在滑块上交给 onThumbDown
  const track = scrollRef.value;
  if (!track || !canScroll.value) return;
  const rect = track.getBoundingClientRect();
  const x = e.clientX - rect.left;
  // 点在哪就让滑块中心到哪
  const thumbPx = dragTrackW * 0 + rect.width * scrollThumbRatio.value;
  const movablePx = rect.width - thumbPx;
  const ratio = Math.min(1, Math.max(0, (x - thumbPx / 2) / Math.max(1, movablePx)));
  viewport.value = { ...viewport.value, scrollTick: ratio * maxScrollTick.value };
}

/** 键盘左右键滚动（滚轮之外的补充操作） */
function onKeyScroll(e: KeyboardEvent) {
  const step = viewport.value.width / viewport.value.pixelsPerTick * 0.5;
  if (e.key === 'ArrowRight') {
    viewport.value = clampViewport({ ...viewport.value, scrollTick: viewport.value.scrollTick + step });
  } else if (e.key === 'ArrowLeft') {
    viewport.value = clampViewport({ ...viewport.value, scrollTick: viewport.value.scrollTick - step });
  }
}

// ---------------------------------------------------------------- 标尺：点击/拖拽定位播放位置

/**
 * 点击标尺任意位置 → 播放头跳过去。
 *
 * 实现要点：
 *   - 用 `xToTickFloat` 换算（浮点），再 round，避免取整误差累积
 *   - 拖动时**连续 seek**（scrub），松手才结束监听
 *   - clamp 到 `[0, totalTicks]`，点右侧空白不会跑到内容外
 *   - 用 window 级监听，拖出标尺也能继续
 */
function tickFromRulerX(x: number): number {
  const vp = viewport.value;
  const raw = x / vp.pixelsPerTick + vp.scrollTick;
  return Math.max(0, Math.min(totalTicks.value, Math.round(raw)));
}

function onRulerPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const rect = rulerCanvasRef.value?.getBoundingClientRect();
  if (!rect) return;

  const seekAt = (clientX: number) => {
    emit('seek-tick', tickFromRulerX(clientX - rect.left));
  };
  seekAt(e.clientX);

  const onMove = (ev: PointerEvent) => seekAt(ev.clientX);
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  e.preventDefault();
}

// ---------------------------------------------------------------- 指针交互（拖动 / Resize / 接缝）

/** 正在拖动的手势类型（用于设置光标） */
const cursorStyle = computed(() => {
  const g = editing.gesture.value;
  if (g.phase === 'idle') return 'default';
  switch (g.kind) {
    case 'resizeLeft':
    case 'resizeRight':
    case 'seam':
      return 'ew-resize';
    case 'move':
      return 'grabbing';
    default:
      return 'default';
  }
});

function onTrackPointerDown(e: PointerEvent, track: RealTrack) {
  if (e.button !== 0) return;
  // 级数解释轨：时间只读（PRD §4.7），只允许选中
  if (track.kind === 'degree') {
    const el = (e.target as HTMLElement).closest('.clip') as HTMLElement | null;
    if (el?.dataset.clipId) editing.selectedId.value = el.dataset.clipId;
    return;
  }

  const contentEl = contentRef.value;
  if (!contentEl) return;
  const rect = contentEl.getBoundingClientRect();
  const x = e.clientX - rect.left;

  editing.onPointerDown(track.id, x, e.clientY - rect.top, e.clientX, {
    alt: e.altKey,
    shift: e.shiftKey,
  });

  /**
   * 用 **window 级监听** 而不是 setPointerCapture。
   *
   * 为什么：setPointerCapture 会把后续 pointerup 的 target 重定向到
   * 捕获元素（这里是 .track-row），导致：
   *   - click 的 target 变成 track-row（pointerdown 在 clip 上，up 在 row 上，
   *     浏览器取共同祖先）
   *   - dblclick 同样失效 → 「双击就地编辑」永远不触发
   *
   * window 级监听既保证拖出元素仍能收到 move/up，又不干扰 click/dblclick。
   */
  const onMove = (ev: PointerEvent) => {
    editing.onPointerMove(ev.clientX - rect.left, { alt: ev.altKey });
  };
  const onUp = () => {
    editing.onPointerUp();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };
  const onCancel = () => {
    editing.cancelGesture();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}

// ---------------------------------------------------------------- 右键菜单

interface CtxState {
  x: number;
  y: number;
  trackId: string;
  clipId: string | null;
  tick: number;
}
const ctxMenu = ref<CtxState | null>(null);

/** 正在改名的结构段 id（弹字典选择器） */
const sectionRenameFor = ref<string | null>(null);
/** 正在设调性的结构段 id（弹 KeyPicker） */
const sectionKeyFor = ref<string | null>(null);

/** 弹层里显示的当前值 */
const sectionRenameValue = computed(() =>
  sectionRenameFor.value ? (editing.clipById(sectionRenameFor.value)?.label ?? '') : '',
);
const sectionKeyValue = computed(() => {
  const id = sectionKeyFor.value;
  if (!id) return { tonic: 'C', mode: 'major' as const };
  const c = editing.clipById(id) as { key?: { tonic: string; mode: 'major' | 'minor' } } | null;
  return c?.key ?? { tonic: props.keyTonic || 'C', mode: props.keyMode ?? 'major' };
});

/**
 * 结构段改名 / 设调性 —— **直接改编辑层**。
 *
 * ## 为什么不能走「emit 给父组件改 edits」
 *
 * 渲染读的是 `editing.effectiveClips`（编辑层快照），不是 `props.tracks`。
 * 父组件改 `edits.sections` 只会让 props 变、编辑层不动 ——
 * 界面上完全没反应，用户看到的就是「点了不起作用」。
 *
 * 改完 `clipsByTrack` 后，`section-edits-change` 的 watch 会自动上报落盘。
 */
function applySectionRename(label: string) {
  const id = sectionRenameFor.value;
  sectionRenameFor.value = null;
  if (id) editing.setLabel(id, label);
}

function applySectionKey(v: { tonic: string; mode: 'major' | 'minor' }) {
  const id = sectionKeyFor.value;
  sectionKeyFor.value = null;
  if (id) editing.setSectionKey(id, v);
}

const currentDictionary = ref<'submission' | 'ismir2017' | 'full'>('submission');

/** 右键点在哪条轨上（决定给哪套菜单） */
const ctxTrack = computed(() =>
  props.tracks.find((t) => t.id === ctxMenu.value?.trackId) ?? null,
);

/**
 * 结构轨的菜单。
 *
 * ## 为什么必须和和弦轨分开
 *
 * 之前两者共用一套菜单，于是结构段右键出来是「在此新建和弦」
 * 「编辑和弦名」「用其它档位重新分析此段」—— 对结构段全是错的语义，
 * 而且真正需要的「设置这段的调性」根本没有入口。
 *
 * 两套轨道的数据含义、可做的操作、以及用户此刻的意图都不同，
 * 菜单必须按轨道类型分派。
 */
function sectionMenuItems(hasClip: boolean): MenuItem[] {
  return [
    { id: 'sec-create', label: '在此新建结构段', shortcut: 'N' },
    { id: 'sec-rename', label: '重命名…', disabled: !hasClip },
    { id: 'divider-k', label: '', divider: true },
    {
      id: 'sec-key',
      label: '设置此段调性…',
      disabled: !hasClip,
      // 标注这段转调了，级数按该调理解（MenuItem 没有 hint 字段，说明写注释里）
    },
    { id: 'sec-key-clear', label: '清除此段调性', disabled: !hasClip },
    { id: 'divider-e', label: '', divider: true },
    { id: 'sec-split', label: '在播放头处拆分', shortcut: 'S', disabled: !hasClip },
    { id: 'sec-merge', label: '与下一段合并', shortcut: 'J', disabled: !hasClip },
    { id: 'divider-r', label: '', divider: true },
    { id: 'sec-restore', label: '恢复为 AI 结构' },
    { id: 'sec-delete', label: '删除此段', shortcut: 'Del', danger: true, disabled: !hasClip },
  ];
}

const menuItems = computed<MenuItem[]>(() => {
  const st = ctxMenu.value;
  if (!st) return [];

  // 结构轨和和弦轨是两种东西，菜单直接分派（见 sectionMenuItems 的说明）
  if (ctxTrack.value?.kind === 'section') {
    return sectionMenuItems(!!st.clipId);
  }


  if (!st.clipId) {
    return [
      { id: 'create', label: '在此新建和弦', shortcut: 'N' },
      { id: 'paste', label: '粘贴', shortcut: 'Ctrl+V', disabled: true },
      { id: 'divider-1', label: '', divider: true },
      {
        id: 'snap',
        label: '吸附设置',
        children: [
          { id: 'snap-off', label: '关闭吸附', checked: !editing.snapConfig.value.enabled },
          { id: 'snap-1', label: '1/1 拍', checked: editing.snapConfig.value.gridDivision === 1 },
          { id: 'snap-2', label: '1/2 拍', checked: editing.snapConfig.value.gridDivision === 2 },
          { id: 'snap-4', label: '1/4 拍', checked: editing.snapConfig.value.gridDivision === 4 },
          { id: 'snap-8', label: '1/8 拍', checked: editing.snapConfig.value.gridDivision === 8 },
          { id: 'snap-3', label: '1/3 拍（三连音）', checked: editing.snapConfig.value.gridDivision === 3 },
        ],
      },
    ];
  }

  const clip = editing.clipById(st.clipId);
  if (!clip) return [];

  const isDegree = st.trackId.includes('degree');

  return [
    { id: 'edit', label: isDegree ? '编辑级数解释' : '编辑和弦名', shortcut: 'Enter' },
    { id: 'divider-1', label: '', divider: true },
    {
      id: 'reanalyze',
      label: '用其它档位重新分析此段',
      disabled: isDegree,
      children: [
        { id: 'reanalyze-submission', label: 'submission（默认）', checked: currentDictionary.value === 'submission' },
        { id: 'reanalyze-ismir2017', label: 'ismir2017（抹掉转位）', checked: currentDictionary.value === 'ismir2017' },
        { id: 'reanalyze-full', label: 'full（爵士、复杂和声）', checked: currentDictionary.value === 'full' },
      ],
    },
    { id: 'revert', label: '恢复为 AI 原始结果', disabled: true },
    { id: 'divider-3', label: '', divider: true },
    { id: 'split', label: '在播放头处拆分', shortcut: 'S', disabled: isDegree },
    { id: 'merge', label: '合并到下一个', shortcut: 'J', disabled: isDegree },
    { id: 'divider-4', label: '', divider: true },
    { id: 'delete', label: '删除', shortcut: 'Del', danger: true, disabled: isDegree },
  ];
});

function onTrackContextMenu(e: MouseEvent, track: RealTrack) {
  e.preventDefault();
  const contentEl = contentRef.value;
  if (!contentEl) return;
  const rect = contentEl.getBoundingClientRect();
  const xInContent = e.clientX - rect.left;
  const tick = Math.round(xInContent / viewport.value.pixelsPerTick + viewport.value.scrollTick);

  const el = (e.target as HTMLElement).closest('.clip') as HTMLElement | null;
  const clipId = el?.dataset.clipId ?? null;
  if (clipId) editing.selectedId.value = clipId;

  ctxMenu.value = { x: e.clientX, y: e.clientY, trackId: track.id, clipId, tick };
}

function onMenuSelect(id: string) {
  const st = ctxMenu.value;
  if (!st) return;

  if (id.startsWith('snap-')) {
    const v = id.slice(5);
    editing.snapConfig.value = {
      ...editing.snapConfig.value,
      enabled: v !== 'off',
      gridDivision:
        v === 'off'
          ? editing.snapConfig.value.gridDivision
          : (Number(v) as 1 | 2 | 3 | 4 | 6 | 8 | 12 | 16),
    };
    ctxMenu.value = null;
    return;
  }
  if (id.startsWith('reanalyze-')) {
    currentDictionary.value = id.slice('reanalyze-'.length) as 'submission' | 'ismir2017' | 'full';
    ctxMenu.value = null;
    return;
  }

  // ---- 结构轨专用操作
  if (id.startsWith('sec-')) {
    switch (id) {
      case 'sec-create':
        // 新建一段：从点击处分 4 小节（一个乐句），太短的话用户还得再拖
        // 默认 8 小节（一段乐句的典型长度），并且不越过曲末
        editing.createAt(
          st.trackId,
          st.tick,
          'Interlude',
          Math.max(4 * 960, Math.min(8 * 4 * 960, props.totalTicks - st.tick)),
        );
        break;
      case 'sec-rename':
        // 弹层在**本组件内**，选完直接改编辑层。
        // 不要绕 `emit → 父组件改 edits → props 变` —— 那条路改不到
        // 编辑层的快照，界面上不会有任何反应（踩过）。
        if (st.clipId) sectionRenameFor.value = st.clipId;
        break;
      case 'sec-key':
        if (st.clipId) sectionKeyFor.value = st.clipId;
        break;
      case 'sec-key-clear':
        if (st.clipId) editing.setSectionKey(st.clipId, undefined);
        break;
      case 'sec-split':
        if (st.clipId) editing.splitAt(st.clipId, props.playheadTick ?? 0);
        break;
      case 'sec-merge':
        if (st.clipId) editing.mergeWithNext(st.clipId);
        break;
      case 'sec-delete':
        if (st.clipId) editing.deleteClip(st.clipId);
        break;
      case 'sec-restore':
        emit('restore-ai-sections');
        break;
    }
    ctxMenu.value = null;
    return;
  }

  switch (id) {
    case 'create':
      editing.createAt(st.trackId, st.tick, st.trackId.includes('chord') ? 'N' : '新');
      break;
    case 'edit': {
      // 选中它，并请父组件把焦点放到检查器的输入框
      if (st.clipId) {
        editing.selectedId.value = st.clipId;
        emit('request-edit', st.clipId);
      }
      break;
    }
    case 'split':
      if (st.clipId) editing.splitAt(st.clipId, props.playheadTick ?? 0);
      break;
    case 'merge':
      if (st.clipId) editing.mergeWithNext(st.clipId);
      break;
    case 'delete':
      if (st.clipId) editing.deleteClip(st.clipId);
      break;
  }
  ctxMenu.value = null;
}

/**
 * 双击：**块上只选中，空白处新建**。
 *
 * 块上不再做「就地编辑」—— 改名统一走右侧检查器的输入框：
 *   - 就地编辑的输入框很窄（块可能只有 20px 宽），长和弦名看不全
 *   - 而且它和候选和弦是两套入口，用户得记「改字双击、换和弦点右侧」
 *   - 检查器里既能点候选、也能手填，一个地方就够了
 *
 * 空白处新建保留：这是唯一的建块入口。
 */
function onTrackDoubleClick(e: MouseEvent, track: RealTrack) {
  const contentEl = contentRef.value;
  if (!contentEl) return;

  const el = (e.target as HTMLElement).closest('.clip') as HTMLElement | null;
  if (el?.dataset.clipId) {
    // 块上：确保它被选中（检查器随之显示），不做就地编辑
    editing.selectedId.value = el.dataset.clipId;
    return;
  }

  // 空白处：新建
  const rect = contentEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const tick = Math.round(x / viewport.value.pixelsPerTick + viewport.value.scrollTick);
  editing.createAt(track.id, tick, track.kind === 'chord' ? 'N' : '新');
}

/** 键盘：Escape 取消手势，Delete 删除选中，Ctrl+Z/Y 撤销重做 */
function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    editing.cancelGesture();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (editing.selectedId.value) {
      editing.deleteClip(editing.selectedId.value);
      e.preventDefault();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    if (e.shiftKey) editing.redo();
    else editing.undo();
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    editing.redo();
    e.preventDefault();
  }
}

// ---------------------------------------------------------------- 片段渲染
interface RenderedClip {
  id: string;
  label: string;
  sublabel?: string;
  left: number;
  width: number;
  kind: TrackKind;
  state: string;
  selected: boolean;
  /** 宽度是否足够显示文字 */
  wide: boolean;
  /** 窄块（1 拍左右）：用更紧凑的排版 */
  narrow: boolean;
  /**
   * 模型未识别的和弦段（长的 `N`）。
   *
   * 和普通和弦块视觉上要能一眼分开 —— 它表示「这里应该有和弦但没识别出来」，
   * 而不是「这里是 N（无和弦）」。用户需要知道哪里要手动补。
   */
  unrecognized: boolean;
  confidence?: number;
  /** 该片段自己的背景/前景色（段落按名称取色） */
  bg: string;
  fg: string;
  /** 权威 tick 值（暴露到 DOM 供 E2E 精确校验） */
  startTick: number;
  endTick: number;
  /**
   * 级数块是否高亮（「这段该按我这条轨来读」）。
   *
   * 只在该块**所属结构段**标了调性、且**这条轨的调性正好匹配**时为 true。
   * 段没标调性、或标了但没有匹配的轨 → 一律不高亮（用户明确要求）。
   */
  keyMatch?: boolean;
  /** 结构段自己的调性（画块内徽章用） */
  sectionKey?: { tonic: string; mode: 'major' | 'minor' };
}

/**
 * 某个 tick 落在哪一段、那段标了什么调性。
 *
 * ## 为什么读编辑层而不是 `props.tracks`
 *
 * 用户拖动结构段边界后，段的位置在编辑层里。用静态数据查会把
 * 「拖完的段」和「标的调性」对到旧位置上去。
 *
 * ## 为什么取最内层（后面的优先）
 *
 * 结构段理论上不该重叠，但模型输出有时会给出交叠区间。
 * 后面的段是更晚出现的信息，取它更符合直觉。
 */
function sectionKeyAt(tick: number): { tonic: string; mode: 'major' | 'minor' } | undefined {
  const track = props.tracks.find((t) => t.kind === 'section');
  if (!track) return undefined;
  const live = editing.effectiveClips.value[track.id] as
    | (ClipState & { key?: { tonic: string; mode: 'major' | 'minor' } })[]
    | undefined;
  const source = live ?? track.clips;
  let found: { tonic: string; mode: 'major' | 'minor' } | undefined;
  for (const c of source) {
    if (tick >= c.startTick && tick < c.endTick) {
      const k = (c as { key?: { tonic: string; mode: 'major' | 'minor' } }).key;
      if (k?.tonic) found = k;
    }
  }
  return found;
}

function clipsFor(track: RealTrack): RenderedClip[] {
  const vp = viewport.value;
  const range = visibleRange(vp, 0.3);
  const out: RenderedClip[] = [];

  // 用 editing 的有效片段（含拖动预览），而不是 props 的静态数据
  const live = editing.effectiveClips.value[track.id] as ClipState[] | undefined;
  const source: ClipState[] = live ?? track.clips.map<ClipState>((c) => ({
    id: c.id, trackId: track.id, startTick: c.startTick, endTick: c.endTick,
    label: c.label, sublabel: c.sublabel, state: c.state, layer: track.layer,
  }));

  /**
   * 级数轨的标签**实时从父和弦派生**，不读存储的 `label`。
   *
   * 为什么：用户改和弦（点候选 / 手动选）后，级数必须跟着变。
   * 而 `label` 是生成轨道时算好写死的 —— 那时候还是「未识别」，
   * 解析不出级数就是空。如果渲染直接用它，改完和弦级数永远是空的
   * （用户报的「手动补了级数轨没同步」）。
   *
   * 时间范围已经靠 `parentId` 投影跟随了，标签也在这里派生，
   * 两者合起来 = 级数完全跟随父和弦。
   */
  const isDegreeTrack = track.kind === 'degree';
  /**
   * 级数轨用**它自己的**调性，不用全局 keyTonic。
   *
   * 用户可以加多条级数轨、每条指定不同调性（G 大调 / D 小调对照）。
   * 之前这里一律读 `props.keyTonic`，结果所有级数轨算出同一套级数 ——
   * 表现为「自定义级数轨跟着全曲主调一起变」。
   *
   * `?? ` 兜底是给老数据用的：早期生成的级数轨没有 `degreeTonic` 字段，
   * 那时确实只有全局调性一个来源。
   */
  const tonic = degreeTonicOf(track, props.keyTonic);

  /**
   * 级数块的副标题（块内右下角的小字）也要跟着当前调性走。
   *
   * 它原本是生成轨道时写死的 `${tonic} ${mode}`。用户手动改全局调性后，
   * 数字按新调性算了，小字还写着旧调性 —— 看上去就是「调号没换」。
   *
   * 自动轨没有 `degreeMode`，取全局的 `keyMode`。
   */
  const degreeSub = `${tonic} ${(track.degreeMode ?? props.keyMode) === 'minor' ? 'minor' : 'major'}`;

  /**
   * ## 级数轨：**完全从和弦轨实时派生**，不读自己的块列表
   *
   * 级数是纯派生数据（数字 = 父和弦 + 调性），它自己没有独立内容。
   * 之前渲染走的是「生成轨道时建好的一批空壳块」，于是：
   *
   *   用户手动新建一个和弦 → 级数轨上没有对应的块 → 那片区域空着
   *
   * （用户报的「此处和声为手动添加，级数不会自动同步出现」）
   *
   * 现在每个和弦块**当场**生成一个级数块，新增/删除和弦都自动反映。
   * 块 id 用 `轨道id::和弦id` 拼，保证稳定（选中态靠它）。
   */
  if (isDegreeTrack) {
    const chordTrack = props.tracks.find((t) => t.kind === 'chord');
    const chordClips = chordTrack ? (editing.effectiveClips.value[chordTrack.id] ?? []) : [];
    const style = trackStyle('degree');

    for (const cc of chordClips) {
      const eff = editing.projectedRange(cc);
      if (eff.end < range.startTick || eff.start > range.endTick) continue;
      const rect = tickRangeToIntRect(vp, eff.start, eff.end);
      if (rect.width <= 0) continue;

      const sectionKey = sectionKeyAt(eff.start);
      const keyMatch = shouldHighlightDegree(
        track,
        sectionKey,
        props.keyTonic ?? '',
        props.keyMode ?? 'major',
      );
      const cellId = `${track.id}::${cc.id}`;

      out.push({
        id: cellId,
        label: chordToNumber(cc.label, tonic) ?? '—',
        sublabel: degreeSub,
        left: rect.left,
        width: rect.width,
        kind: 'degree',
        state: cc.state ?? 'draft',
        selected: editing.selectedId.value === cellId,
        wide: rect.width >= 12,
        narrow: rect.width < 48,
        unrecognized: cc.label === UNRECOGNIZED_LABEL,
        confidence: cc.confidence,
        bg: style.bg,
        fg: style.fg,
        startTick: eff.start,
        endTick: eff.end,
        keyMatch,
      });
    }
    return out;
  }

  for (const c of source) {
    const visRange = editing.projectedRange(c);
    if (visRange.end < range.startTick || visRange.start > range.endTick) continue;
    /**
     * 级数解释的时间范围**从父和弦投影**（不存自己的 tick）。
     * 所以拖动/缩放父和弦时，级数块实时跟随；撤销时也自动回退。
     */
    const eff = editing.projectedRange(c);
    const rect = tickRangeToIntRect(vp, eff.start, eff.end);
    const span = { left: rect.left, width: rect.width };
    // 段落轨按段落名取色（Verse/Pre 淡橙、Chorus 深橙、Bridge 淡紫）
    const pal =
      track.kind === 'section'
        ? sectionColor(c.label)
        : { bg: trackStyle(track.kind).bg, fg: trackStyle(track.kind).fg };

    /**
     * 级数轨的标签实时派生：拿父和弦当前的 label 换算。
     * 解析不出来（未识别 / N / 残缺）就显示 `—`，
     * 而不是让块整个消失 —— 用户要能看到"这里有一条级数块等着被补"。
     */
    let displayLabel = c.label;
    if (isDegreeTrack) {
      const parent = c.parentId ? editing.clipById(c.parentId) : null;
      const chordLabel = parent?.label ?? '';
      displayLabel = chordToNumber(chordLabel, tonic) ?? '—';
    }

    /**
     * **段调性 → 块高亮**。
     *
     * 用户给某个结构段标了调性（例如 Chorus 是 G 大调），含义是
     * 「这段转调了，得按 G 大调那条级数轨来理解」。
     *
     * 所以高亮条件是**三条同时成立**：
     *   1. 这个块落在某段内，且该段标了调性
     *   2. 当前是级数轨
     *   3. 这条轨的调性 == 段调性
     *
     * 段**没标**调性 → 高亮**主级数轨**（它就是这段的默认解读）；
     * 标了但没有匹配的轨 → **不高亮任何轨道**。
     * 完整规则见 `shouldHighlightDegree` 的表格。
     *
     * 注意：这只影响**视觉**。级数的数字仍按轨道自己的调性算
     * （模式 A）—— 自动换调会让块内的数字在段边界突然跳变。
     */
    let keyMatch = false;
    let sectionKey: { tonic: string; mode: 'major' | 'minor' } | undefined;
    if (isDegreeTrack) {
      sectionKey = sectionKeyAt(eff.start);
      keyMatch = shouldHighlightDegree(
        track,
        sectionKey,
        props.keyTonic ?? '',
        props.keyMode ?? 'major',
      );
    }

    out.push({
      id: c.id,
      label: displayLabel,
      sublabel: isDegreeTrack ? degreeSub : c.sublabel,
      left: span.left,
      width: span.width,
      kind: track.kind,
      state: c.state ?? 'draft',
      selected: editing.selectedId.value === c.id,
      wide: span.width >= 12,
      narrow: span.width < 48,
      unrecognized: c.label === UNRECOGNIZED_LABEL,
      confidence: (c as unknown as { confidence?: number }).confidence,
      bg: pal.bg,
      fg: pal.fg,
      startTick: eff.start,
      endTick: eff.end,
      keyMatch,
      sectionKey: track.kind === 'section' ? (c as { key?: { tonic: string; mode: 'major' | 'minor' } }).key : undefined,
    });
  }
  return out;
}

function clipsOf(track: RealTrack) {
  return clipsFor(track);
}

function trackHeight(kind: TrackKind) {
  return kind === 'chord' ? SIZES.chordTrackHeight : SIZES.trackHeight;
}

function trackColor(kind: TrackKind) {
  const s = trackStyle(kind);
  return { fg: s.fg, bg: s.bg };
}

// ---------------------------------------------------------------- 生命周期
let ro: ResizeObserver | null = null;
/** 是否已经用**真实宽度**初始化过视口（首次布局完成前一直是 false） */
let viewportReady = false;
onMounted(() => {
  // 布局可能还没完成（clientWidth = 0），那时 initViewport 会返回 false，
  // 真正的初始化交给下面 ResizeObserver 的首次回调。
  viewportReady = initViewport();
  scheduleDraw();
  // 键盘监听挂在 window 上：时间轴本身不是可聚焦元素，
  // 挂在根节点上会导致 Ctrl+Z 收不到（焦点在 body）。
  window.addEventListener('keydown', onKeyDown);
  if (contentRef.value) {
    ro = new ResizeObserver(() => {
      const w = contentRef.value?.clientWidth ?? 0;
      if (w <= 0) return; // 布局中间态，忽略
      /**
       * 首次拿到宽度时无条件初始化（不能先比 `w !== width.value`，
       * 占位值可能恰好相等而跳过）。
       *
       * ⚠️ 但**首次的宽度本身也可能不准**：实测窗口 2179px 宽时，
       * ResizeObserver 首回调给的 `clientWidth` 是 1154，真实值是 1560 ——
       * 此时侧栏/检查器的宽度（含 localStorage 记忆值）还在应用，
       * 布局没稳定。
       *
       * 直接用它初始化，缩放就永远差一截：顶栏显示 74% 而不是 100%，
       * 一屏能装 21.6 小节而不是 16。
       *
       * 所以先用当前值顶上（界面不空白），再等两帧让布局彻底稳定，
       * 用最终宽度重新初始化一次。两帧是必要的：Vue 的样式绑定 +
       * 浏览器布局各占一帧。
       */
      if (!viewportReady) {
        viewportReady = true;
        initViewportWith(w);
        scheduleDraw();
        /**
         * 等两帧让布局彻底稳定，再用**最终宽度**重新初始化一次。
         *
         * 不直接 `width.value = finalW`：那会触发 `watch(width)` 的
         * 同比缩放，而首次的基准本身就是错的，同比会把错误一起放大。
         * 这里统一走 `initViewportWith`，它同时设置 width 和 ppt，
         * 一步算对。
         */
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const finalW = contentRef.value?.clientWidth ?? 0;
            if (finalW > 0 && finalW !== width.value) {
              initViewportWith(finalW);
              scheduleDraw();
            }
          });
        });
        return;
      }
      if (w !== width.value) {
        width.value = w;
      }
      scheduleDraw();
    });
    ro.observe(contentRef.value);
  }
});
onBeforeUnmount(() => {
  ro?.disconnect();
  window.removeEventListener('keydown', onKeyDown);
  if (raf) cancelAnimationFrame(raf);
});

// 布局变化后重绘
watch([viewport, width], scheduleDraw, { deep: true });

/** 供外部（工具栏）调用 */
function zoomIn() {
  viewport.value = clampViewport(zoomAtX(viewport.value, width.value / 2, 1.4));
}
function zoomOut() {
  viewport.value = clampViewport(zoomAtX(viewport.value, width.value / 2, 1 / 1.4));
}
/** 恢复默认视图（显示前 16 小节） */
function zoomReset() {
  initViewport();
}


/** 当前缩放比（相对 fit） */
const zoomPercent = computed(() => {
  // width = 0 表示布局还没完成，此时算不出有意义的百分比。
  // 不做守卫的话 base = 0 → 结果是 Infinity/NaN，滑块会跳到一个荒唐值。
  if (!(width.value > 0)) return 100;
  const base = width.value / tickOfBar(meterMap, DEFAULT_VISIBLE_BARS);
  if (!(base > 0)) return 100;
  return Math.round((viewport.value.pixelsPerTick / base) * 100);
});

/** 顶部 tag 轨的行高 */
const META_ROW_H = 26;

/** 标签式 tag 的定位（只给 left，宽度由内容决定） */
function labelLeft(tick: number): string {
  return snapPx(tickToX(viewport.value, tick)) + 'px';
}

/** 当前缩放（相对默认视图的百分比），供工具栏滑块显示 */
const zoomPercentRef = zoomPercent;

/** 设置到指定百分比（滑块用） */
function setZoomPercent(pct: number) {
  if (!(width.value > 0)) return; // 布局未完成，无法按百分比定位
  const base = width.value / tickOfBar(meterMap, DEFAULT_VISIBLE_BARS);
  const target = Math.max(1, pct) * 0.01 * base;
  const ppt = Math.max(MIN_PIXELS_PER_TICK, Math.min(MAX_PIXELS_PER_TICK, target));
  // 以视口中心为锚点
  viewport.value = clampViewport(
    zoomAtX(viewport.value, width.value / 2, ppt / viewport.value.pixelsPerTick),
  );
}

defineExpose({
  /**
   * 替换当前选中片段的文本（检查器点候选和弦时用）。
   *
   * 不在父组件里直接操作 `editing.selectedId` —— 那是 ref，
   * 跨组件 expose 后拿到的形状不稳定（.ref / .value / 裸值都可能），
   * 之前撤销按钮就踩过这个坑（见 `canUndoFlag` 的注释）。
   */
  setSelectedLabel: (label: string): boolean => {
    const id = editing.selectedId.value;
    return id ? editing.setLabel(id, label) : false;
  },
  /**
   * 当前选中的片段 id（**解包后的字符串**）。
   *
   * 父组件**不能**直接读 `editing.selectedId` —— 那是 Ref 对象，
   * 跨 expose 传到父组件后仍然是 RefImpl：
   *   - `if (!selId)` 永远为假（对象是 truthy）
   *   - `c.id === selId` 永远为假（字符串 vs 对象）
   * 于是详情页永远显示「未选中片段」。
   *
   * 这和 `canUndoFlag` 是同一个坑：expose 出去的可变状态一律要解包。
   */
  selectedIdValue: computed(() => editing.selectedId.value),
  /**
   * 当前选中片段的**实时数据**（含用户编辑后的结果）。
   *
   * ⚠️ 父组件不能拿 `tracks` 去找选中片段：`tracks` 是从分析结果算出来的
   * 静态数据，而用户改和弦/改状态只发生在编辑层的 `clipsByTrack` 里。
   * 两边不同步 —— 改完和弦，时间轴变了、检查器还显示旧的。
   *
   * 所以这里直接暴露编辑层里的那份（`effectiveClips` 还包含拖动预览）。
   */
  selectedClipLive: computed(() => {
    const id = editing.selectedId.value;
    if (!id) return null;
    for (const [tid, clips] of Object.entries(editing.effectiveClips.value)) {
      const c = clips.find((x) => x.id === id);
      if (c) return { ...c, trackId: tid };
    }
    return null;
  }),
  zoomIn,
  zoomOut,
  zoomFit: zoomFitAll,
  zoomReset,
  setZoomPercent,
  zoomPercent: zoomPercentRef,
  // 供工具栏的撤销/重做按钮读取与调用
  undo: () => editing.undo(),
  redo: () => editing.redo(),
  editing,
  /**
   * 单独暴露解包后的布尔值。
   * editing.canUndo 本身是 ComputedRef，跨组件 expose 后父组件拿到的是 ref 对象
   * 而不是布尔值，`=== false` 判断会永远失败（导致按钮永不禁用）。
   */
  canUndoFlag: computed(() => editing.canUndo.value),
  canRedoFlag: computed(() => editing.canRedo.value),
});
</script>

<template>
  <div class="timeline">
    <div class="tl-grid">
      <!-- 左上角占位 -->
      <div class="corner">
        <span class="corner-label">轨道</span>
        <span class="corner-zoom">{{ zoomPercent }}%</span>
      </div>

      <!-- 顶部标尺 -->
      <div class="ruler" @pointerdown="onRulerPointerDown">
        <canvas ref="rulerCanvasRef" class="ruler-canvas" />
      </div>

      <!-- 左侧轨名列 -->
      <div class="headers">
        <!-- 拍号 tag 轨：只改变尺子分组，不改变格子间隔 -->
        <div class="track-header meter-head" :style="{ height: META_ROW_H + 'px' }">
          <span class="kind-bar" style="background: #8a63d2" />
          <span class="chevron">▾</span>
          <div class="header-main">
            <div class="header-name">拍号</div>
          </div>
        </div>
        <!-- 速度轨 -->
        <div class="track-header meter-head" :style="{ height: META_ROW_H + 'px' }">
          <span class="kind-bar" style="background: #c4703f" />
          <span class="chevron">▾</span>
          <div class="header-main">
            <div class="header-name">速度（BPM）</div>
          </div>
        </div>

        <div
          v-for="t in tracks"
          :key="'h-' + t.id"
          class="track-header"
          :style="{ height: trackHeight(t.kind) + 'px' }"
        >
          <span class="kind-bar" :style="{ background: trackColor(t.kind).fg }" />
          <span class="chevron">
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 4L5 6.5 7.5 4" stroke="currentColor" stroke-width="1.3"
                stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <div class="header-main">
            <div class="header-name">{{ t.name }}</div>
            <!--
              副标题行：级数轨的调性徽章 + 删除按钮放这里，不放主行。
              轨道头总共只有 148px：主行塞「名字 + 徽章 + ×」会把名字挤成
              「级...」（实测就是这样）。
            -->
            <div class="header-sub">
              <span v-if="trackLayerOf(t)" class="header-layer">{{ trackLayerOf(t) }}</span>
              <template v-if="degreeTrackKeyOf(t.id)">
                <button
                  class="track-key-btn"
                  title="这条轨用的调性（点击选择主音和大小调）"
                  :disabled="readonly"
                  @click.stop="toggleKeyPop(t.id, $event)"
                >
                  {{ degreeTrackKeyOf(t.id) }}
                </button>
                <button
                  v-if="!readonly"
                  class="track-remove"
                  title="删除这条级数轨"
                  @click="emit('remove-degree-track', t.id)"
                >
                  ×
                </button>
              </template>
            </div>
          </div>
        </div>

        <!--
          添加级数轨。
          放在轨道列表**末尾**而不是顶部工具栏：这是轨道层面的操作，
          用户想加轨时视线就在这一列，跑去顶栏找是反直觉的。
        -->
        <button
          v-if="!readonly"
          class="add-track"
          title="按另一个调性解释同一批和弦（比如关系小调对照）"
          @click="emit('add-degree-track')"
        >
          <span class="add-track-plus">+</span>
          <span>添加级数轨</span>
        </button>
      </div>

      <!-- 内容区（Canvas 网格 + DOM 片段） -->
      <div
        ref="contentRef"
        class="content"
        tabindex="0"
        @wheel="onWheel"
        @keydown="onKeyScroll"
      >
        <canvas
          ref="gridCanvasRef"
          class="grid-canvas"
          :data-ppt="viewport.pixelsPerTick"
          :data-scroll="viewport.scrollTick"
          :data-width="viewport.width"
        />

        <div class="tracks-layer">
          <!-- 拍号 tag 轨 -->
          <div class="meta-row" :style="{ height: META_ROW_H + 'px' }">
            <div
              v-for="m in meterTags"
              :key="m.key"
              class="meter-tag"
              :style="{ left: labelLeft(m.tick) }"
            >
              {{ m.label }}
            </div>
          </div>

          <!-- 速度轨 -->
          <div class="meta-row" :style="{ height: META_ROW_H + 'px' }">
            <div
              v-for="t in tempoTags"
              :key="t.key"
              class="tempo-tag"
              :class="{ editable: t.index >= 0 }"
              :style="{ left: labelLeft(t.tick) }"
              :title="t.index >= 0 ? `双击修改 BPM（从 bar ${t.tick / BAR_TICKS} 起，到 bar ${t.endBar}）` : ''"
              @dblclick.stop="onTempoDoubleClick(t)"
            >
              <input
                v-if="editingTempo && editingTempo.index === t.index"
                class="tempo-input"
                v-model="editingTempo.value"
                @pointerdown.stop
                @dblclick.stop
                @keydown.enter.stop="commitTempoEdit"
                @keydown.esc.stop="editingTempo = null"
                @blur="commitTempoEdit"
                v-focus
              />
              <template v-else>
                <span class="tempo-dot" />
                ♩ = {{ t.label }}
              </template>
            </div>
          </div>

          <div
            v-for="t in tracks"
            :key="'r-' + t.id"
            class="track-row"
            :class="{ 'kind-degree': t.kind === 'degree' }"
            :data-track-id="t.id"
            :data-track-kind="t.kind"
            :style="{ height: trackHeight(t.kind) + 'px', cursor: cursorStyle }"
            @pointerdown="onTrackPointerDown($event, t)"
            @dblclick="onTrackDoubleClick($event, t)"
            @contextmenu="onTrackContextMenu($event, t)"
          >
            <!-- 片段块 -->
            <div
              v-for="c in clipsOf(t)"
              :key="c.id"
              class="clip"
              :class="[c.selected ? 'selected' : '', 'st-' + c.state, c.narrow ? 'narrow' : '', c.unrecognized ? 'unrecognized' : '', c.keyMatch ? 'key-match' : '']"
              :data-clip-id="c.id"
              :data-start="c.startTick"
              :data-end="c.endTick"
              :style="{
                left: c.left + 'px',
                width: Math.max(2, c.width) + 'px',
                '--clip-fg': c.fg,
                '--clip-bg': c.bg,
              }"
            >
              <span class="clip-label" v-if="c.wide">{{ c.label }}</span>
              <span class="clip-sub" v-if="c.wide && c.sublabel && c.width > 70">
                {{ c.sublabel }}
              </span>
              <!--
                置信度圆点。
                原来这个是"待确认"标记，但取消了确认/拒绝操作之后
                所有块都是 draft，它就不再表示状态了。
                改成直接表达**模型置信度**（低置信度才显示），
                让用户一眼看出"哪几个和弦模型自己也没把握"。
              -->
              <span
                v-if="c.confidence != null && c.confidence < 0.25"
                class="state-dot low-conf"
                :title="`模型置信度较低 ${Math.round(c.confidence * 100)}%，建议核对`"
              />
              <!-- 左右手柄（可拖拽的视觉提示） -->
              <!--
                结构段的调性徽章。
                含义：「这段转调了，请按这个调来理解级数」。
                它不改变任何计算，只是标注 + 让匹配的级数块高亮。
              -->
              <span
                v-if="c.sectionKey && c.width > 60"
                class="clip-key"
                :title="`这段是 ${c.sectionKey.tonic} ${c.sectionKey.mode}，级数请按该调理解`"
              >
                {{ c.sectionKey.tonic }}{{ c.sectionKey.mode === 'minor' ? 'm' : '' }}
              </span>
              <span v-if="t.kind !== 'degree'" class="handle handle-left" />
              <span v-if="t.kind !== 'degree'" class="handle handle-right" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 右键菜单 -->
    <ContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="menuItems"
      :title="ctxMenu.clipId ? editing.clipById(ctxMenu.clipId)?.label : '空白处'"
      @select="onMenuSelect"
      @close="ctxMenu = null"
    />

    <!--
      结构段弹层：改名 / 设调性。
      Teleport 到 body：时间轴里有 transform / overflow，
      留在原地的 fixed 定位会失真。
    -->
    <Teleport to="body">
      <div
        v-if="sectionRenameFor"
        class="sec-mask"
        @click.self="sectionRenameFor = null"
      >
        <div class="sec-pop">
          <div class="sec-pop-title">这段叫什么？</div>
          <SectionPicker
            :model-value="sectionRenameValue"
            @update:model-value="applySectionRename"
          />
        </div>
      </div>
      <div
        v-if="sectionKeyFor"
        class="sec-mask"
        @click.self="sectionKeyFor = null"
      >
        <div class="sec-pop">
          <div class="sec-pop-title">这段用哪个调性？</div>
          <div class="sec-pop-sub">标注后，级数轨上与此调相符的一条会高亮</div>
          <KeyPicker
            :model-value="sectionKeyValue"
            @update:model-value="applySectionKey"
          />
        </div>
      </div>
    </Teleport>

    <!-- 横向滚动条 -->
    <div
      ref="scrollRef"
      class="h-scroll"
      :class="{ disabled: !canScroll }"
      @pointerdown="onTrackDown"
    >
      <div
        class="h-thumb"
        :style="{
          width: scrollThumbRatio * 100 + '%',
          left: scrollThumbLeft * 100 + '%',
        }"
        @pointerdown.stop="onThumbDown"
        @pointermove="onThumbMove"
        @pointerup="onThumbUp"
        @pointercancel="onThumbUp"
      />
    </div>
  </div>

  <!--
    调性弹层：Teleport 到 body。

    为什么不就地 absolute 定位：`.headers` 是 `overflow: hidden` 的滚动容器，
    弹层会被裁掉；改成 fixed 就地放又会跟着容器滚动漂走。
    Teleport + 按按钮的 getBoundingClientRect 定位，两个问题都避开。
  -->
  <Teleport to="body">
    <div
      v-if="keyPopFor"
      class="key-pop"
      :style="keyPopStyle"
      @click.stop
    >
      <KeyPicker
        :model-value="degreeTrackKeyValue(keyPopFor)"
        @update:model-value="(v) => pickTrackKey(keyPopFor!, v)"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.timeline {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--bg-app);
}

.tl-grid {
  flex: 1;
  display: grid;
  grid-template-columns: var(--track-header-width) 1fr;
  grid-template-rows: var(--ruler-height) 1fr;
  min-height: 0;
  min-width: 0;
}

/* 左上角 */
.corner {
  grid-column: 1;
  grid-row: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  background: var(--bg-ruler);
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.corner-label {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.corner-zoom {
  font-size: 10.5px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

/* 标尺 */
.ruler {
  grid-column: 2;
  grid-row: 1;
  background: var(--bg-ruler);
  border-bottom: 1px solid var(--border);
  position: relative;
  overflow: hidden;
  /* 可点击定位播放位置 */
  cursor: pointer;
  user-select: none;
}
.ruler-canvas {
  display: block;
  width: 100%;
  height: var(--ruler-height);
}

/* 轨名列 */
.headers {
  grid-column: 1;
  grid-row: 2;
  overflow: hidden;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
}
.track-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  flex: 0 0 auto;
}

/* ---- 追加级数轨的调性徽章 / 删除 ---- */

/*
  锚点：弹层相对它定位。
  轨道头在可滚动容器里，`position: fixed` 会跟着滚动漂走，
  `absolute` + 这个 anchor 才是稳的。
*/
.key-pop-anchor {
  position: relative;
  display: inline-flex;
  min-width: 0;
}

/* 调性弹层：盖在轨道内容区上方（不挤压布局） */
.key-pop {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 200;
  width: 196px;
  padding: 8px 9px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel, #fff);
  box-shadow: 0 8px 24px -6px rgba(16, 24, 40, 0.2);
  /* 轨道头是 148px 窄列，弹层要能溢出到右侧内容区 */
  overflow: visible;
}
.track-key-btn {
  /* 紧凑：轨道头副行只有 ~90px 可用（layer 文字 + 徽章 + ×）
     轨道名里已经写了调性（级数 · B 小调），这里只是可点击的快捷入口，
     不需要很显眼 —— 弱化成一个小胶囊。 */
  flex: none;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  font: inherit;
  font-size: 9px;
  line-height: 14px;
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 56px;
}
.track-key-btn:hover:not(:disabled) {
  border-color: var(--accent, #e8722d);
  color: var(--accent, #e8722d);
}
.track-key-btn:disabled {
  cursor: default;
  opacity: 0.6;
}
.track-remove {
  flex: none;
  width: 13px;
  height: 13px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  color: var(--text-dim, #8a8f98);
  cursor: pointer;
}
.track-remove:hover {
  background: rgba(220, 60, 60, 0.1);
  color: #d33;
}
/* ---- 添加级数轨按钮 ---- */
.add-track {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  font: inherit;
  font-size: 11px;
  color: var(--text-dim, #8a8f98);
  text-align: left;
  cursor: pointer;
  flex: 0 0 auto;
}
.add-track:hover {
  background: rgba(232, 114, 45, 0.06);
  color: var(--accent, #e8722d);
}
.add-track-plus {
  width: 11px;
  text-align: center;
  font-size: 13px;
  line-height: 1;
}
.kind-bar {
  width: 3px;
  align-self: stretch;
  opacity: 0.5;
}
.chevron {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--text-muted);
  margin-left: 4px;
}
.chevron:hover {
  color: var(--text-primary);
}
.header-main {
  flex: 1;
  min-width: 0;
}
.header-name {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}
/* 副标题行：layer 文字 + 调性徽章 + 删除按钮。
   轨道头只有 148px 宽，主行放不下这些控件（会把名字挤成「级...」），
   所以拆成两行，副行里的东西都允许收缩。 */
.header-sub {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}
.header-layer {
  /* 有徽章时让 layer 文字先收缩（min-width:0 才让 flex 子项能缩） */
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}
.header-actions {
  font-size: 10px;
  color: var(--text-muted);
  flex: 0 0 auto;
}
.eye.off {
  opacity: 0.35;
}

/* 内容区 */
.content {
  grid-column: 2;
  grid-row: 2;
  position: relative;
  overflow: hidden;
  background: var(--bg-track);
  cursor: default;
}
.grid-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  /* 网格在片段**下方**。
     若放在上方，网格线会压在片段文字上，"格子跑到内容前面"。
     透出格子的办法是让片段背景半透明，见 .clip 的 background。 */
  z-index: 0;
}

.tracks-layer {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  z-index: 1;
}
.track-row {
  position: relative;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
  flex: 0 0 auto;
  /* 拖动时不选中文本（替代 pointerdown 的 preventDefault） */
  user-select: none;
  -webkit-user-select: none;
}
.track-row:nth-child(even) {
  background: rgba(0, 0, 0, 0.012);
}
.track-row.hidden {
  opacity: 0.35;
}

/* 片段块 */
.clip {
  position: absolute;
  top: 4px;
  bottom: 4px;
  border-radius: 0;
  /* 半透明背景：让下方网格线透出来（网格在块之下，不会压住文字） */
  background: color-mix(in srgb, var(--clip-bg) 82%, transparent);
  /* 用 inset 阴影画边框，而不是 border。
     border 会占据布局空间，导致相邻片段各画一条线 → 视觉上出现 2px 白缝。
     inset 阴影不占空间，相邻片段的边界完全重合，看起来是一条细线。 */
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.14);
  padding: 0 7px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
}
.clip:hover {
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.28);
}
.clip.selected {
  background: color-mix(in srgb, var(--accent-dim) 92%, transparent);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}
.clip.st-draft {
  /* draft 用虚线内阴影表示"待确认" —— 不占空间的虚线 */
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.16);
  background: color-mix(in srgb, var(--clip-bg) 76%, transparent);
}
.clip.st-rejected {
  opacity: 0.45;
  text-decoration: line-through;
}

/**
 * 未识别段（长的 N）。
 *
 * 用虚线边框 + 灰底，和普通和弦块区分开：
 * 它表示「模型没识别出来」，不是「这里是无和弦」。
 * 用户一眼就能看出哪些地方需要人工补。
 */
.clip.unrecognized {
  background: repeating-linear-gradient(
    45deg,
    rgba(154, 154, 157, 0.1),
    rgba(154, 154, 157, 0.1) 6px,
    rgba(154, 154, 157, 0.02) 6px,
    rgba(154, 154, 157, 0.02) 12px
  );
  box-shadow: inset 0 0 0 1px rgba(154, 154, 157, 0.45);
}
.clip.unrecognized .clip-label {
  color: var(--text-muted);
  font-style: italic;
}

/*
 * 段调性匹配的级数块。
 *
 * 语义不是「这个块被选中了」，而是「这段转调了，请按这条轨来读」——
 * 所以用**主题色实底 + 白字**，不用选中色（那会和真正的选中混淆）。
 */
.clip.key-match {
  /*
   * 主题色实底 + 白字。
   *
   * 不用描边/发光：那在 12px 高的块里几乎看不出来，而「这段按这条轨读」
   * 是个强提示，必须一眼能分辨。实底填充最直接。
   *
   * 用 `!important` 是因为 .clip 的 background 由内联 `--clip-bg` 决定，
   * 内联样式的优先级高于普通类选择器。
   */
  background: var(--accent, #e0a052) !important;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);
}
.clip.key-match .clip-label {
  color: #fff;
  font-weight: 600;
}
.clip.key-match .clip-sub {
  color: rgba(255, 255, 255, 0.85);
}
/* 高亮块里的置信度圆点也要在深底上看得见 */
.clip.key-match .state-dot {
  background: #fff;
}
.clip.key-match.selected {
  box-shadow:
    inset 0 0 0 2px rgba(255, 255, 255, 0.9),
    0 0 0 1px var(--accent, #e0a052);
}

/* 结构段上的调性小徽章 */
.clip-key {
  position: absolute;
  top: 2px;
  right: 3px;
  font-size: 9px;
  line-height: 1;
  padding: 1px 3px;
  border-radius: 3px;
  color: rgba(20, 20, 24, 0.85);
  background: rgba(255, 255, 255, 0.72);
  font-weight: 700;
  pointer-events: none;
}

.clip-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--clip-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}
.clip-sub {
  font-size: 10.5px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.clip.selected .clip-sub {
  color: #8a4a20;
}

/* 窄块（1–2 拍）：经过和弦（如 5/7）只有 1 拍宽，
   必须缩小字号和 padding 才放得下名字 */
.clip.narrow {
  padding: 0 2px;
}
.clip.narrow .clip-label {
  font-size: 10px;
  letter-spacing: -0.2px;
}
.clip.narrow .clip-sub {
  display: none;
}
.state-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 3px;
  height: 3px;
  background: var(--accent);
}
/* 低置信度用警告色，和"待确认"的橙色区分开 */
.state-dot.low-conf {
  background: var(--warning, #e8a33d);
}

/* 节拍标记 */

/* 横向滚动条 */
.h-scroll {
  height: 14px;
  margin-left: var(--track-header-width);
  background: var(--bg-panel-alt);
  border-top: 1px solid var(--border);
  position: relative;
  flex: 0 0 auto;
  cursor: pointer;
}
.h-scroll.disabled {
  opacity: 0.45;
  cursor: default;
}
.h-thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  background: #c9c9cd;
  cursor: grab;
  min-width: 28px;
}
.h-thumb:hover {
  background: #a8a8ad;
}
.h-thumb:active {
  cursor: grabbing;
  background: #fd651a;
}
/* ---- 顶部 tag 轨（拍号 / 速度）---- */
.meta-row {
  position: relative;
  border-bottom: 1px solid var(--border);
  background: var(--bg-track-alt);
  overflow: hidden;
  flex: 0 0 auto;
}

.meter-tag {
  position: absolute;
  top: 3px;
  bottom: 3px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding-left: 6px;
  font-size: 11px;
  font-weight: 500;
  color: #3f2d70;
  background: color-mix(in srgb, var(--section-bridge) 70%, transparent);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
  overflow: hidden;
  white-space: nowrap;
}

.tempo-tag {
  position: absolute;
  top: 3px;
  bottom: 3px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding-left: 6px;
  font-size: 11px;
  color: #6b3a22;
  background: color-mix(in srgb, var(--section-verse) 60%, transparent);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  white-space: nowrap;
}
.tempo-dot {
  width: 3px;
  height: 3px;
  background: var(--accent);
  flex: 0 0 auto;
}

/* 可编辑的速度段：hover 时边框变亮，提示可双击 */
.tempo-tag.editable {
  cursor: text;
}
.tempo-tag.editable:hover {
  box-shadow: inset 0 0 0 1px var(--accent);
  background: color-mix(in srgb, var(--accent-dim) 60%, transparent);
}

.tempo-input {
  position: absolute;
  inset: 0;
  width: 100%;
  border: none;
  outline: 1.5px solid var(--accent);
  background: #fff;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  padding: 0 6px;
  z-index: 5;
}

.meter-head .header-name {
  font-size: 11.5px;
  color: var(--text-secondary);
}

/* ---- 拖拽手柄 ---- */
.handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: ew-resize;
  /* 平时不可见，hover 时显示 */
  background: transparent;
  z-index: 3;
}
.handle-left {
  left: -1px;
}
.handle-right {
  right: -1px;
}
.clip:hover .handle {
  background: var(--accent);
  opacity: 0.45;
}
.clip.selected .handle {
  background: var(--accent);
  opacity: 0.8;
}

/* 级数解释轨：时间只读，光标为默认 */
.track-row.kind-degree {
  cursor: default !important;
}

/* ---- 结构段弹层（改名 / 设调性） ---- */
/*
 * 配色必须和主界面一致：主界面是浅色（--bg-app #f2f3f3 / --bg-panel #fff）。
 * 之前这里写的是 `--panel`（不存在的变量）+ 深色 fallback，
 * 于是弹出来一个黑框，和整个界面完全不搭。
 */
.sec-mask {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 20, 24, 0.28);
  backdrop-filter: blur(2px);
}
.sec-pop {
  background: var(--bg-panel, #fff);
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 12px;
  padding: 14px 16px 16px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
  color: var(--text-primary, #1a1a1a);
}
.sec-pop-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #1a1a1a);
  margin-bottom: 10px;
}
.sec-pop-sub {
  font-size: 11px;
  color: var(--text-muted, #9a9a9d);
  margin: -6px 0 10px;
}
.sec-mask :deep(.sec-item) {
  border-color: var(--border, #e5e5e5);
  color: var(--text-primary, #1a1a1a);
}
.sec-mask :deep(.sec-item:hover) {
  border-color: var(--accent, #fd651a);
  background: var(--bg-hover, #f0f1f1);
}
.sec-mask :deep(.sec-item.active) {
  background: var(--accent-soft, #fdece3);
  border-color: var(--accent, #fd651a);
  color: var(--accent, #fd651a);
}
.sec-mask :deep(.sec-group-title) {
  color: var(--text-muted, #9a9a9d);
}
</style>
