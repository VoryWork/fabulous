<script setup lang="ts">
/**
 * 左侧曲库。
 *
 * 接真实后端（`useLibrary`）：
 *   - 「+」按钮 = 添加音乐（选文件 → 自动分析）
 *   - 每条显示分析状态与进度
 *   - 音频失效的条目会标红，点它可以触发重连 dialog
 *
 * ## 列表密度与「几百首之后怎么找」
 *
 * 一首歌占两行（标题 + 艺术家/时长）时行高 ~40px，300 首就是 12000px，
 * 滚动条细得像头发丝、翻页要甩十几下滚轮。所以这里做了三件事：
 *
 *   1. **紧凑密度（默认）**：单行 30px，艺术家缩在标题右侧、状态缩成
 *      左侧 6px 小圆点、进度改成行底 2px 细线。300 首 ≈ 9000px → 换成
 *      舒适密度时同样内容只占 1/3 屏高。
 *   2. **虚拟滚动**：只渲染可视窗口 + 上下各 6 行。曲库上千首也不会
 *      一次塞几千个 DOM 节点（否则滚动会掉帧、切歌会卡）。
 *   3. **键盘导航**：`/` 聚焦搜索框，↑/↓ 在列表里移动，Enter 打开，
 *      Home/End 跳到首尾。搜索 + 键盘比滚轮找歌快一个数量级。
 *
 * 行高必须**严格等于**虚拟滚动的步长，所以 `.song-item` 用固定
 * `height` 而不是 padding 撑高，也不加 margin（差 1px 累计到第 300 行
 * 就是 300px 的偏移，滚动位置会越来越离谱）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SongListItem } from '../api/backend';
import type { ProgressMap } from '../composables/useLibrary';

const props = withDefaults(
  defineProps<{
    width?: number;
    songs: SongListItem[];
    currentId: string | null;
    progress: ProgressMap;
    missingIds: string[];
    busy?: boolean;
    standalone?: boolean;
  }>(),
  { width: 260, busy: false, standalone: false },
);

const emit = defineEmits<{
  (e: 'add'): void;
  (e: 'select', id: string): void;
  (e: 'reconnect', id: string): void;
  (e: 'delete', id: string): void;
}>();

/* ------------------------------------------------------------ 筛选 / 排序 */

const query = ref('');
const filter = ref<'all' | 'done' | 'todo'>('all');

type SortKey = 'recent' | 'title' | 'artist';
const sort = ref<SortKey>('recent');

/** 排序下拉。原生 <select> 展开后是浏览器默认的灰白方块，和这套界面完全不搭，
    所以自绘一个（和右键菜单同一套视觉）。 */
const SORT_OPTIONS: Array<{ key: SortKey; label: string; hint: string }> = [
  { key: 'recent', label: '最近添加', hint: '导入顺序' },
  { key: 'title', label: '标题', hint: '名称顺序' },
  { key: 'artist', label: '艺术家', hint: '作者顺序' },
];
const SORT_SHORT: Record<SortKey, string> = { recent: '最近', title: '标题', artist: '艺术家' };
const sortOpen = ref(false);

function pickSort(key: SortKey) {
  sortOpen.value = false;
  if (sort.value !== key) sort.value = key;
}

/**
 * 中文按拼音、数字按字面大小排序。
 * `localeCompare` 不带 locale 时中文是按码位排的（乱序），
 * 而 Intl.Collator('zh-Hans') 在 WebView2 里能正确走拼音。
 */
const collator = (() => {
  try {
    return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  } catch {
    return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  }
})();

const filtered = computed<SongListItem[]>(() => {
  let list = props.songs;
  const q = query.value.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.artist.toLowerCase().includes(q) ||
        s.audio_path.toLowerCase().includes(q),
    );
  }
  if (filter.value === 'done') list = list.filter((s) => s.status === 'done');
  if (filter.value === 'todo') list = list.filter((s) => s.status !== 'done');

  // 'recent' 直接沿用后端顺序（后端按 created_at 倒序给）
  if (sort.value === 'title') {
    list = [...list].sort((a, b) => collator.compare(a.title || '', b.title || ''));
  } else if (sort.value === 'artist') {
    list = [...list].sort(
      (a, b) =>
        collator.compare(a.artist || '', b.artist || '') ||
        collator.compare(a.title || '', b.title || ''),
    );
  }
  return list;
});

