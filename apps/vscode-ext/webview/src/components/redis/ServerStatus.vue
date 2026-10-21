<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { parseRedisInfoSections, redisInfoValue } from './types';

const { t } = useI18n();
const props = defineProps<{ info: string }>();
const emit = defineEmits<{ (e: 'refresh'): void }>();

const query = ref('');
const showRaw = ref(false);
const copied = ref(false);
const SECTION_KEYS: Record<string, string> = {
  server: 'wv.redis.status.section.server',
  clients: 'wv.redis.status.section.clients',
  memory: 'wv.redis.status.section.memory',
  persistence: 'wv.redis.status.section.persistence',
  stats: 'wv.redis.status.section.stats',
  replication: 'wv.redis.status.section.replication',
  cpu: 'wv.redis.status.section.cpu',
  commandstats: 'wv.redis.status.section.commandstats',
  latencystats: 'wv.redis.status.section.latencystats',
  errorstats: 'wv.redis.status.section.errorstats',
  cluster: 'wv.redis.status.section.cluster',
  keyspace: 'wv.redis.status.section.keyspace',
  modules: 'wv.redis.status.section.modules',
  keysizes: 'wv.redis.status.section.keysizes',
};
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const sections = computed(() => parseRedisInfoSections(props.info));
const filteredSections = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return sections.value;
  return sections.value
    .map((section) => {
      const headerMatch = section.name.toLowerCase().includes(q);
      return {
        ...section,
        rows: headerMatch ? section.rows : section.rows.filter(([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q)),
      };
    })
    .filter((section) => section.name.toLowerCase().includes(q) || section.rows.length > 0);
});
const summary = computed<{ label: string; value: string }[]>(() => {
  const rows: { label: string; value: string }[] = [];
  const uptime = redisInfoValue(sections.value, 'uptime_in_seconds');
  const clients = redisInfoValue(sections.value, 'connected_clients');
  const memory = redisInfoValue(sections.value, 'used_memory_human') ?? redisInfoValue(sections.value, 'used_memory');
  const ops = redisInfoValue(sections.value, 'instantaneous_ops_per_sec');
  if (uptime !== null) rows.push({ label: t('wv.redis.status.uptime'), value: formatUptime(Number(uptime)) });
  if (clients !== null) rows.push({ label: t('wv.redis.status.clients'), value: clients });
  if (memory !== null) rows.push({ label: t('wv.redis.status.memory'), value: memory });
  if (ops !== null) rows.push({ label: t('wv.redis.status.ops'), value: ops });
  return rows;
});

function sectionLabel(name: string): string {
  const key = SECTION_KEYS[name.trim().toLowerCase()];
  return key ? t(key) : name;
}
function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${min}m` : `${min}m`;
}
async function copyInfo(): Promise<void> {
  if (!props.info) return;
  try {
    await navigator.clipboard.writeText(props.info);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    copied.value = false;
  }
}
onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="server-status">
    <div class="toolbar">
      <button class="btn" @click="emit('refresh')">{{ t('wv.redis.refresh') }}</button>
      <input v-if="!showRaw" v-model="query" class="filter" :placeholder="t('wv.redis.status.search')" />
      <span v-if="!showRaw && query" class="count">{{ t('wv.redis.status.count', { count: filteredSections.length }) }}</span>
      <span class="spacer" />
      <button class="btn" :disabled="!info" @click="copyInfo">{{ copied ? t('wv.redis.status.copied') : t('wv.redis.status.copy') }}</button>
      <button class="btn" @click="showRaw = !showRaw">{{ showRaw ? t('wv.redis.status.sections') : t('wv.redis.status.raw') }}</button>
    </div>
    <div v-if="!info" class="empty">{{ t('wv.redis.status.empty') }}</div>
    <pre v-else-if="showRaw" class="raw">{{ info }}</pre>
    <div v-else class="sections">
      <div v-if="summary.length" class="summary">
        <div v-for="s in summary" :key="s.label" class="card">
          <div class="k">{{ s.label }}</div>
          <div class="v">{{ s.value }}</div>
        </div>
      </div>
      <div v-if="!filteredSections.length" class="empty">{{ t('wv.redis.status.noMatch') }}</div>
      <details v-for="(s, i) in filteredSections" :key="`${s.name}-${i}`" class="section" :open="!!query || i < 3">
        <summary>{{ s.name ? sectionLabel(s.name) : t('wv.redis.status.general') }} <span class="section-count">{{ s.rows.length }}</span></summary>
        <table>
          <tbody>
            <tr v-for="([k, v], ri) in s.rows" :key="`${k}-${ri}`">
              <td class="key">{{ k }}</td>
              <td class="val">{{ v }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </div>
  </div>
</template>

<style scoped>
.server-status { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 4px 0; }
.filter { width: 190px; max-width: 45vw; padding: 2px 5px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.count { font-size: 11px; color: var(--vscode-descriptionForeground); }
.spacer { flex: 1; }
.sections { flex: 1; overflow-y: auto; }
.summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; padding-bottom: 8px; }
.card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); border-radius: 4px; padding: 6px 8px; }
.card .k { font-size: 11px; color: var(--vscode-descriptionForeground); }
.card .v { font-size: 14px; font-variant-numeric: tabular-nums; }
.section { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); padding: 4px 0; }
.section summary { cursor: pointer; font-weight: 600; font-size: 12px; color: var(--vscode-descriptionForeground); }
.section-count { font-weight: 400; opacity: .7; margin-left: 4px; }
.section table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 2px; }
.section td { padding: 1px 6px; vertical-align: top; }
.section td.key { width: 34%; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); word-break: break-all; }
.section td.val { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.raw { flex: 1; overflow: auto; margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn:disabled { opacity: .45; cursor: default; }
</style>