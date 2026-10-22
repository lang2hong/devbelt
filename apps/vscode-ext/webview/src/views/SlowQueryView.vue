<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import type {
  SlowQueryFilterView,
  SlowQueryGroupView,
  SlowQueryRangeView,
  SlowQuerySortView,
} from '../../../src/result/protocol';
import { formatDuration, relativeAge, sqlPreview } from '../components/insights/types';

const { post, onMessage } = useVsCode();
const { t } = useI18n();

const filter = ref<SlowQueryFilterView>({ range: '7d', keyword: '', sort: 'total' });
const groups = ref<SlowQueryGroupView[]>([]);
const connections = ref<Array<{ id: string; name: string }>>([]);
const historySize = ref(0);
const historyLimit = ref(0);
const now = ref(Date.now());
const loaded = ref(false);
const error = ref('');
let keywordTimer: ReturnType<typeof setTimeout> | undefined;
let off: (() => void) | undefined;

const ranges: SlowQueryRangeView[] = ['24h', '7d', '30d', 'all'];
const sorts: SlowQuerySortView[] = ['total', 'avg', 'max', 'count'];

function sendFilter(): void {
  post({ type: 'slowFilter', filter: { ...filter.value } });
}

function onKeyword(): void {
  clearTimeout(keywordTimer);
  keywordTimer = setTimeout(sendFilter, 250);
}

function age(time: number): string {
  const { unit, n } = relativeAge(time, now.value);
  return t(`wv.slow.age.${unit}`, { n });
}

function openSql(group: SlowQueryGroupView): void {
  post({ type: 'slowOpenSql', key: group.key });
}

function explain(group: SlowQueryGroupView): void {
  post({ type: 'slowExplain', key: group.key });
}

onMounted(() => {
  off = onMessage((msg: any) => {
    if (msg.type === 'slowSnapshot') {
      filter.value = msg.filter;
      groups.value = Array.isArray(msg.groups) ? msg.groups : [];
      connections.value = Array.isArray(msg.connections) ? msg.connections : [];
      historySize.value = msg.historySize ?? 0;
      historyLimit.value = msg.historyLimit ?? 0;
      now.value = msg.now ?? Date.now();
      loaded.value = true;
      error.value = '';
    } else if (msg.type === 'error') {
      error.value = msg.message ?? '';
    }
  });
  post({ type: 'ready' });
});

onUnmounted(() => {
  off?.();
  clearTimeout(keywordTimer);
});
</script>

<template>
  <div class="app">
    <div class="toolbar">
      <span class="title">{{ t('wv.slow.title') }}</span>
      <label>
        <span class="label">{{ t('wv.slow.connection') }}</span>
        <select v-model="filter.connectionId" @change="sendFilter">
          <option :value="undefined">{{ t('wv.slow.allConnections') }}</option>
          <option v-for="c in connections" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </label>
      <label>
        <span class="label">{{ t('wv.slow.range') }}</span>
        <select v-model="filter.range" @change="sendFilter">
          <option v-for="r in ranges" :key="r" :value="r">{{ t(`wv.slow.range.${r}`) }}</option>
        </select>
      </label>
      <label>
        <span class="label">{{ t('wv.slow.sort') }}</span>
        <select v-model="filter.sort" @change="sendFilter">
          <option v-for="s in sorts" :key="s" :value="s">{{ t(`wv.slow.sort.${s}`) }}</option>
        </select>
      </label>
      <input
        v-model="filter.keyword"
        class="search"
        type="search"
        :placeholder="t('wv.slow.keyword')"
        :aria-label="t('wv.slow.keyword')"
        @input="onKeyword"
      />
    </div>

    <div class="meta">{{ t('wv.slow.sample', { size: historySize, limit: historyLimit }) }}</div>
    <div v-if="error" class="error">{{ error }}</div>

    <div v-if="loaded && groups.length === 0" class="empty">{{ t('wv.slow.empty') }}</div>

    <table v-else-if="groups.length > 0" class="grid">
      <thead>
        <tr>
          <th class="sql">{{ t('wv.slow.col.sql') }}</th>
          <th>{{ t('wv.slow.col.connection') }}</th>
          <th class="num">{{ t('wv.slow.col.count') }}</th>
          <th class="num">{{ t('wv.slow.col.total') }}</th>
          <th class="num">{{ t('wv.slow.col.avg') }}</th>
          <th class="num">{{ t('wv.slow.col.max') }}</th>
          <th>{{ t('wv.slow.col.last') }}</th>
          <th class="num">{{ t('wv.slow.col.failed') }}</th>
          <th>{{ t('wv.slow.col.actions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="g in groups" :key="g.key">
          <td class="sql" :title="g.sampleSql"><code>{{ sqlPreview(g.fingerprint) }}</code></td>
          <td>
            {{ g.connection }}<span v-if="g.database" class="muted"> · {{ g.database }}</span>
            <span v-if="g.missingConnection" class="badge">{{ t('wv.slow.deleted') }}</span>
          </td>
          <td class="num">{{ g.count }}</td>
          <td class="num">{{ formatDuration(g.totalMs) }}</td>
          <td class="num">{{ formatDuration(g.avgMs) }}</td>
          <td class="num">{{ formatDuration(g.maxMs) }}</td>
          <td>{{ age(g.lastTime) }}</td>
          <td class="num" :class="{ bad: g.failed > 0 }">{{ g.failed }}</td>
          <td class="actions">
            <button class="btn" @click="openSql(g)">{{ t('wv.slow.openSql') }}</button>
            <button class="btn" :disabled="g.missingConnection" @click="explain(g)">{{ t('wv.slow.explain') }}</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc); font-size: 12px; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
.title { font-weight: 600; font-size: 13px; margin-right: 6px; }
.label { color: var(--vscode-descriptionForeground, #888); margin-right: 4px; }
select, .search { font-size: 12px; padding: 2px 6px; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4); border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px; }
.search { flex: 1; min-width: 160px; }
.meta, .muted { color: var(--vscode-descriptionForeground, #888); }
.meta { padding: 4px 10px; }
.error { padding: 6px 10px; color: var(--vscode-errorForeground, #f48771); }
.empty { padding: 16px 10px; color: var(--vscode-descriptionForeground, #888); }
.grid { width: 100%; border-collapse: collapse; overflow: auto; }
.grid th, .grid td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.12)); text-align: left; white-space: nowrap; }
.grid th { position: sticky; top: 0; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-descriptionForeground, #888); font-weight: 500; }
.grid td.sql { max-width: 480px; overflow: hidden; text-overflow: ellipsis; }
.grid code { font-family: var(--vscode-editor-font-family, monospace); }
.num { text-align: right !important; font-variant-numeric: tabular-nums; }
.bad { color: var(--vscode-errorForeground, #f48771); }
.badge { margin-left: 6px; font-size: 10px; padding: 0 5px; border-radius: 8px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); }
.actions { display: flex; gap: 4px; }
.btn { padding: 2px 8px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
.btn:disabled { opacity: .5; cursor: default; }
</style>