/** 搜索/筛选是否生效（用来决定计数显示 "12/300" 而不是 "300"） */
const filtering = computed(() => query.value.trim() !== '' || filter.value !== 'all');

const FILTER_LABEL = { all: '全部', done: '已分析', todo: '待处理' } as const;

/** 空结果时说清「为什么空」，比一句"没有数据"有用 */
const emptyReason = computed(() => {
  const q = query.value.trim();
  const scope = filter.value === 'all' ? '' : `「${FILTER_LABEL[filter.value]}」里`;
  if (q && scope) return `${scope}没有包含「${q}」的曲目`;
  if (q) return `没有任何曲目匹配「${q}」`;
  return `「${FILTER_LABEL[filter.value]}」下还没有曲目`;
});

const doneCount = computed(() => props.songs.filter((s) => s.status === 'done').length);
const todoCount = computed(() => props.songs.filter((s) => s.status !== 'done').length);

function resetFilters() {
  query.value = '';
  filter.value = 'all';
}

function statusLabel(s: SongListItem): string {
  if (props.missingIds.includes(s.id)) return '音频失效';
  switch (s.status) {
    case 'done':
      return '已分析';
    case 'running':
      return '分析中';
    case 'pending':
      return '待分析';
    case 'failed':
      return '失败';
    case 'missing_audio':
      return '音频失效';
    default:
      return s.status;
  }
}

function statusClass(s: SongListItem): string {
  if (props.missingIds.includes(s.id) || s.status === 'missing_audio') return 'missing';
  if (s.status === 'done') return 'analyzed';
  if (s.status === 'failed') return 'failed';
  return 'partial';
}

function fmtDur(sec: number): string {
  if (!sec) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------ 列表密度 */

type Density = 'compact' | 'comfort';
const DENSITY_KEY = 'tl.libraryDensity';

/**
 * 行高（px）。虚拟滚动按这个值切片，所以必须是**实际渲染高度**：
 * 紧凑 30 = 单行文字 + 上下各 ~7px；舒适 54 = 标题行 + 副标题行。
 */
const ROW_H: Record<Density, number> = { compact: 30, comfort: 54 };

function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'comfort' ? 'comfort' : 'compact';
  } catch {
    // 某些 WebView 配置下 localStorage 会抛（隐私模式/受限存储），不影响功能
    return 'compact';
  }
}

const density = ref<Density>(readDensity());
const dense = computed(() => density.value === 'compact');
const rowH = computed(() => ROW_H[density.value]);

watch(density, (cur, prev) => {
  try {
    localStorage.setItem(DENSITY_KEY, cur);
  } catch {
    /* 存不了就算了，下次启动回到默认 */
  }
  // 行高变了 → 按「当前第一条可见项」重新对齐滚动位置，
  // 否则用户会瞬间跳到列表里完全不相干的地方。
  const anchor = Math.floor(scrollTop.value / ROW_H[prev]);
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    el.scrollTop = anchor * ROW_H[cur];
    scrollTop.value = el.scrollTop;
  });
});

function toggleDensity() {
  density.value = dense.value ? 'comfort' : 'compact';
}

/* ------------------------------------------------------------ 虚拟滚动 */

const listEl = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const scrollTop = ref(0);
const viewportH = ref(0);

/** 上下多渲染几行，快速滚动时不会露出空白 */
const OVERSCAN = 6;

/** 行高恒定（没有分组头），所以位置可以直接算：idx * rowH */
const startIdx = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / rowH.value) - OVERSCAN),
);
const endIdx = computed(() =>
  Math.min(
    filtered.value.length,
    Math.ceil((scrollTop.value + viewportH.value) / rowH.value) + OVERSCAN,
  ),
);
const windowItems = computed(() => filtered.value.slice(startIdx.value, endIdx.value));
const padTop = computed(() => startIdx.value * rowH.value);
const padBottom = computed(() =>
  Math.max(0, (filtered.value.length - endIdx.value) * rowH.value),
);

