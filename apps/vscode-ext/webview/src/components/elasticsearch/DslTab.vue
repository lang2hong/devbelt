<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import JsonTree from './JsonTree.vue';
import { aggregationRows, pushDslHistory, validateRestBody } from './types';
import type { EsDslHistoryItem, EsDocHit, SavedEsQueryView } from './types';

export interface EsDslErrorView { message: string; type: string | null; reason: string | null; rootCause: string[] }

const props = defineProps<{
  index: string;
  running: boolean;
  result: { took: number | null; timedOut: boolean | null; total: number | null; hits: EsDocHit[]; aggregations: unknown; raw: unknown; truncated: boolean } | null;
  error: EsDslErrorView | null;
  saved: SavedEsQueryView[];
  /** 「在 DSL 打开」预填（body+index）；at 变化即应用。 */
  seed?: { body: string; index: string; at: number } | null;
}>();
const emit = defineEmits<{
  (e: 'run', payload: { index: string; body: string }): void;
  (e: 'save', payload: { name: string; index: string; body: string }): void;
  (e: 'removeSaved', id: string): void;
  (e: 'indexChange', index: string): void;
}>();

const { t } = useI18n();
const index = ref(props.index);
const body = ref('{\n  "query": { "match_all": {} }\n}');
const localError = ref('');
const history = ref<EsDslHistoryItem[]>([]);
const showRaw = ref(false);
const saveName = ref('');

watch(() => props.index, (v) => { if (v) index.value = v; });
watch(() => props.seed, (s) => {
  if (!s) return;
  if (s.index) index.value = s.index;
  body.value = s.body;
}, { immediate: true });

function run(): void {
  const idx = index.value.trim();
  if (!idx) return;
  const checked = validateRestBody(body.value);
  if (!checked.ok) {
    localError.value = t('wv.es.invalidJson');
    return;
  }
  localError.value = '';
  history.value = pushDslHistory(history.value, { index: idx, body: body.value, at: Date.now() });
  emit('indexChange', idx);
  emit('run', { index: idx, body: body.value });
}
function save(): void {
  const name = saveName.value.trim();
  const idx = index.value.trim();
  if (!name || !idx) return;
  const checked = validateRestBody(body.value);
  if (!checked.ok) { localError.value = t('wv.es.invalidJson'); return; }
  saveName.value = '';
  emit('indexChange', idx);
  emit('save', { name, index: idx, body: body.value });
}
function loadSaved(q: SavedEsQueryView): void {
  index.value = q.index;
  body.value = q.body;
  emit('indexChange', q.index);
}
function useHistory(h: EsDslHistoryItem): void {
  if (h.index) index.value = h.index;
  body.value = h.body;
  emit('indexChange', h.index);
}

/** 聚合表格化（buckets 形态）；无法表格化时回退 JsonTree。 */
const aggRows = computed(() => (props.result?.aggregations ? aggregationRows(props.result.aggregations) : null));
</script>

