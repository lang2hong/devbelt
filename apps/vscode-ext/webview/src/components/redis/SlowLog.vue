<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { filterSlowlog, formatDurationMicros } from './types';
import type { SlowlogEntry } from './types';

const { t } = useI18n();
const props = defineProps<{ entries: SlowlogEntry[] }>();
const emit = defineEmits<{ (e: 'refresh'): void }>();

const query = ref('');
const sortBy = ref<'id' | 'timestamp' | 'durationMicros'>('timestamp');
const desc = ref(true);
const copiedId = ref<number | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const shown = computed(() => {
  const filtered = filterSlowlog(props.entries, query.value);
  const sorted = [...filtered].sort((a, b) => a[sortBy.value] - b[sortBy.value]);
  return desc.value ? sorted.reverse() : sorted;
});

function toggleSort(by: 'id' | 'timestamp' | 'durationMicros'): void {
  if (sortBy.value === by) desc.value = !desc.value;
  else {
    sortBy.value = by;
    desc.value = true;
  }
}
function sortMark(by: 'id' | 'timestamp' | 'durationMicros'): string {
  return sortBy.value === by ? (desc.value ? ' ↓' : ' ↑') : '';
}
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toLocaleString();
}
async function copyCommand(entry: SlowlogEntry): Promise<void> {
  try {
    await navigator.clipboard.writeText(entry.command);
    copiedId.value = entry.id;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedId.value = null; }, 1500);
  } catch {
    copiedId.value = null;
  }
}
onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="slowlog">
    <div class="toolbar">
      <button class="btn" @click="emit('refresh')">{{ t('wv.redis.refresh') }}</button>
      <input v-model="query" class="filter" :placeholder="t('wv.redis.slowlog.search')" />
      <span class="count">{{ t('wv.redis.slowlog.count', { count: shown.length }) }}</span>
    </div>
    <div v-if="shown.length" class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="sortable" @click="toggleSort('id')">{{ t('wv.redis.slowlog.id') }}{{ sortMark('id') }}</th>
            <th class="sortable" @click="toggleSort('timestamp')">{{ t('wv.redis.slowlog.time') }}{{ sortMark('timestamp') }}</th>
            <th class="sortable" @click="toggleSort('durationMicros')">{{ t('wv.redis.slowlog.duration') }}{{ sortMark('durationMicros') }}</th>
            <th>{{ t('wv.redis.slowlog.command') }}</th>
            <th>{{ t('wv.redis.slowlog.client') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in shown" :key="e.id">
            <td>{{ e.id }}</td>
            <td>{{ formatTime(e.timestamp) }}</td>
            <td class="duration">{{ formatDurationMicros(e.durationMicros) }}</td>
            <td class="cmd">{{ e.command }}</td>
            <td>{{ e.clientAddr }}{{ e.clientName ? ' / ' + e.clientName : '' }}</td>
            <td class="row-actions">
              <button class="btn tiny" :title="copiedId === e.id ? t('wv.redis.console.copied') : t('wv.redis.slowlog.copy')" @click="copyCommand(e)">{{ copiedId === e.id ? '✓' : '⧉' }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty">{{ t('wv.redis.slowlog.empty') }}</div>
  </div>
</template>

<style scoped>
.slowlog { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 4px 0; }
.filter { width: 190px; max-width: 45vw; padding: 2px 5px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.count { font-size: 11px; color: var(--vscode-descriptionForeground); }
.table-wrap { flex: 1; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); }
th { color: var(--vscode-descriptionForeground); font-weight: 500; position: sticky; top: 0; background: var(--vscode-editor-background); white-space: nowrap; }
th.sortable { cursor: pointer; user-select: none; }
.cmd { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.duration { white-space: nowrap; font-variant-numeric: tabular-nums; }
.row-actions { white-space: nowrap; text-align: right; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.tiny { padding: 1px 5px; }
</style>