function onScroll() {
  scrollTop.value = listEl.value?.scrollTop ?? 0;
}

let ro: ResizeObserver | null = null;

onMounted(() => {
  const el = listEl.value;
  if (!el) return;
  viewportH.value = el.clientHeight;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      viewportH.value = el.clientHeight;
    });
    ro.observe(el);
  }
});

// 换搜索词/筛选/排序后滚回顶部：停在旧位置会让人误以为列表是空的
watch([query, filter, sort], () => {
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    el.scrollTop = 0;
    scrollTop.value = 0;
  });
});

// 曲库变短（删歌、改筛选）时不能留在越界位置，会渲染出一片空白
watch(
  () => filtered.value.length,
  (len) => {
    const maxTop = Math.max(0, len * rowH.value - viewportH.value);
    if (scrollTop.value > maxTop) {
      const el = listEl.value;
      if (el) el.scrollTop = maxTop;
      scrollTop.value = maxTop;
    }
  },
);

/* ------------------------------------------------------------ 选择 / 键盘 */

function activate(s: SongListItem) {
  if (props.missingIds.includes(s.id) || s.status === 'missing_audio') {
    emit('reconnect', s.id);
  } else {
    emit('select', s.id);
  }
}

/**
 * 键盘光标。
 *
 * ↑/↓ 只移动光标、延迟 160ms 才真正切歌 —— `select()` 要读分析 JSON
 * （几十上百 KB）和音频路径，连按 10 下会并发 10 次加载，最后完成的那次
 * 未必是用户停下的那首歌。用户停手 160ms 才发一次。
 */
const cursorId = ref<string | null>(null);
let cursorTimer: ReturnType<typeof setTimeout> | null = null;

function activateSoon(s: SongListItem) {
  if (cursorTimer) clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => {
    cursorTimer = null;
    activate(s);
  }, 160);
}

function ensureVisible(idx: number) {
  const el = listEl.value;
  if (!el) return;
  const top = idx * rowH.value;
  const bottom = top + rowH.value;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  scrollTop.value = el.scrollTop;
}

function onListKey(e: KeyboardEvent) {
  const list = filtered.value;
  if (!list.length) return;
  // 焦点必须在滚动容器上，不能留在行按钮上 ——
  // 行会被虚拟滚动回收，节点一消失焦点就掉到 <body>，
  // 后面连按的方向键全部丢失（表现为「按几下就不动了」）。
  if (listEl.value && document.activeElement !== listEl.value) listEl.value.focus();

  let idx = -1;
  const anchorId = cursorId.value ?? props.currentId;
  if (anchorId) idx = list.findIndex((s) => s.id === anchorId);

  if (e.key === 'Enter') {
    // 焦点在行按钮上时，Enter 的默认动作就是 click，这里再 activate 会重复加载
    if (idx < 0 || (e.target as HTMLElement | null)?.closest?.('.song-item')) return;
    e.preventDefault();
    if (cursorTimer) {
      clearTimeout(cursorTimer);
      cursorTimer = null;
    }
    activate(list[idx]);
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;

  e.preventDefault();
  if (e.key === 'Home') idx = 0;
  else if (e.key === 'End') idx = list.length - 1;
  else if (e.key === 'ArrowDown') idx = idx < 0 ? 0 : Math.min(list.length - 1, idx + 1);
  else idx = idx <= 0 ? 0 : idx - 1;

  const target = list[idx];
  cursorId.value = target.id;
  ensureVisible(idx);
  activateSoon(target);
}

/** 全局快捷键：`/` 聚焦搜索（列表外也能用），Esc 清空搜索 */
function onWindowKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) {
    if (e.key === 'Escape' && query.value) {
      e.preventDefault();
      query.value = '';
    }
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    searchEl.value?.focus();
    searchEl.value?.select();
  }
}

