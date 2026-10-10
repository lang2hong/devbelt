<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';
import type { EsLogEntryView } from '../../../../src/result/protocol';

const props = defineProps<{ items: EsLogEntryView[] }>();
const { t } = useI18n();

function timeText(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function statusClass(status: number): string {
  if (status === 0) return 'bad';
  if (status < 300) return 'ok';
  if (status < 400) return 'warn';
  return 'bad';
}
</script>

<template>
  <div class="es-log">
    <div v-if="!items.length" class="es-empty">{{ t('wv.es.log.empty') }}</div>
    <table v-else class="es-log-table">
      <thead>
        <tr>
          <th>{{ t('wv.es.log.time') }}</th>
          <th>{{ t('wv.es.log.method') }}</th>
          <th>{{ t('wv.es.log.path') }}</th>
          <th>{{ t('wv.es.log.status') }}</th>
          <th>{{ t('wv.es.log.took') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(e, i) in items" :key="`${e.time}-${i}`">
          <td>{{ timeText(e.time) }}</td>
          <td class="es-log-method">{{ e.method }}</td>
          <td class="es-log-path">{{ e.path }}</td>
          <td><span class="es-log-status" :class="statusClass(e.status)">{{ e.status }}</span></td>
          <td>{{ e.tookMs }} ms</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.es-log { padding: 8px 12px; }
.es-log-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.es-log-table th { text-align: left; border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 6px; }
.es-log-table td { padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border, #3333); }
.es-log-method { font-weight: 600; }
.es-log-path { font-family: var(--vscode-editor-font-family, monospace); }
.es-log-status.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.es-log-status.warn { color: var(--vscode-editorWarning-foreground, #d29922); }
.es-log-status.bad { color: var(--vscode-errorForeground, #f85149); }
.es-empty { opacity: .7; font-size: 12px; }
</style>