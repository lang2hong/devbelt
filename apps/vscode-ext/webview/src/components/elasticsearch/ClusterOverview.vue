<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../composables/useI18n';
import type { EsClusterSnapshot } from './types';

const props = defineProps<{ snapshot: EsClusterSnapshot | null }>();
const { t } = useI18n();

const health = computed<{ status?: string; numberOfNodes?: number; numberOfDataNodes?: number; activeShards?: number; unassignedShards?: number } | null>(() => {
  const h = props.snapshot?.health;
  return h ? (h as never) : null;
});
const statusClass = computed(() => {
  const s = health.value?.status;
  if (s === 'green') return 'ok';
  if (s === 'yellow') return 'warn';
  if (s === 'red') return 'bad';
  return 'unknown';
});
</script>

<template>
  <div class="es-cluster">
    <div class="es-cluster-toolbar">
      <span class="es-title">{{ snapshot?.clusterName || t('wv.es.cluster.name') }}</span>
    </div>
    <div v-if="snapshot" class="es-cards">
      <div class="es-card">
        <div class="es-card-label">{{ t('wv.es.cluster.status') }}</div>
        <div class="es-card-value" :class="statusClass">{{ health?.status ?? '—' }}</div>
      </div>
      <div class="es-card">
        <div class="es-card-label">{{ t('wv.es.cluster.version') }}</div>
        <div class="es-card-value">{{ snapshot.version ?? '—' }}</div>
      </div>
      <div class="es-card">
        <div class="es-card-label">{{ t('wv.es.cluster.name') }}</div>
        <div class="es-card-value">{{ snapshot.clusterName ?? '—' }}</div>
      </div>
      <div class="es-card">
        <div class="es-card-label">{{ t('wv.es.cluster.indices') }}</div>
        <div class="es-card-value">{{ snapshot.indicesCount ?? '—' }}</div>
      </div>
    </div>
    <div v-if="health" class="es-health-row">
      <span>{{ t('wv.es.cluster.nodes') }} {{ health.numberOfNodes ?? '—' }}</span>
      <span>{{ t('wv.es.cluster.dataNodes') }} {{ health.numberOfDataNodes ?? '—' }}</span>
      <span>{{ t('wv.es.cluster.activeShards') }} {{ health.activeShards ?? '—' }}</span>
      <span>{{ t('wv.es.cluster.unassignedShards') }} {{ health.unassignedShards ?? '—' }}</span>
    </div>
    <pre v-if="snapshot?.info" class="es-info-json">{{ JSON.stringify(snapshot.info, null, 2) }}</pre>
    <div v-else class="es-empty">{{ t('wv.es.cluster.empty') }}</div>
  </div>
</template>

<style scoped>
.es-cluster { padding: 8px 12px; }
.es-cluster-toolbar { margin-bottom: 8px; font-weight: 600; }
.es-cards { display: flex; gap: 8px; flex-wrap: wrap; }
.es-card { min-width: 120px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; }
.es-card-label { font-size: 11px; opacity: .7; }
.es-card-value { font-size: 16px; margin-top: 2px; }
.es-card-value.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.es-card-value.warn { color: var(--vscode-editorWarning-foreground, #d29922); }
.es-card-value.bad { color: var(--vscode-errorForeground, #f85149); }
.es-health-row { display: flex; gap: 14px; margin-top: 8px; font-size: 12px; opacity: .85; flex-wrap: wrap; }
.es-info-json { margin-top: 10px; max-height: 40vh; overflow: auto; font-size: 12px; }
.es-empty { margin-top: 10px; opacity: .7; }
</style>