/* ------------------------------------------------------------ 右键菜单 */

/**
 * 右键菜单。
 *
 * 删除是**破坏性**操作（会连同分析结果一起删掉，重新分析要跑几分钟），
 * 所以不放在每行常驻的按钮上 —— 鼠标悬停时露出的垃圾桶太容易误点。
 * 右键 → 菜单 → 确认，两步才删得掉。
 */
const menu = ref<{ id: string; title: string; x: number; y: number } | null>(null);

function onContextMenu(s: SongListItem, e: MouseEvent) {
  if (props.standalone) return;
  menu.value = { id: s.id, title: s.title || '未命名', x: e.clientX, y: e.clientY };
}

function closeMenu() {
  menu.value = null;
}

/** 点菜单里的删除：先确认，再 emit */
function confirmDelete() {
  const m = menu.value;
  closeMenu();
  if (!m) return;
  // 用户明确知道会丢掉什么（分析结果要重跑），所以提示里说清楚
  const ok = window.confirm(
    `删除「${m.title}」？\n\n分析结果会一起删除，重新分析需要重新跑一遍。\n音频文件本身不会被删除。`,
  );
  if (ok) emit('delete', m.id);
}

// 菜单点别处 / 按 Esc 关掉。
// 监听挂在 window 上，**必须**在卸载时摘掉 —— 否则组件重建后旧监听还在，
// 每重建一次就多一份（切主题、HMR 时最容易积累）。
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  closeMenu();
  sortOpen.value = false;
}

/** 点页面任何别处都收起浮层（菜单 / 排序下拉） */
function onWindowClick() {
  closeMenu();
  sortOpen.value = false;
}

if (typeof window !== 'undefined') {
  window.addEventListener('click', onWindowClick);
  window.addEventListener('keydown', onKeydown);
  // 搜索快捷键挂在顶层：`onMounted` 里提前 return 过就不该丢掉它
  window.addEventListener('keydown', onWindowKey);
}

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  if (cursorTimer) clearTimeout(cursorTimer);
  cursorTimer = null;
  if (typeof window === 'undefined') return;
  window.removeEventListener('click', onWindowClick);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('keydown', onWindowKey);
});
</script>

