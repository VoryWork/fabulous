<script setup lang="ts">
/**
 * 重新匹配音频 Dialog。
 *
 * ## 匹配规则（用户指定）
 *
 * **只要时长差 < 0.5s 就接受。**
 *
 * 为什么用时长而不是内容哈希：
 *   - 同一首歌的不同来源（CD 抓轨 / 流媒体 / 不同码率）字节完全不同，
 *     整文件哈希必然对不上
 * - 时长是最稳的特征，不同编码的差异通常 < 0.1s
 * - **避开版权掣肘**：我们不需要保存音频内容，只比一个数字
 *
 * 头尾哈希作为**辅助信息**展示（一致 = 几乎确定是同一个文件），
 * 但**不作为接受条件**——因为用户可能换了来源。
 */
import { computed, ref } from 'vue';
import { open } from '@tauri-apps/plugin-dialog';
import {
  confirmReconnect,
  evaluateReconnectCandidate,
  type ReconnectVerdict,
  type SongListItem,
} from '../api/backend';

const props = defineProps<{
  song: SongListItem;
  /** 原文件的指纹（用于显示"希望能找到多长的文件"） */
  expectedDurationSec: number;
}>();

const emit = defineEmits<{
  (e: 'resolved'): void;
  (e: 'cancel'): void;
}>();

const picking = ref(false);
const verdict = ref<ReconnectVerdict | null>(null);
const chosenPath = ref<string | null>(null);
const error = ref<string | null>(null);
const confirming = ref(false);

const TOLERANCE = 0.5;

const canConfirm = computed(
  () => verdict.value?.accepted === true && chosenPath.value != null && !confirming.value,
);

async function pick() {
  picking.value = true;
  error.value = null;
  try {
    const picked = await open({
      multiple: false,
      directory: false,
      title: `为「${props.song.title}」重新选择音频文件`,
      filters: [
        {
          name: '音频文件',
          extensions: ['flac', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'wma'],
        },
      ],
    });
    if (typeof picked !== 'string') {
      picking.value = false;
      return;
    }
    chosenPath.value = picked;
    verdict.value = await evaluateReconnectCandidate(props.song.id, picked);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    picking.value = false;
  }
}

async function confirm() {
  if (!chosenPath.value) return;
  confirming.value = true;
  error.value = null;
  try {
    await confirmReconnect(props.song.id, chosenPath.value);
    emit('resolved');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    confirming.value = false;
  }
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2);
  return `${m}:${s.padStart(5, '0')}`;
}
</script>

