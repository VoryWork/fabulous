<script setup lang="ts">
/**
 * 左侧曲库。
 *
 * 现在接的是真实后端（`useLibrary`）：
 *   - 「+」按钮 = 添加音乐（选文件 → 自动分析）
 *   - 每条显示分析状态与进度
 *   - 音频失效的条目会标红，点它可以触发重连 dialog
 */
import { computed, onBeforeUnmount, ref } from 'vue';
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

const query = ref('');
const filter = ref<'all' | 'done' | 'todo'>('all');

const filtered = computed(() => {
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
  return list;
});

const doneCount = computed(() => props.songs.filter((s) => s.status === 'done').length);
const todoCount = computed(() => props.songs.filter((s) => s.status !== 'done').length);

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

function onClick(s: SongListItem) {
  if (props.missingIds.includes(s.id) || s.status === 'missing_audio') {
    emit('reconnect', s.id);
  } else {
    emit('select', s.id);
  }
}

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
  const ok = window.confirm(`删除「${m.title}」？\n\n分析结果会一起删除，重新分析需要重新跑一遍。\n音频文件本身不会被删除。`);
  if (ok) emit('delete', m.id);
}

// 菜单点别处 / 按 Esc 关掉。
// 监听挂在 window 上，**必须**在卸载时摘掉 —— 否则组件重建后旧监听还在，
// 每重建一次就多一份（切主题、HMR 时最容易积累）。
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeMenu();
}
if (typeof window !== 'undefined') {
  window.addEventListener('click', closeMenu);
  window.addEventListener('keydown', onKeydown);
}
onBeforeUnmount(() => {
  if (typeof window === 'undefined') return;
  window.removeEventListener('click', closeMenu);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <aside class="sidebar" :style="{ width: props.width + 'px', flex: `0 0 ${props.width}px` }">
    <div class="side-head">
      <div class="side-title">
        <span class="dot" />
        曲库
        <span class="count">{{ songs.length }}</span>
      </div>
      <button class="icon-btn" :disabled="busy || standalone" title="添加音乐（导入后自动分析）" @click="emit('add')">
        <svg v-if="!busy" width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        <span v-else class="spin">◌</span>
      </button>
    </div>

    <div class="search">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" />
        <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
      <input v-model="query" placeholder="搜索曲目 / 艺术家" />
    </div>

    <div class="filters">
      <button :class="['chip', { on: filter === 'all' }]" @click="filter = 'all'">全部</button>
      <button :class="['chip', { on: filter === 'done' }]" @click="filter = 'done'">已分析</button>
      <button :class="['chip', { on: filter === 'todo' }]" @click="filter = 'todo'">待处理</button>
    </div>

    <div class="song-list">
      <!-- 空态：引导用户添加音乐 -->
      <div v-if="songs.length === 0 && !busy" class="empty">
        <div class="empty-icon">♫</div>
        <div class="empty-title">{{ standalone ? '浏览器模式' : '曲库是空的' }}</div>
        <div class="empty-hint">
          {{
            standalone
              ? '导入功能需要 Tauri 后端，当前显示打包好的示例数据'
              : '点击右上角「+」添加音乐，导入后会自动开始分析'
          }}
        </div>
        <button v-if="!standalone" class="empty-btn" @click="emit('add')">添加音乐</button>
      </div>

      <button
        v-for="s in filtered"
        :key="s.id"
        :class="['song-item', { active: s.id === currentId, missing: missingIds.includes(s.id) || s.status === 'missing_audio' }]"
        @click="onClick(s)"
        @contextmenu.prevent="onContextMenu(s, $event)"
      >
        <div class="song-main">
          <div class="song-title">{{ s.title || '未命名' }}</div>
          <div class="song-sub">
            <span v-if="s.artist">{{ s.artist }}</span>
            <span v-if="s.artist" class="sep">·</span>
            <span>{{ fmtDur(s.duration_sec) }}</span>
          </div>

          <!-- 分析进度条 -->
          <div v-if="progress[s.id]" class="prog">
            <div class="prog-bar">
              <div class="prog-fill" :style="{ width: (progress[s.id].pct * 100).toFixed(0) + '%' }" />
            </div>
            <div class="prog-text">{{ progress[s.id].message }}</div>
          </div>
          <div v-else-if="s.status === 'failed' && s.error" class="song-err" :title="s.error">
            {{ s.error }}
          </div>
        </div>
        <div class="song-right">
          <span :class="['badge', statusClass(s)]">{{ statusLabel(s) }}</span>
        </div>
      </button>
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
    <div
      v-if="menu"
      class="ctx-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
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
}

.icon-btn {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 0;
  color: var(--text-secondary);
}
.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 12px 8px;
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
}

.song-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 7px 8px;
  border-radius: 0;
  margin-bottom: 1px;
  border-left: 2px solid transparent;
  transition: background 0.1s;
}
.song-item:hover {
  background: var(--bg-hover);
}
.song-item.active {
  background: var(--bg-active);
  border-left-color: var(--accent);
}

.song-main {
  flex: 1;
  min-width: 0;
}
.song-title {
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
.key {
  color: var(--text-secondary);
}

.song-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex: 0 0 auto;
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
.bars {
  font-size: 10px;
  color: var(--text-muted);
}

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