<template>
  <div class="es-dsl">
    <div class="es-dsl-toolbar">
      <input v-model="index" class="es-dsl-index" :placeholder="t('wv.es.dsl.index')" />
      <span class="es-spacer" />
      <button class="es-dsl-run" :disabled="running" @click="run">{{ running ? t('wv.es.running') : t('wv.es.dsl.run') }}</button>
      <input v-model="saveName" class="es-dsl-savename" :placeholder="t('wv.es.dsl.saveName')" @keydown.enter="save" />
      <button class="es-link" @click="save">{{ t('wv.es.dsl.save') }}</button>
    </div>
    <textarea v-model="body" class="es-dsl-body" rows="8" @keydown.ctrl.enter.prevent="run" />
    <div v-if="localError" class="es-error">{{ localError }}</div>

    <div class="es-dsl-main">
      <div class="es-dsl-result">
        <div v-if="error" class="es-error">
          {{ error.message }}
          <div class="es-error-detail">{{ error.type }}<template v-if="error.rootCause.length"> · {{ error.rootCause.join(' · ') }}</template></div>
        </div>
        <div v-if="result" class="es-dsl-metrics">
          <span>{{ t('wv.es.dsl.metrics.took') }}: {{ result.took ?? '—' }} ms</span>
          <span>{{ t('wv.es.dsl.metrics.timedOut') }}: {{ result.timedOut ?? '—' }}</span>
          <span>{{ t('wv.es.dsl.metrics.total') }}: {{ result.total ?? '—' }}</span>
          <button class="es-link" @click="showRaw = !showRaw">{{ showRaw ? t('wv.es.dsl.hits') : t('wv.es.dsl.raw') }}</button>
        </div>
        <div class="es-dsl-content">
        <p v-if="result?.truncated" class="es-warn">{{ t('wv.es.response.truncated') }}</p>
        <template v-if="result && !showRaw">
          <table v-if="result.hits.length" class="es-dsl-hits">
            <thead><tr><th>{{ t('wv.es.docs.id') }}</th><th>{{ t('wv.es.docs.source') }}</th></tr></thead>
            <tbody>
              <tr v-for="h in result.hits" :key="h.id">
                <td class="es-doc-id-cell">{{ h.id }}</td>
                <td class="es-doc-preview">{{ JSON.stringify(h.source) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="es-empty">{{ t('wv.es.docs.empty') }}</div>
          <div v-if="result.aggregations" class="es-dsl-agg">
            <div class="es-section-title">{{ t('wv.es.dsl.aggregations') }}</div>
            <table v-if="aggRows?.length" class="es-dsl-hits">
              <thead><tr><th>{{ t('wv.es.dsl.agg.agg') }}</th><th>{{ t('wv.es.dsl.agg.key') }}</th><th>{{ t('wv.es.dsl.agg.docCount') }}</th><th /></tr></thead>
              <tbody>
                <tr v-for="(row, i) in aggRows" :key="i">
                  <td>{{ row.agg }}</td>
                  <td class="es-doc-id-cell">{{ row.key }}</td>
                  <td>{{ row.docCount }}</td>
                  <td class="es-agg-extra">{{ row.extra.map(([k, v]) => `${k}=${v}`).join(' · ') }}</td>
                </tr>
              </tbody>
            </table>
            <JsonTree v-else :value="result.aggregations" />
          </div>
        </template>
        <JsonTree v-else-if="result" :value="result.raw" fill />
        </div>
      </div>

      <div class="es-dsl-side">
        <div class="es-section-title">{{ t('wv.es.dsl.history') }}</div>
        <div v-if="!history.length" class="es-empty">{{ t('wv.es.history.empty') }}</div>
        <div v-for="(h, i) in history" :key="`${h.at}-${i}`" class="es-side-item" :title="h.index" @click="useHistory(h)">#{{ history.length - i }}</div>
        <div class="es-section-title">{{ t('wv.es.dsl.saved') }}</div>
        <div v-if="!saved.length" class="es-empty">{{ t('wv.es.dsl.savedEmpty') }}</div>
        <div v-for="q in saved" :key="q.id" class="es-side-item es-saved-row">
          <span class="es-saved-name" @click="loadSaved(q)">{{ q.name }}</span>
          <button class="es-link danger" @click="emit('removeSaved', q.id)">×</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.es-dsl { padding: 8px 12px; display: flex; flex-direction: column; flex: 1; min-height: 0; }
.es-dsl-toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.es-dsl-index { width: 220px; }
.es-spacer { flex: 1; }
.es-dsl-savename { width: 140px; }
.es-dsl-body { width: 100%; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.es-dsl-main { display: flex; gap: 12px; margin-top: 8px; flex: 1; min-height: 0; }
.es-dsl-result { flex: 3; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.es-dsl-content { flex: 1; min-height: 0; overflow: auto; }
.es-dsl-side { flex: 1; min-width: 150px; border-left: 1px solid var(--vscode-panel-border); padding-left: 8px; overflow: auto; min-height: 0; }
.es-dsl-metrics { display: flex; gap: 12px; font-size: 12px; margin-bottom: 4px; align-items: center; }
.es-dsl-hits { width: 100%; border-collapse: collapse; font-size: 12px; }
.es-dsl-hits th { text-align: left; border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 6px; }
.es-dsl-hits td { padding: 3px 6px; border-bottom: 1px solid var(--vscode-panel-border, #3333); }
.es-doc-id-cell { font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; }
.es-doc-preview { max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
.es-dsl-agg { margin-top: 8px; }
.es-agg-extra { opacity: .8; font-size: 11px; }
.es-section-title { font-weight: 600; font-size: 12px; margin: 6px 0 3px; }
.es-side-item { font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 3px; }
.es-side-item:hover { background: var(--vscode-list-hoverBackground); }
.es-saved-row { display: flex; justify-content: space-between; }
.es-saved-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.es-error { color: var(--vscode-errorForeground, #f85149); font-size: 12px; }
.es-error-detail { opacity: .8; }
.es-warn { color: var(--vscode-editorWarning-foreground, #d29922); font-size: 12px; }
.es-empty { opacity: .7; font-size: 12px; }
.es-link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; }
.es-link.danger { color: var(--vscode-errorForeground, #f85149); }
</style>