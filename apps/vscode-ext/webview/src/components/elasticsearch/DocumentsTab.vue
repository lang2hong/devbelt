<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import JsonTree from './JsonTree.vue';
import { detectSearchMode, docSavePath, esErrorReason, fieldSuggestions, textToSearchBody, validateDslBody } from './types';
import type { EsDocHit, EsFieldInfo } from './types';

export interface EsDocsErrorView { message: string; type: string | null; reason: string | null; rootCause: string[] }

const props = defineProps<{
  index: string;
  hits: EsDocHit[] | null;
  total: number | null;
  truncated: boolean;
  error: EsDocsErrorView | null;
  opResult: { status: number; tookMs: number; body: unknown } | null;
  readOnly: boolean;
  query: string;
  queryMode: 'text' | 'dsl';
  defaultOperator: 'OR' | 'AND';
  fields: EsFieldInfo[];
}>();
const emit = defineEmits<{
  (e: 'load', searchAfter: unknown[] | null): void;
  (e: 'search', payload: { mode: 'text' | 'dsl'; query: string; operator: 'OR' | 'AND' }): void;
  (e: 'openDsl', payload: { body: string }): void;
  (e: 'jump', payload: { docId: string }): void;
  (e: 'next'): void;
  (e: 'prev'): void;
  (e: 'op', payload: { method: string; path: string; body: string | null }): void;
}>();

const { t } = useI18n();
const expanded = ref<string | null>(null);
/**
 * 搜索本地态：文本模式（query_string）/ DSL 模式（完整 search body）。
 * 首字符输入 `{` 自动升级到 DSL 并把文本转成等价 body；回车/Ctrl+Enter 提交。
 */
const mode = ref<'text' | 'dsl'>(props.queryMode);
const searchInput = ref(props.queryMode === 'text' ? props.query : '');
const dslText = ref(props.queryMode === 'dsl' ? props.query : '');
const fieldPick = ref('');
const operator = ref<'OR' | 'AND'>(props.defaultOperator);
const searchError = ref('');
const suggestions = computed(() => fieldSuggestions(props.fields, searchInput.value));

