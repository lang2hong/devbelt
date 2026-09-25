<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';
import type { SlowlogEntry } from './types';

const { t } = useI18n();
defineProps<{ entries: SlowlogEntry[] }>();
const emit = defineEmits<{ (e: 'refresh'): void }>();

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toLocaleString();
}
</script>

<template>
  <div class="slowlog">
    <div class="toolbar">
      <button class="btn" @click="emit('refresh')">{{ t('wv.redis.refresh') }}</button>
    </div>
    <div v-if="entries.length" class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('wv.redis.slowlog.id') }}</th>
            <th>{{ t('wv.redis.slowlog.time') }}</th>
            <th>{{ t('wv.redis.slowlog.duration') }}</th>
            <th>{{ t('wv.redis.slowlog.command') }}</th>
            <th>{{ t('wv.redis.slowlog.client') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in entries" :key="e.id">
            <td>{{ e.id }}</td>
            <td>{{ formatTime(e.timestamp) }}</td>
            <td>{{ e.durationMicros }}</td>
            <td class="cmd">{{ e.command }}</td>
            <td>{{ e.clientAddr }}{{ e.clientName ? ' / ' + e.clientName : '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty">{{ t('wv.redis.slowlog.empty') }}</div>
  </div>
</template>

<style scoped>
.slowlog { display: flex; flex-direction: column; height: 100%; }
.toolbar { padding: 4px 0; }
.table-wrap { flex: 1; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); }
th { color: var(--vscode-descriptionForeground); font-weight: 500; position: sticky; top: 0; background: var(--vscode-editor-background); }
.cmd { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