<template>
  <aside class="sidebar" :style="{ width: props.width + 'px', flex: `0 0 ${props.width}px` }">
    <div class="side-head">
      <div class="side-title">
        <span class="dot" />
        曲库
        <span class="count">{{ filtering ? `${filtered.length}/${songs.length}` : songs.length }}</span>
      </div>
      <div class="head-actions">
        <button
          class="icon-btn"
          :title="dense ? '列表密度：紧凑（点击切换为舒适）' : '列表密度：舒适（点击切换为紧凑）'"
          @click="toggleDensity"
        >
          <!-- 紧凑：三条细线；舒适：两条粗线。一看就知道切过去更松 -->
          <svg v-if="dense" width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M2.5 4h11M2.5 7.5h11M2.5 11h11"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2.5 5h11M2.5 11h11" stroke="currentColor" stroke-width="2" stroke-linecap="square" />
          </svg>
        </button>
        <button
          class="icon-btn"
          :disabled="busy || standalone"
          title="添加音乐（导入后自动分析）"
          @click="emit('add')"
        >
          <svg v-if="!busy" width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
          <span v-else class="spin">◌</span>
        </button>
      </div>
    </div>

    <div class="search-row">
      <div class="search">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <input ref="searchEl" v-model="query" placeholder="搜索曲目 / 艺术家" title="按 / 快速聚焦" />
        <button v-if="query" class="search-clear" title="清除（Esc）" @click="query = ''">✕</button>
      </div>
      <div class="sort" :class="{ open: sortOpen }" @click.stop>
        <button
          class="sort-btn"
          :title="`排序方式：${SORT_OPTIONS.find((o) => o.key === sort)?.label}`"
          :aria-expanded="sortOpen"
          @click="sortOpen = !sortOpen"
        >
          {{ SORT_SHORT[sort] }}
          <svg class="chev" width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>
        <div v-if="sortOpen" class="sort-menu">
          <button
            v-for="o in SORT_OPTIONS"
            :key="o.key"
            :class="['sort-item', { on: sort === o.key }]"
            @click="pickSort(o.key)"
          >
            <span class="sort-item-label">{{ o.label }}</span>
            <span class="sort-item-hint">{{ o.hint }}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="filters">
      <button :class="['chip', { on: filter === 'all' }]" @click="filter = 'all'">全部</button>
      <button :class="['chip', { on: filter === 'done' }]" @click="filter = 'done'">已分析</button>
      <button :class="['chip', { on: filter === 'todo' }]" @click="filter = 'todo'">待处理</button>
    </div>

    <div
      ref="listEl"
      class="song-list"
      :class="'d-' + density"
      :style="{ '--row-h': rowH + 'px' }"
      tabindex="0"
      @scroll.passive="onScroll"
      @keydown="onListKey"
    >
      <!-- 曲库空态：整块是引导，不是一句「没有数据」 -->
      <div v-if="songs.length === 0 && !busy" class="empty">
        <svg class="empty-mark" width="34" height="34" viewBox="0 0 24 24" fill="none">
          <path
            d="M9 17.5V6.2l9-1.8v11.1"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle cx="6.8" cy="17.8" r="2.4" stroke="currentColor" stroke-width="1.5" />
          <circle cx="15.8" cy="15.8" r="2.4" stroke="currentColor" stroke-width="1.5" />
        </svg>
        <div class="empty-title">{{ standalone ? '浏览器模式' : '曲库还是空的' }}</div>
        <div class="empty-sub">
          {{
            standalone
              ? '导入功能需要 Tauri 后端，当前显示打包好的示例数据'
              : '导入音频后会自动分析出和弦、结构和拍点，不需要手动标注'
          }}
        </div>
        <button v-if="!standalone" class="empty-btn" @click="emit('add')">添加音乐</button>
        <div v-if="!standalone" class="empty-tip">支持 FLAC / MP3 / WAV / M4A / OGG</div>
      </div>

      <!-- 有歌但筛不出来：别留一片空白，给一条退路 -->
      <div v-else-if="filtered.length === 0 && !busy" class="empty">
        <div class="empty-title">没有匹配的曲目</div>
        <div class="empty-sub">{{ emptyReason }}</div>
        <button class="empty-btn ghost" @click="resetFilters">清除筛选条件</button>
      </div>

      <template v-else>
        <!-- 虚拟滚动的上下占位：撑出总高度，让滚动条长度仍然正确 -->
        <div :style="{ height: padTop + 'px' }" />
        <button
          v-for="s in windowItems"
          :key="s.id"
          :class="[
            'song-item',
            { active: s.id === currentId, cursor: s.id === cursorId, missing: missingIds.includes(s.id) || s.status === 'missing_audio' },
          ]"
          :title="s.status === 'failed' && s.error ? s.error : `${s.title || '未命名'}${s.artist ? ' · ' + s.artist : ''}`"
          @click="activate(s)"
          @contextmenu.prevent="onContextMenu(s, $event)"
        >
          <span :class="['state-dot', statusClass(s)]" :title="statusLabel(s)" />

          <div class="song-main">
            <div class="song-line">
              <span class="song-title">{{ s.title || '未命名' }}</span>
              <span v-if="dense && s.artist" class="song-artist">{{ s.artist }}</span>
            </div>
            <div v-if="!dense" class="song-sub">
              <span v-if="s.artist">{{ s.artist }}</span>
              <span v-if="s.artist" class="sep">·</span>
              <span>{{ fmtDur(s.duration_sec) }}</span>
            </div>
          </div>

          <div class="song-right">
            <!-- 分析中优先显示百分比，进度条只是辅助 -->
            <span v-if="progress[s.id]" class="dur pct">{{ (progress[s.id].pct * 100).toFixed(0) }}%</span>
            <template v-else>
              <span v-if="!dense" :class="['badge', statusClass(s)]">{{ statusLabel(s) }}</span>
              <span class="dur">{{ fmtDur(s.duration_sec) }}</span>
            </template>
          </div>

          <!-- 进度用行底 2px 细线，不占行高（虚拟滚动要求行高恒定） -->
          <span v-if="progress[s.id]" class="prog-line">
            <span class="prog-fill" :style="{ width: (progress[s.id].pct * 100).toFixed(0) + '%' }" />
          </span>
        </button>
        <div :style="{ height: padBottom + 'px' }" />
      </template>
      </div>

    <div class="side-foot">
      <div class="stat">
        <span class="stat-num">{{ todoCount }}</span>
        <span class="stat-label">待处理</span>
      </div>
      <div class="stat">
        <span class="stat-num">{{ doneCount }}</span>
        <span class="stat-label">已分析</span>
      </div>
    </div>

    <!-- 右键菜单（fixed 定位，避免被 .song-list 的 overflow 裁掉） -->
    <div v-if="menu" class="ctx-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
      <button class="ctx-item danger" @click="confirmDelete">删除曲目</button>
      <div class="ctx-hint">音频文件不会被删除</div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  min-height: 0;
}