<template>
  <div class="dlg-backdrop" @click.self="emit('cancel')">
    <div class="dlg">
      <header class="dlg-head">
        <div class="dlg-title">音频文件已失效</div>
        <button class="dlg-close" title="取消" @click="emit('cancel')">×</button>
      </header>

      <div class="dlg-body">
        <p class="dlg-desc">
          「<b>{{ song.title }}</b>」的原音频找不到了：<br />
          <code class="path">{{ song.audio_path }}</code>
        </p>

        <div class="expect">
          <span class="expect-label">原文件时长</span>
          <span class="expect-value">{{ fmtDuration(expectedDurationSec) }}</span>
          <span class="expect-hint">（匹配容差 ±{{ TOLERANCE }}s）</span>
        </div>

        <button class="pick-btn" :disabled="picking" @click="pick">
          {{ picking ? '读取中…' : '选择新的音频文件' }}
        </button>

        <div v-if="chosenPath" class="chosen-path" :title="chosenPath">
          {{ chosenPath }}
        </div>

        <!-- 评估结果 -->
        <div v-if="verdict" class="verdict" :class="verdict.accepted ? 'ok' : 'bad'">
          <div class="verdict-row">
            <span class="v-icon">{{ verdict.accepted ? '✓' : '✗' }}</span>
            <span class="v-text">
              {{
                verdict.accepted
                  ? '时长匹配，可以使用这个文件'
                  : `时长差 ${verdict.duration_delta_sec.toFixed(2)}s，超过 ${TOLERANCE}s 容差`
              }}
            </span>
          </div>
          <div class="verdict-detail">
            <div class="vd-row">
              <span>原文件</span>
              <span>{{ fmtDuration(verdict.expected.duration_sec) }}</span>
            </div>
            <div class="vd-row">
              <span>新文件</span>
              <span>{{ fmtDuration(verdict.actual.duration_sec) }}</span>
            </div>
            <div class="vd-row">
              <span>差值</span>
              <span>{{ verdict.duration_delta_sec.toFixed(3) }}s</span>
            </div>
            <div class="vd-row">
              <span>头尾哈希</span>
              <span :class="verdict.hash_ok ? 'good' : 'muted'">
                {{ verdict.hash_ok ? '一致（同一文件）' : '不同（可能是其他来源）' }}
              </span>
            </div>
          </div>
          <div v-if="!verdict.hash_ok" class="vd-note">
            哈希不同不代表选错——不同来源、不同码率的同一首歌字节必然不同，
            只要时长在容差内就接受。
          </div>
        </div>

        <div v-if="error" class="err">{{ error }}</div>
      </div>

      <footer class="dlg-foot">
        <button class="btn" @click="emit('cancel')">稍后处理</button>
        <button class="btn primary" :disabled="!canConfirm" @click="confirm">
          {{ confirming ? '保存中…' : '确认使用此文件' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.dlg-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.28);
  display: grid;
  place-items: center;
  z-index: 2000;
}

.dlg {
  width: 520px;
  max-width: calc(100vw - 40px);
  background: #fff;
  border: 1px solid var(--border-strong);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.22);
}

.dlg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.dlg-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--warning);
}
.dlg-close {
  width: 22px;
  height: 22px;
  font-size: 17px;
  line-height: 1;
  color: var(--text-muted);
}
.dlg-close:hover {
  color: var(--text-primary);
}

.dlg-body {
  padding: 14px;
}

.dlg-desc {
  margin: 0 0 12px;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.path {
  display: inline-block;
  margin-top: 4px;
  padding: 2px 5px;
  background: var(--bg-track);
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-all;
  font-family: ui-monospace, monospace;
}

.expect {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-panel-alt);
  border: 1px solid var(--border);
  margin-bottom: 12px;
}
.expect-label {
  font-size: 11px;
  color: var(--text-muted);
}
.expect-value {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.expect-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.pick-btn {
  width: 100%;
  height: 34px;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
  font-weight: 500;
}
.pick-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}
.pick-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.chosen-path {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
  font-family: ui-monospace, monospace;
  word-break: break-all;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

.verdict {
  margin-top: 12px;
  border: 1px solid;
  padding: 10px;
}
.verdict.ok {
  border-color: rgba(34, 160, 107, 0.4);
  background: rgba(34, 160, 107, 0.06);
}
.verdict.bad {
  border-color: rgba(229, 72, 77, 0.4);
  background: rgba(229, 72, 77, 0.06);
}

.verdict-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 8px;
}
.v-icon {
  font-size: 14px;
  font-weight: 700;
}
.verdict.ok .v-icon {
  color: var(--success);
}
.verdict.bad .v-icon {
  color: var(--danger);
}
.v-text {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
}

.verdict-detail {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px 14px;
  font-size: 11.5px;
}
.vd-row {
  display: flex;
  justify-content: space-between;
  color: var(--text-secondary);
}
.vd-row span:last-child {
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.good {
  color: var(--success);
}
.muted {
  color: var(--text-muted);
}

.vd-note {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}

.err {
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--danger);
}

.dlg-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel-alt);
}
.btn {
  height: 30px;
  padding: 0 14px;
  font-size: 12px;
  border: 1px solid var(--border-strong);
  background: #fff;
  color: var(--text-secondary);
}
.btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.btn.primary:hover:not(:disabled) {
  background: var(--accent-hover);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
