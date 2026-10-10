<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';
import type { EsNodeSummary } from './types';

export interface EsErrorView { message: string; type: string | null; reason: string | null; rootCause: string[] }

const props = defineProps<{
  items: EsNodeSummary[] | null;
  error: EsErrorView | null;
}>();
const { t } = useI18n();
</script>

<template>
  <div class="es-nodes">
    <div v-if="error" class="es-error">{{ error.message }}</div>
    <div v-else-if="items === null" class="es-empty">{{ t('wv.es.indices.loading') }}</div>
    <div v-else-if="!items.length" class="es-empty">{{ t('wv.es.nodes.empty') }}</div>
    <table v-else class="es-nodes-table">
      <thead>
        <tr>
          <th>{{ t('wv.es.nodes.name') }}</th>
          <th>{{ t('wv.es.nodes.ip') }}</th>
          <th>{{ t('wv.es.nodes.heap') }}</th>
          <th>{{ t('wv.es.nodes.ram') }}</th>
          <th>{{ t('wv.es.nodes.cpu') }}</th>
          <th>{{ t('wv.es.nodes.load') }}</th>
          <th>{{ t('wv.es.nodes.role') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="n in items" :key="n.name">
          <td class="es-node-name"><span v-if="n.master === '*'" class="es-master">★</span>{{ n.name }}</td>
          <td>{{ n.ip ?? '—' }}</td>
          <td>{{ n.heapPercent ?? '—' }}%</td>
          <td>{{ n.ramPercent ?? '—' }}%</td>
          <td>{{ n.cpu ?? '—' }}%</td>
          <td>{{ n.load1m ?? '—' }}</td>
          <td class="es-node-role">{{ n.role ?? '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.es-nodes { padding: 8px 12px; }
.es-nodes-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.es-nodes-table th { text-align: left; border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 6px; }
.es-nodes-table td { padding: 3px 6px; border-bottom: 1px solid var(--vscode-panel-border, #3333); }
.es-node-name { font-family: var(--vscode-editor-font-family, monospace); }
.es-node-role { font-family: var(--vscode-editor-font-family, monospace); opacity: .85; }
.es-master { color: var(--vscode-editorWarning-foreground, #d29922); margin-right: 4px; }
.es-error { color: var(--vscode-errorForeground, #f85149); font-size: 12px; }
.es-empty { opacity: .7; font-size: 12px; }
</style>