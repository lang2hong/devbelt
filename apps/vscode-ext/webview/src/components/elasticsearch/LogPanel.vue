<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { filterEsLogEntries } from './types';
import type { EsLogEntryView } from '../../../../src/result/protocol';

const props = defineProps<{ items: EsLogEntryView[] }>();
const { t } = useI18n();

const query = ref('');
const onlyErrors = ref(false);
const paused = ref(false);
const frozen = ref<EsLogEntryView[] | null>(null);
const clearedBefore = ref<number | null>(null);
const logEl = ref<HTMLElement | null>(null);
const autoFollow = ref(true);
const hasNew = ref(false);

const source = computed(() => (paused.value && frozen.value ? frozen.value : props.items));
const shown = computed(() => {
  const threshold = clearedBefore.value;
  const visible = threshold === null ? source.value : source.value.filter((e) => e.time > threshold);
  return filterEsLogEntries(visible, query.value, onlyErrors.value);
});
const lastIncomingKey = computed(() => {
  const last = props.items[props.items.length - 1];
  return last ? `${last.time}:${last.method}:${last.path}` : '';
});

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

function scrollToBottom(): void {
  const el = logEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onScroll(): void {
  const el = logEl.value;
  if (!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  autoFollow.value = near;
  if (near) hasNew.value = false;
}
function jumpToLatest(): void {
  autoFollow.value = true;
  hasNew.value = false;
  void nextTick(scrollToBottom);
}
function clearLog(): void {
  clearedBefore.value = props.items.reduce((max, e) => Math.max(max, e.time), 0);
  hasNew.value = false;
}

watch(paused, (isPaused) => {
  frozen.value = isPaused ? props.items.slice() : null;
  if (!isPaused) {
    hasNew.value = false;
    if (autoFollow.value) void nextTick(scrollToBottom);
  }
});
watch(lastIncomingKey, async (key, previous) => {
  if (!key || key === previous || paused.value) return;
  if (autoFollow.value) {
    await nextTick();
    scrollToBottom();
  } else {
    hasNew.value = true;
  }
});
onMounted(() => {
  void nextTick(scrollToBottom);
});
</script>

<template>
  <div class="es-log">
    <div class="es-log-toolbar">
      <input v-model="query" class="es-log-filter" :placeholder="t('wv.es.log.filter')" />
      <label class="es-log-only-errors">
        <input v-model="onlyErrors" type="checkbox" />
        {{ t('wv.es.log.onlyErrors') }}
      </label>
      <span v-if="paused" class="es-log-paused">{{ t('wv.es.log.paused') }}</span>
      <span class="es-log-count">{{ t('wv.es.log.count', { count: shown.length }) }}</span>
      <span class="es-log-spacer" />
      <button v-if="hasNew" class="es-link" @click="jumpToLatest">{{ t('wv.es.log.newEntries') }}</button>
      <button class="es-link" @click="paused = !paused">{{ paused ? t('wv.es.log.resume') : t('wv.es.log.pause') }}</button>
      <button class="es-link" :disabled="!props.items.length" @click="clearLog">{{ t('wv.es.log.clear') }}</button>
    </div>
    <div ref="logEl" class="es-log-body" @scroll="onScroll">
      <div v-if="!shown.length" class="es-empty">{{ t('wv.es.log.empty') }}</div>
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
          <tr v-for="(e, i) in shown" :key="`${e.time}-${i}`">
            <td>{{ timeText(e.time) }}</td>
            <td class="es-log-method">{{ e.method }}</td>
            <td class="es-log-path">
              <div>{{ e.path }}</div>
              <div v-if="e.error" class="es-log-error">{{ e.error }}</div>
            </td>
            <td><span class="es-log-status" :class="statusClass(e.status)">{{ e.status }}</span></td>
            <td>{{ e.tookMs }} ms</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.es-log { padding: 8px 12px; display: flex; flex-direction: column; min-height: 0; flex: 1; }
.es-log-toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding-bottom: 6px; }
.es-log-filter { width: 190px; max-width: 45vw; padding: 2px 5px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.es-log-only-errors { display: flex; gap: 3px; align-items: center; font-size: 11px; opacity: .85; }
.es-log-paused { color: var(--vscode-editorWarning-foreground, #d29922); font-size: 11px; }
.es-log-count { font-size: 11px; opacity: .7; }
.es-log-spacer { flex: 1; }
.es-log-body { flex: 1; min-height: 0; overflow: auto; }
.es-log-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.es-log-table th { text-align: left; border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 6px; }
.es-log-table td { padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border, #3333); vertical-align: top; }
.es-log-method { font-weight: 600; }
.es-log-path { font-family: var(--vscode-editor-font-family, monospace); }
.es-log-error { color: var(--vscode-errorForeground, #f85149); font-size: 11px; margin-top: 2px; }
.es-log-status.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.es-log-status.warn { color: var(--vscode-editorWarning-foreground, #d29922); }
.es-log-status.bad { color: var(--vscode-errorForeground, #f85149); }
.es-empty { opacity: .7; font-size: 12px; }
.es-link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; padding: 0; }
.es-link:disabled { opacity: .4; cursor: default; }
</style>