function submitSearch(): void {
  if (mode.value === 'dsl') {
    const raw = dslText.value.trim();
    if (!raw) { emit('search', { mode: 'dsl', query: '', operator: operator.value }); return; }
    if (!validateDslBody(raw)) { searchError.value = t('wv.es.invalidJson'); return; }
    searchError.value = '';
    emit('search', { mode: 'dsl', query: raw, operator: operator.value });
    return;
  }
  searchError.value = '';
  emit('search', { mode: 'text', query: searchInput.value, operator: operator.value });
}
function clearSearch(): void {
  searchInput.value = '';
  dslText.value = '';
  searchError.value = '';
  emit('search', { mode: mode.value, query: '', operator: operator.value });
}
const DEFAULT_DSL = '{\n  "query": { "match_all": {} }\n}';
/** 文本输入以 `{` 开头 → 自动升级 DSL（粘贴 JSON 原样保留；仅输入 `{` 给模板）。 */
function onTextInput(): void {
  if (detectSearchMode(searchInput.value) !== 'dsl') return;
  const v = searchInput.value;
  dslText.value = v.trim() === '{' ? DEFAULT_DSL : (v.includes('"') ? v : textToSearchBody(v));
  mode.value = 'dsl';
}
function toggleMode(): void {
  if (mode.value === 'text') {
    dslText.value = searchInput.value.trim() ? textToSearchBody(searchInput.value) : dslText.value || textToSearchBody('');
    mode.value = 'dsl';
  } else {
    mode.value = 'text';
  }
  searchError.value = '';
}
function insertField(path: string): void {
  const cur = searchInput.value;
  searchInput.value = cur && !/[\s(]$/.test(cur) ? `${cur} AND ${path}:` : `${cur}${path}:`;
}
function openInDsl(): void {
  const body = mode.value === 'dsl' && dslText.value.trim()
    ? dslText.value
    : textToSearchBody(searchInput.value);
  emit('openDsl', { body });
}
const jumpId = ref('');
/** 编辑态：null=关闭；id=null 表示新建；seqNo/primaryTerm 用于保存时乐观并发（N2）。 */
const editor = ref<{ id: string | null; text: string; seqNo: number | null; primaryTerm: number | null } | null>(null);
const editorError = ref('');
const pendingDelete = ref<string | null>(null);

watch(() => props.index, () => {
  expanded.value = null;
  editor.value = null;
  jumpId.value = '';
  pendingDelete.value = null;
});
watch(() => props.query, (q) => {
  if (props.queryMode === 'dsl') dslText.value = q;
  else searchInput.value = q;
});
watch(() => props.queryMode, (m) => { mode.value = m; });

function toggle(id: string): void { expanded.value = expanded.value === id ? null : id; }
function startEdit(hit: EsDocHit): void {
  editor.value = { id: hit.id, text: JSON.stringify(hit.source ?? {}, null, 2), seqNo: hit.seqNo ?? null, primaryTerm: hit.primaryTerm ?? null };
  editorError.value = '';
}
function startNew(): void {
  editor.value = { id: null, text: '{\n  \n}', seqNo: null, primaryTerm: null };
  editorError.value = '';
}
function saveDoc(): void {
  const e = editor.value;
  if (!e) return;
  try {
    JSON.parse(e.text);
  } catch {
    editorError.value = t('wv.es.invalidJson');
    return;
  }
  editorError.value = '';
  const path = e.id
    ? docSavePath(props.index, e.id, e.seqNo, e.primaryTerm)
    : `/${encodeURIComponent(props.index)}/_doc`;
  emit('op', { method: e.id ? 'PUT' : 'POST', path, body: e.text });
  editor.value = null;
}
function askDelete(id: string): void { pendingDelete.value = id; }
function confirmDelete(): void {
  const id = pendingDelete.value;
  pendingDelete.value = null;
  if (id) emit('op', { method: 'DELETE', path: `/${encodeURIComponent(props.index)}/_doc/${encodeURIComponent(id)}`, body: null });
}
function jump(): void {
  const id = jumpId.value.trim();
  if (!id) return;
  jumpId.value = '';
  // N1：走专用 esGetDoc 链路（esDoc → 单命中渲染）；不再经 REST op 管线（结果体不展示）。
  emit('jump', { docId: id });
}
const errorClass = computed(() => (props.opResult?.status ?? 0) >= 400 || (props.opResult?.status ?? -1) === 0 ? 'bad' : 'ok');
/** N3：失败操作展示 ES 结构化原因。 */
const opReason = computed(() => esErrorReason(props.opResult?.body));
</script>

<template>
  <div class="es-docs">
    <div class="es-docs-toolbar">
      <span class="es-docs-index">{{ index }}</span>
      <span v-if="total !== null" class="es-docs-total">{{ t('wv.es.docs.total') }}: {{ total }}</span>
      <span class="es-spacer" />
      <button class="es-link" @click="emit('prev')">‹ {{ t('wv.es.docs.prev') }}</button>
      <button class="es-link" @click="emit('next')">{{ t('wv.es.docs.next') }} ›</button>
      <button class="es-link" @click="emit('load', null)">{{ t('wv.es.refresh') }}</button>
      <button class="es-link" :class="{ ro: readOnly }" :title="readOnly ? t('wv.es.roAction') : undefined" @click="startNew">+ {{ t('wv.es.docs.newDoc') }}</button>
      <input v-model="jumpId" class="es-docs-jump" :placeholder="t('wv.es.docs.jumpPlaceholder')" @keydown.enter="jump" />
      <button class="es-link" @click="jump">{{ t('wv.es.docs.jump') }}</button>
    </div>
    <div class="es-docs-search">
      <button class="es-link es-docs-mode" :title="t('wv.es.docs.modeHint')" @click="toggleMode">
        {{ mode === 'text' ? t('wv.es.docs.mode.dsl') : t('wv.es.docs.mode.text') }}
      </button>
      <template v-if="mode === 'text'">
        <input v-model="searchInput" class="es-docs-search-input" list="es-doc-fields" :placeholder="t('wv.es.docs.searchPlaceholder')"
          @keydown.enter="submitSearch" @input="onTextInput" />
        <datalist id="es-doc-fields">
          <option v-for="f in suggestions" :key="f.path" :value="f.path">{{ f.type }}</option>
        </datalist>
        <select class="es-docs-fields" :title="t('wv.es.docs.fields')" @change="insertField(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
          <option value="">{{ t('wv.es.docs.fields') }}</option>
          <option v-for="f in fields" :key="f.path" :value="f.path">{{ f.path }} ({{ f.type }})</option>
        </select>
        <select v-model="operator" class="es-docs-operator" :title="t('wv.es.docs.operator')">
          <option value="OR">OR</option>
          <option value="AND">AND</option>
        </select>
      </template>
      <textarea v-else v-model="dslText" class="es-docs-search-dsl" rows="4" :placeholder="t('wv.es.docs.dslPlaceholder')"
        @keydown.ctrl.enter.prevent="submitSearch" />
      <button class="es-link" @click="submitSearch">{{ t('wv.es.docs.search') }}</button>
      <button class="es-link" @click="clearSearch">{{ t('wv.es.docs.clear') }}</button>
      <button class="es-link" @click="openInDsl">{{ t('wv.es.docs.openDsl') }}</button>
    </div>
    <div v-if="searchError" class="es-error">{{ searchError }}</div>

    <div v-if="error" class="es-error">
      {{ error.message }}
      <div v-if="error.type" class="es-error-detail">{{ error.type }}<template v-if="error.rootCause.length"> · {{ error.rootCause.join(' · ') }}</template></div>
    </div>
    <div v-if="opResult" class="es-op-result" :class="errorClass">
      {{ t('wv.es.index.lastOp') }}: {{ opResult.status }} ({{ opResult.tookMs }} ms)
      <div v-if="opResult.status === 409" class="es-error-detail">{{ t('wv.es.docs.versionConflict') }}</div>
      <div v-else-if="opResult.status >= 400 && opReason" class="es-error-detail">{{ opReason }}</div>
    </div>
    <p v-if="truncated" class="es-warn">{{ t('wv.es.response.truncated') }}</p>

    <div v-if="editor" class="es-doc-editor">
      <div class="es-doc-editor-head">
        <span>{{ editor.id ? `${t('wv.es.docs.edit')} ${editor.id}` : t('wv.es.docs.newDoc') }}</span>
        <input v-if="!editor.id" class="es-doc-id" :placeholder="t('wv.es.docs.idPlaceholder')"
          @input="(ev: Event) => { if (editor) editor.id = (ev.target as HTMLInputElement).value.trim() || null }" />
      </div>
      <textarea v-model="editor.text" class="es-doc-source" rows="8" />
      <div v-if="editorError" class="es-error">{{ editorError }}</div>
      <div class="es-doc-editor-actions">
        <button :class="{ ro: readOnly }" :title="readOnly ? t('wv.es.roAction') : undefined" @click="saveDoc">{{ t('wv.es.docs.save') }}</button>
        <button @click="editor = null">{{ t('wv.es.confirm.cancel') }}</button>
      </div>
    </div>

    <div v-if="hits === null && !error" class="es-empty">{{ t('wv.es.indices.loading') }}</div>
    <div v-else-if="!hits?.length && !error" class="es-empty">{{ t('wv.es.docs.empty') }}</div>
    <table v-else-if="hits?.length" class="es-docs-table">
      <thead><tr><th>{{ t('wv.es.docs.id') }}</th><th>{{ t('wv.es.docs.source') }}</th><th /></tr></thead>
      <tbody>
        <template v-for="hit in hits" :key="hit.id">
          <tr class="es-doc-row" @click="toggle(hit.id)">
            <td class="es-doc-id-cell">{{ hit.id }}</td>
            <td class="es-doc-preview">{{ JSON.stringify(hit.source) }}</td>
            <td class="es-doc-actions">
              <button class="es-link" :class="{ ro: readOnly }" :title="readOnly ? t('wv.es.roAction') : undefined" @click.stop="startEdit(hit)">{{ t('wv.es.docs.edit') }}</button>
              <button class="es-link danger" :class="{ ro: readOnly }" :title="readOnly ? t('wv.es.roAction') : undefined" @click.stop="askDelete(hit.id)">{{ t('wv.es.docs.delete') }}</button>
            </td>
          </tr>
          <tr v-if="expanded === hit.id"><td colspan="3"><JsonTree :value="hit.source" /></td></tr>
        </template>
      </tbody>
    </table>

    <div v-if="pendingDelete" class="es-modal-backdrop">
      <div class="es-modal">
        <div class="es-modal-title">{{ t('wv.es.docs.confirmDelete') }}</div>
        <p class="es-modal-detail">{{ pendingDelete }}</p>
        <div class="es-modal-actions">
          <button @click="confirmDelete">{{ t('wv.es.confirm.ok') }}</button>
          <button @click="pendingDelete = null">{{ t('wv.es.confirm.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.es-docs { padding: 8px 12px; }
.es-docs-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; font-size: 12px; }
.es-docs-index { font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); }
.es-docs-total { opacity: .7; }
.es-spacer { flex: 1; }
.es-docs-jump { width: 140px; }
.es-docs-search { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.es-docs-search-input { flex: 1; font-family: var(--vscode-editor-font-family, monospace); }
.es-docs-search-dsl { flex: 1; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.es-docs-fields { max-width: 220px; }
.es-docs-operator { width: 70px; }
.es-docs-mode { font-weight: 600; }
.es-docs-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.es-docs-table th { text-align: left; border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 6px; }
.es-docs-table td { padding: 3px 6px; border-bottom: 1px solid var(--vscode-panel-border, #3333); vertical-align: top; }
.es-doc-row { cursor: pointer; }
.es-doc-row:hover { background: var(--vscode-list-hoverBackground); }
.es-doc-id-cell { font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; }
.es-doc-preview { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
.es-doc-actions { white-space: nowrap; }
.es-doc-editor { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; margin: 6px 0; }
.es-doc-editor-head { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; font-size: 12px; }
.es-doc-id { flex: 1; }
.es-doc-source { width: 100%; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.es-doc-editor-actions { display: flex; gap: 6px; margin-top: 4px; }
.es-error { color: var(--vscode-errorForeground, #f85149); font-size: 12px; }
.es-error-detail { opacity: .8; }
.es-op-result { font-size: 12px; margin: 4px 0; }
.es-op-result.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.es-op-result.bad { color: var(--vscode-errorForeground, #f85149); }
.es-warn { color: var(--vscode-editorWarning-foreground, #d29922); font-size: 12px; }
.es-empty { opacity: .7; font-size: 12px; }
.es-link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; }
.es-link.danger { color: var(--vscode-errorForeground, #f85149); }
.es-link.ro { color: var(--vscode-editorWarning-foreground, #d29922); }
.es-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.es-modal { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px 16px; width: min(420px, 90vw); }
.es-modal-title { font-weight: 700; margin-bottom: 6px; }
.es-modal-detail { font-family: var(--vscode-editor-font-family, monospace); opacity: .85; }
.es-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
</style>