.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 8px;
}

.side-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
  text-transform: uppercase;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

.count {
  color: var(--text-muted);
  font-weight: 500;
  font-size: 11px;
  background: var(--bg-panel-alt);
  padding: 0 6px;
  border-radius: 0;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.icon-btn {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 0;
  color: var(--text-secondary);
}
.icon-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.spin {
  display: inline-block;
  animation: spin 1.1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 搜索 + 排序同一行：排序很少改，占一行太浪费 */
.search-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
  margin: 0 12px 8px;
}

.search {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 9px;
  height: 28px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 0;
  color: var(--text-muted);
}
.search:focus-within {
  border-color: var(--accent-dim);
  color: var(--text-secondary);
}
.search input {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: 12px;
}
.search input::placeholder {
  color: var(--text-muted);
}
.search-clear {
  flex: 0 0 auto;
  font-size: 10px;
  line-height: 1;
  color: var(--text-muted);
  padding: 2px;
}
.search-clear:hover {
  color: var(--text-primary);
}

.sort {
  position: relative;
  flex: 0 0 auto;
  display: flex;
}

.sort-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 3px;
  min-width: 62px;
  height: 28px;
  padding: 0 6px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 0;
  outline: none;
  transition: border-color 0.12s, color 0.12s;
}
.sort-btn:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}
.sort.open .sort-btn {
  color: var(--accent);
  border-color: var(--accent-dim);
  background: rgba(253, 101, 26, 0.06);
}
.sort-btn .chev {
  opacity: 0.7;
  transition: transform 0.15s;
}
.sort.open .chev {
  transform: rotate(180deg);
}

.sort-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 60;
  min-width: 118px;
  padding: 3px;
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
}

.sort-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 5px 8px;
  font-size: 11.5px;
  color: var(--text-secondary);
  text-align: left;
}
.sort-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.sort-item.on {
  color: var(--accent);
  font-weight: 600;
  background: var(--accent-soft);
}
.sort-item.on:hover {
  background: var(--accent-soft);
}
.sort-item-hint {
  font-size: 9.5px;
  font-weight: 400;
  color: var(--text-muted);
}

.filters {
  display: flex;
  gap: 5px;
  padding: 0 12px 8px;
}
.chip {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 0;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border);
  transition: all 0.12s;
}
.chip:hover {
  color: var(--text-secondary);
  border-color: var(--border-strong);
}
.chip.on {
  color: var(--accent);
  border-color: var(--accent-dim);
  background: rgba(253, 101, 26, 0.08);
}

.song-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 0 6px 6px;
  outline: none;
}
.song-list:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent-dim);
}

.song-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: var(--row-h, 30px);
  padding: 0 8px;
  text-align: left;
  border-radius: 0;
  border-left: 2px solid transparent;
  transition: background 0.1s;
  overflow: hidden;
}
.song-item:hover {
  background: var(--bg-hover);
}
.song-item.cursor {
  background: var(--bg-hover);
  box-shadow: inset 0 0 0 1px var(--accent-dim);
}
.song-item.active {
  background: var(--bg-active);
  border-left-color: var(--accent);
}
.song-item.missing {
  background: rgba(229, 72, 77, 0.06);
}
.song-item.missing .song-title {
  color: var(--danger);
}

