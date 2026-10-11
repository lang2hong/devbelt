<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { bodyAllowedFor, validateRestBody } from './types';
import type { EsRestHistoryItem } from './types';

export interface EsRestResultView {
  id: string;
  status: number;
  tookMs: number;
  headers: Record<string, string | string[]>;
  body: unknown;
  truncated: boolean;
}

const props = defineProps<{
  readOnly: boolean;
  running: boolean;
  result: EsRestResultView | null;
}>();
const emit = defineEmits<{
  (e: 'send', payload: { id: string; method: string; path: string; body: string | null }): void;
}>();

const { t } = useI18n();
const method = ref('GET');
const path = ref('');
const body = ref('');
const history = ref<EsRestHistoryItem[]>([]);
const showHeaders = ref(false);
const localError = ref('');
let seq = 0;
function nextId(): string { seq += 1; return `e${seq}`; }

const methods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'];
// ES 支持 GET 带 body（GET /idx/_search 等）；仅 HEAD 无意义禁用。
const bodyDisabled = computed(() => !bodyAllowedFor(method.value));

function send(): void {
  if (props.running) return; // 在途请求期间 Enter/历史双击不再绕过按钮 disabled 重复提交
  const p = path.value.trim();
  if (!p) return;
  const raw = bodyDisabled.value ? '' : body.value;
  const checked = validateRestBody(raw);
  if (!checked.ok) {
    localError.value = t('wv.es.invalidJson');
    return;
  }
  localError.value = '';
  const id = nextId();
  history.value.unshift({ id, method: method.value, path: p, body: checked.body, status: 0, tookMs: 0, at: Date.now() });
  if (history.value.length > 30) history.value.pop();
  emit('send', { id, method: method.value, path: p, body: checked.body });
}
function reuse(item: EsRestHistoryItem): void {
  method.value = item.method;
  path.value = item.path;
  body.value = item.body ?? '';
}
function clearHistory(): void { history.value = []; }
function sendHistory(item: EsRestHistoryItem): void { reuse(item); send(); }

const prettyBody = computed(() => {
  const b = props.result?.body;
  if (b === null || b === undefined) return '';
  try { return JSON.stringify(b, null, 2); } catch { return String(b); }
});
const headerRows = computed(() => Object.entries(props.result?.headers ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v] as const));
const statusClass = computed(() => {
  const s = props.result?.status ?? 0;
  if (s === 0) return 'bad';
  if (s < 300) return 'ok';
  if (s < 400) return 'warn';
  return 'bad';
});
</script>

<template>
  <div class="es-rest">
    <div class="es-rest-request">
      <select v-model="method" class="es-method">
        <option v-for="m in methods" :key="m" :value="m">{{ m }}</option>
      </select>
      <input v-model="path" class="es-path" :placeholder="t('wv.es.path')" @keydown.enter="send" />
      <button class="es-send" :disabled="running" @click="send">{{ running ? t('wv.es.running') : t('wv.es.send') }}</button>
    </div>
    <div v-if="readOnly" class="es-readonly">{{ t('wv.es.readOnly') }}</div>
    <textarea v-model="body" :disabled="bodyDisabled" class="es-body" :placeholder="t('wv.es.body')" rows="4" />
    <div v-if="localError" class="es-error">{{ localError }}</div>

    <div class="es-rest-main">
      <div class="es-result">
        <div class="es-section-title">{{ t('wv.es.response.status') }}</div>
        <div v-if="result" class="es-result-meta">
          <span class="es-status" :class="statusClass">{{ result.status }}</span>
          <span>{{ t('wv.es.response.took') }} {{ result.tookMs }} ms</span>
          <button class="es-link" @click="showHeaders = !showHeaders">{{ t('wv.es.response.headers') }}</button>
          <span v-if="result.truncated" class="es-truncated">{{ t('wv.es.response.truncated') }}</span>
        </div>
        <table v-if="showHeaders && headerRows.length" class="es-headers">
          <tr v-for="[k, v] in headerRows" :key="k"><td>{{ k }}</td><td>{{ v }}</td></tr>
        </table>
        <pre v-if="prettyBody" class="es-response-body">{{ prettyBody }}</pre>
        <div v-else-if="!result" class="es-empty">{{ t('wv.es.response.empty') }}</div>
      </div>

      <div class="es-history">
        <div class="es-section-title">
          {{ t('wv.es.history') }}
          <button v-if="history.length" class="es-link" @click="clearHistory">{{ t('wv.es.history.clear') }}</button>
        </div>
        <div v-if="!history.length" class="es-empty">{{ t('wv.es.history.empty') }}</div>
        <div v-for="item in history" :key="item.id" class="es-history-item" @click="reuse(item)" @dblclick="sendHistory(item)">
          <span class="es-history-method">{{ item.method }}</span>
          <span class="es-history-path">{{ item.path }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.es-rest { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
.es-rest-request { display: flex; gap: 6px; }
.es-method { width: 90px; }
.es-path { flex: 1; }
.es-readonly { font-size: 12px; color: var(--vscode-editorWarning-foreground, #d29922); }
.es-body { width: 100%; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.es-error { color: var(--vscode-errorForeground, #f85149); font-size: 12px; }
.es-rest-main { display: flex; gap: 12px; min-height: 0; }
.es-result { flex: 3; min-width: 0; }
.es-history { flex: 1; min-width: 160px; border-left: 1px solid var(--vscode-panel-border); padding-left: 8px; }
.es-section-title { font-weight: 600; font-size: 12px; margin-bottom: 4px; display: flex; justify-content: space-between; }
.es-result-meta { display: flex; gap: 10px; font-size: 12px; align-items: center; margin-bottom: 4px; }
.es-status { font-weight: 700; }
.es-status.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.es-status.warn { color: var(--vscode-editorWarning-foreground, #d29922); }
.es-status.bad { color: var(--vscode-errorForeground, #f85149); }
.es-headers { width: 100%; font-size: 11px; opacity: .85; margin-bottom: 4px; }
.es-headers td { vertical-align: top; padding-right: 8px; }
.es-response-body { max-height: 46vh; overflow: auto; font-size: 12px; }
.es-history-item { font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.es-history-item:hover { background: var(--vscode-list-hoverBackground); }
.es-history-method { font-weight: 600; margin-right: 6px; }
.es-empty { opacity: .7; font-size: 12px; }
.es-link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; padding: 0; }
.es-truncated { font-size: 11px; color: var(--vscode-editorWarning-foreground, #d29922); }
</style>