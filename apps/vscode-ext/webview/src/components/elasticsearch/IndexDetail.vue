<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import JsonTree from './JsonTree.vue';
import { aliasNames, esErrorReason, needsConfirm } from './types';

export interface EsIndexOpResult {
  status: number;
  tookMs: number;
  body: unknown;
}

const props = defineProps<{
  name: string;
  mapping: unknown;
  settings: unknown;
  aliases: unknown;
  stats: unknown;
  truncated: { mapping: boolean; settings: boolean; aliases: boolean; stats: boolean };
  error: string;
  readOnly: boolean;
  opResult: EsIndexOpResult | null;
}>();
const emit = defineEmits<{
  (e: 'reload'): void;
  (e: 'op', payload: { method: string; path: string; body: string | null }): void;
}>();

const { t } = useI18n();
type SubTab = 'overview' | 'mapping' | 'settings' | 'aliases';
const tab = ref<SubTab>('overview');
const pendingAction = ref<{ key: string; method: string; path: string; body: string | null } | null>(null);
const newAlias = ref('');

/** 操作分级：close/forcemerge 先弹确认；open/refresh/flush 直接执行（DELETE 由 host typed 强确认）。 */
const ACTIONS = [
  { key: 'open', method: 'POST', suffix: '_open', body: null },
  { key: 'close', method: 'POST', suffix: '_close', body: null },
  { key: 'refresh', method: 'POST', suffix: '_refresh', body: null },
  { key: 'flush', method: 'POST', suffix: '_flush', body: null },
  { key: 'forcemerge', method: 'POST', suffix: '_forcemerge', body: null },
  { key: 'delete', method: 'DELETE', suffix: '', body: null },
] as const;

function ask(actionKey: string): void {
  const a = ACTIONS.find((x) => x.key === actionKey);
  if (!a) return;
  const p = `/${encodeURIComponent(props.name)}${a.suffix ? `/${a.suffix}` : ''}`;
  if (needsConfirm(a.key)) {
    pendingAction.value = { key: a.key, method: a.method, path: p, body: a.body };
    return;
  }
  emit('op', { method: a.method, path: p, body: a.body });
}
function confirmAction(): void {
  const a = pendingAction.value;
  pendingAction.value = null;
  if (a) emit('op', { method: a.method, path: a.path, body: a.body });
}
function cancelAction(): void { pendingAction.value = null; }

const aliases = computed(() => aliasNames(props.aliases));

/** N3：失败操作展示 ES 结构化原因。 */
const opReason = computed(() => esErrorReason(props.opResult?.body));

/** 概览基本统计（_stats._all.primaries 子集；缺字段容错）。 */
const statsSummary = computed<{ key: string; value: string }[]>(() => {
  const p = (props.stats as { _all?: { primaries?: Record<string, any> } } | null)?._all?.primaries;
  if (!p) return [];
  const rows: { key: string; value: string }[] = [];
  if (p.docs?.count !== undefined) rows.push({ key: 'wv.es.index.stats.docs', value: String(p.docs.count) });
  if (p.docs?.deleted !== undefined) rows.push({ key: 'wv.es.index.stats.deleted', value: String(p.docs.deleted) });
  if (p.store?.size_in_bytes !== undefined) rows.push({ key: 'wv.es.index.stats.store', value: formatBytes(Number(p.store.size_in_bytes)) });
  if (p.indexing?.index_total !== undefined) rows.push({ key: 'wv.es.index.stats.indexed', value: String(p.indexing.index_total) });
  if (p.search?.query_total !== undefined) rows.push({ key: 'wv.es.index.stats.searches', value: String(p.search.query_total) });
  return rows;
});

function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}
function addAlias(): void {
  const alias = newAlias.value.trim();
  if (!alias) return;
  newAlias.value = '';
  emit('op', {
    method: 'POST',
    path: '/_aliases',
    body: JSON.stringify({ actions: [{ add: { index: props.name, alias } }] }),
  });
}
function removeAlias(alias: string): void {
  emit('op', {
    method: 'POST',
    path: '/_aliases',
    body: JSON.stringify({ actions: [{ remove: { index: props.name, alias } }] }),
  });
}

watch(() => props.name, () => { tab.value = 'overview'; pendingAction.value = null; newAlias.value = ''; });
</script>