/* 状态点：紧凑模式下代替徽标（徽标文字宽，占掉 40px 标题空间） */
.state-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}
.state-dot.analyzed {
  background: var(--success);
}
.state-dot.partial {
  background: var(--warning);
}
.state-dot.failed,
.state-dot.missing {
  background: var(--danger);
}

.song-main {
  flex: 1;
  min-width: 0;
}
.song-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.song-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.35;
}
.song-item.active .song-title {
  font-weight: 600;
}
/* 紧凑模式：艺术家缩在标题右边，标题优先占位 */
.song-artist {
  flex: 0 0 auto;
  min-width: 0;
  max-width: 45%;
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.song-sub {
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  gap: 3px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
}
.sep {
  opacity: 0.5;
}

.song-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.song-list.d-comfort .song-right {
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}
.badge {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 0;
  line-height: 15px;
  white-space: nowrap;
}
.badge.analyzed {
  color: var(--success);
  background: rgba(34, 160, 107, 0.1);
}
.badge.partial {
  color: var(--warning);
  background: rgba(232, 163, 61, 0.14);
}
.badge.none {
  color: var(--text-muted);
  background: rgba(154, 154, 157, 0.14);
}
.dur {
  font-size: 10.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.dur.pct {
  color: var(--accent);
}

/* 进度：行底细线（绝对定位 → 不影响行高） */
.prog-line {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: rgba(253, 101, 26, 0.12);
}
.prog-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.2s linear;
}

/* ---------------------------------------------------------------- 空态 */

/* 之前这几个类在 <style> 里根本没有定义，直接渲染成裸 div + 原生按钮 */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  margin: 26px 4px 0;
  padding: 26px 16px 22px;
  border: 1px dashed var(--border-strong);
  background: var(--bg-panel-alt);
  text-align: center;
}
.empty-mark {
  color: var(--text-muted);
  opacity: 0.5;
  margin-bottom: 2px;
}
.empty-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.empty-sub {
  font-size: 11px;
  line-height: 1.65;
  color: var(--text-muted);
  max-width: 190px;
}
.empty-btn {
  margin-top: 5px;
  padding: 5px 16px;
  font-size: 11.5px;
  border-radius: 0;
  color: var(--text-inverse);
  background: var(--accent);
  border: 1px solid var(--accent);
  transition: background 0.12s;
}
.empty-btn:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}
.empty-btn.ghost {
  color: var(--text-secondary);
  background: transparent;
  border-color: var(--border-strong);
}
.empty-btn.ghost:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
  background: transparent;
}
.empty-tip {
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0.75;
  letter-spacing: 0.02em;
}

/* ---------------------------------------------------------------- 页脚 */

.side-foot {
  display: flex;
  border-top: 1px solid var(--border);
  background: var(--bg-panel-alt);
}
.stat {
  flex: 1;
  padding: 7px 12px;
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.stat + .stat {
  border-left: 1px solid var(--border);
}
.stat-num {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.stat-label {
  font-size: 10.5px;
  color: var(--text-muted);
}

/* 右键菜单
 *
 * 用 fixed 而不是 absolute：列表容器是 overflow-y:auto，
 * absolute 会被裁掉（菜单贴着最后一行时尤其明显）。
 */
.ctx-menu {
  position: fixed;
  z-index: 300;
  min-width: 140px;
  padding: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}

.ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-primary);
  background: transparent;
  border: none;
  cursor: pointer;
}
.ctx-item:hover {
  background: var(--bg-hover);
}
.ctx-item.danger {
  color: var(--danger, #d64545);
}
.ctx-item.danger:hover {
  background: rgba(214, 69, 69, 0.1);
}

.ctx-hint {
  padding: 4px 10px 2px;
  font-size: 10.5px;
  color: var(--text-muted);
}
</style>
