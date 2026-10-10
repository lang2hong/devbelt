<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import JsonTree from './JsonTree.vue';
import type { EsIndexSummary } from './types';

const props = defineProps<{
  items: EsIndexSummary[] | null;
  error: string;
}>();
const emit = defineEmits<{
  (e: 'refresh'): void;
  (e: 'open', name: string): void;
}>();

const { t } = useI18n();
const query = ref('');
const sortBy = ref<'name' | 'health'>('name');
const desc = ref(false);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const base = (props.items ?? []).filter((i) => !q || i.name.toLowerCase().includes(q));
  const HEALTH_ORDER: Record<string, number> = { green: 0, yellow: 1, red: 2 };
  const sorted = [...base].sort((a, b) => {
    if (sortBy.value === 'health') {
      const ha = a.health === null ? 3 : HEALTH_ORDER[a.health];
      const hb = b.health === null ? 3 : HEALTH_ORDER[b.health];
      if (ha !== hb) return ha - hb;
    }
    return a.name.localeCompare(b.name);
  });
  return desc.value ? sorted.reverse() : sorted;
});

function toggleSort(by: 'name' | 'health'): void {
  if (sortBy.value === by) desc.value = !desc.value;
  else { sortBy.value = by; desc.value = false; }
}
function healthClass(h: string | null): string {
  return h === 'green' ? 'ok' : h === 'yellow' ? 'warn' : h === 'red' ? 'bad' : 'unknown';
}
</script>

<template>
  <div class="es-indices">
    <div class="es-indices-toolbar">
      <input v-model="query" class="es-indices-search" :placeholder="t('wv.es.indices.search')" />
      <button class="es-link" @click="emit('refresh')">{{ t('wv.es.refresh') }}</button>
    </div>
    <div v-if="error" class="es-error">{{ error }}</div>
    <div v-else-if="items === null" class="es-empty">{{ t('wv.es.indices.loading') }}</div>
    <table v-else class="es-indices-table">
      <thead>
        <tr>
          <th class="sortable" @click="toggleSort('name')">{{ t('wv.es.indices.name') }}{{ sortBy === 'name' ? (desc ? ' ↓' : ' ↑') : '' }}</th>
          <th class="sortable" @click="toggleSort('health')">{{ t('wv.es.indices.health') }}{{ sortBy === 'health' ? (desc ? ' ↓' : ' ↑') : '' }}</th>
          <th>{{ t('wv.es.indices.status') }}</th>
          <th>{{ t('wv.es.indices.docs') }}</th>
          <th>{{ t('wv.es.indices.store') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in filtered" :key="item.name" class="es-indices-row" @click="emit('open', item.name)">
          <td class="es-index-name">{{ item.name }}</td>
          <td><span class="es-health" :class="healthClass(item.health)">{{ item.health ?? '—' }}</span></td>
          <td>{{ item.status ?? '—' }}</td>
          <td>{{ item.docsCount ?? '—' }}</td>
          <td>{{ item.storeSize ?? '—' }}</td>
        </tr>
        <tr v-if="!filtered.length"><td colspan="5" class="es-empty">{{ t('wv.es.indices.empty') }}</td></tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.es-indices { padding: 8px 12px; }
.es-indices-toolbar { display: flex; gap: 8px; margin-bottom: 6px; align-items: center; }
.es-indices-search { flex: 1; }
.es-indices-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.es-indices-table th { text-align: left; border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 6px; }
.es-indices-table th.sortable { cursor: pointer; user-select: none; }
.es-indices-table td { padding: 3px 6px; border-bottom: 1px solid var(--vscode-panel-border, #3333); }
.es-indices-row { cursor: pointer; }
.es-indices-row:hover { background: var(--vscode-list-hoverBackground); }
.es-index-name { font-family: var(--vscode-editor-font-family, monospace); }
.es-health.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.es-health.warn { color: var(--vscode-editorWarning-foreground, #d29922); }
.es-health.bad { color: var(--vscode-errorForeground, #f85149); }
.es-error { color: var(--vscode-errorForeground, #f85149); font-size: 12px; }
.es-empty { opacity: .7; font-size: 12px; text-align: center; }
.es-link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; }
</style>