<template>
  <div v-if="!name" class="es-empty es-index-empty">{{ t('wv.es.index.empty') }}</div>
  <div v-else class="es-index">
    <div class="es-index-head">
      <span class="es-index-name">{{ name }}</span>
      <span v-if="readOnly" class="es-ro">{{ t('wv.es.readOnly') }}</span>
      <button class="es-link" @click="emit('reload')">{{ t('wv.es.refresh') }}</button>
    </div>

    <div v-if="error" class="es-error">{{ error }}</div>
    <template v-else>
      <nav class="es-subtabs">
        <button v-for="s in (['overview', 'mapping', 'settings', 'aliases'] as SubTab[])" :key="s"
          class="es-subtab" :class="{ active: tab === s }" @click="tab = s">{{ t(`wv.es.index.tab.${s}`) }}</button>
      </nav>

      <div v-if="opResult" class="es-op-result" :class="opResult.status >= 400 ? 'bad' : 'ok'">
        {{ t('wv.es.index.lastOp') }}: {{ opResult.status }} ({{ opResult.tookMs }} ms)
        <div v-if="opResult.status >= 400 && opReason" class="es-error-detail">{{ opReason }}</div>
        <pre class="es-op-body">{{ JSON.stringify(opResult.body, null, 2) }}</pre>
      </div>

      <div v-if="tab === 'overview'" class="es-overview">
        <div v-if="statsSummary.length" class="es-stats">
          <span class="es-stats-title">{{ t('wv.es.index.stats.title') }}</span>
          <div v-for="row in statsSummary" :key="row.key" class="es-stats-row">
            <span class="es-stats-label">{{ t(row.key) }}</span>
            <span class="es-stats-value">{{ row.value }}</span>
          </div>
        </div>
        <p v-if="truncated.stats" class="es-warn">{{ t('wv.es.response.truncated') }}</p>
        <div class="es-actions">
          <button v-for="a in ACTIONS" :key="a.key" class="es-action" :class="{ danger: a.key === 'delete', ro: readOnly }" :title="readOnly ? t('wv.es.roAction') : undefined" @click="ask(a.key)">
            {{ t(`wv.es.index.action.${a.key}`) }}
          </button>
        </div>
      </div>

      <div v-else-if="tab === 'mapping'">
        <p v-if="truncated.mapping" class="es-warn">{{ t('wv.es.response.truncated') }}</p>
        <JsonTree :value="mapping" />
      </div>

      <div v-else-if="tab === 'settings'">
        <p v-if="truncated.settings" class="es-warn">{{ t('wv.es.response.truncated') }}</p>
        <JsonTree :value="settings" />
      </div>

      <div v-else class="es-aliases">
        <template v-if="truncated.aliases"><p class="es-warn">{{ t('wv.es.response.truncated') }}</p></template>
        <div v-if="!aliases.length" class="es-empty">{{ t('wv.es.index.aliases.empty') }}</div>
        <div v-for="a in aliases" :key="a" class="es-alias-row">
          <span class="es-alias-name">{{ a }}</span>
          <button class="es-link" :class="{ ro: readOnly }" :title="readOnly ? t('wv.es.roAction') : undefined" @click="removeAlias(a)">{{ t('wv.es.index.aliases.remove') }}</button>
        </div>
        <div class="es-alias-add">
          <input v-model="newAlias" :placeholder="t('wv.es.index.aliases.placeholder')" @keydown.enter="addAlias" />
          <button class="es-link" :class="{ ro: readOnly }" :title="readOnly ? t('wv.es.roAction') : undefined" @click="addAlias">{{ t('wv.es.index.aliases.add') }}</button>
        </div>
      </div>
    </template>

    <div v-if="pendingAction" class="es-modal-backdrop">
      <div class="es-modal">
        <div class="es-modal-title">{{ t('wv.es.index.confirmTitle') }}</div>
        <p class="es-modal-detail">{{ pendingAction.method }} {{ pendingAction.path }}</p>
        <div class="es-modal-actions">
          <button class="es-confirm-ok" @click="confirmAction">{{ t('wv.es.confirm.ok') }}</button>
          <button class="es-confirm-cancel" @click="cancelAction">{{ t('wv.es.confirm.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.es-index { padding: 8px 12px; }
.es-index-head { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
.es-index-name { font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); }
.es-ro { color: var(--vscode-editorWarning-foreground, #d29922); font-size: 12px; }
.es-subtabs { display: flex; gap: 4px; margin-bottom: 6px; }
.es-subtab { background: none; border: none; padding: 3px 8px; cursor: pointer; color: var(--vscode-foreground); border-radius: 3px; }
.es-subtab.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.es-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.es-stats { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; font-size: 12px; }
.es-stats-title { font-weight: 600; }
.es-stats-row { display: flex; gap: 4px; }
.es-stats-label { opacity: .7; }
.es-stats-value { font-weight: 600; }
.es-action { padding: 3px 10px; cursor: pointer; }
.es-action.danger { color: var(--vscode-errorForeground, #f85149); }
.es-action.ro { border-color: var(--vscode-editorWarning-foreground, #d29922); }
.es-op-result { margin: 6px 0; font-size: 12px; }
.es-op-result.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.es-op-result.bad { color: var(--vscode-errorForeground, #f85149); }
.es-op-body { max-height: 18vh; overflow: auto; }
.es-alias-row { display: flex; gap: 8px; align-items: center; }
.es-alias-name { font-family: var(--vscode-editor-font-family, monospace); }
.es-alias-add { display: flex; gap: 6px; margin-top: 6px; }
.es-error { color: var(--vscode-errorForeground, #f85149); font-size: 12px; }
.es-warn { color: var(--vscode-editorWarning-foreground, #d29922); font-size: 12px; }
.es-empty { opacity: .7; font-size: 12px; }
.es-link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; }
.es-link.ro { color: var(--vscode-editorWarning-foreground, #d29922); }
.es-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.es-modal { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px 16px; width: min(420px, 90vw); }
.es-modal-title { font-weight: 700; margin-bottom: 6px; }
.es-modal-detail { font-family: var(--vscode-editor-font-family, monospace); opacity: .85; }
.es-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
</style>