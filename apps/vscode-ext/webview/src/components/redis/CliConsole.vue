<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { isNearBottom, pushCommandHistory } from './types';
import type { CommandResult } from './types';

const { t } = useI18n();
const props = defineProps<{
  results: CommandResult[];
  readOnly: boolean;
  pending: { id: string; command: string } | null;
  commands?: string[];
}>();

/** 补全候选：按当前输入的首个 token 前缀过滤（命令名由 host 下发，webview 不引 db-core）。 */
const suggestions = computed<string[]>(() => {
  const list = props.commands ?? [];
  if (!list.length) return [];
  const token = input.value.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  if (!token) return [];
  return list.filter((c) => c.startsWith(token)).slice(0, 50);
});
const emit = defineEmits<{
  (e: 'run', line: string): void;
  (e: 'confirm', id: string, accept: boolean): void;
}>();

const input = ref('');
const inputEl = ref<HTMLInputElement | null>(null);
const resultsEl = ref<HTMLElement | null>(null);
const commandHistory = ref<string[]>([]);
const historyIndex = ref(-1);
let historyDraft = '';
const hiddenIds = ref<Set<string>>(new Set());
const autoFollow = ref(true);
const hasNewOutput = ref(false);
const copiedId = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const visibleResults = computed(() => props.results.filter((r) => !hiddenIds.value.has(r.id)));
const lastResultId = computed(() => props.results[props.results.length - 1]?.id ?? '');

function submit(): void {
  if (props.pending) return;
  const line = input.value.trim();
  if (!line) return;
  commandHistory.value = pushCommandHistory(commandHistory.value, line);
  historyIndex.value = -1;
  historyDraft = '';
  emit('run', line);
  input.value = '';
}

function navigateHistory(direction: -1 | 1): void {
  const history = commandHistory.value;
  if (!history.length) return;
  if (direction < 0) {
    if (historyIndex.value === -1) {
      historyDraft = input.value;
      historyIndex.value = history.length - 1;
    } else if (historyIndex.value > 0) {
      historyIndex.value -= 1;
    }
    input.value = history[historyIndex.value] ?? '';
  } else {
    if (historyIndex.value === -1) return;
    if (historyIndex.value < history.length - 1) {
      historyIndex.value += 1;
      input.value = history[historyIndex.value] ?? '';
    } else {
      historyIndex.value = -1;
      input.value = historyDraft;
    }
  }
  void nextTick(() => inputEl.value?.focus());
}

function onKeydown(e: KeyboardEvent): void {
  if (props.pending) return;
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    navigateHistory(-1);
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    navigateHistory(1);
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

function scrollToBottom(): void {
  const el = resultsEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function onScroll(): void {
  const el = resultsEl.value;
  if (!el) return;
  const near = isNearBottom({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
  autoFollow.value = near;
  if (near) hasNewOutput.value = false;
}

function jumpToLatest(): void {
  autoFollow.value = true;
  hasNewOutput.value = false;
  void nextTick(scrollToBottom);
}

function clearOutput(): void {
  hiddenIds.value = new Set(props.results.map((r) => r.id));
  hasNewOutput.value = false;
}

async function copyEntry(entry: CommandResult): Promise<void> {
  const text = `> ${entry.command}\n${entry.ok ? entry.result : (entry.error ?? '')}`;
  try {
    await navigator.clipboard.writeText(text);
    copiedId.value = entry.id;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedId.value = null; }, 1500);
  } catch {
    copiedId.value = null;
  }
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (!props.pending) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('confirm', props.pending.id, false);
  } else if (e.key === 'Enter') {
    // 按钮获得焦点时交给 click，避免 Enter 触发两次确认。
    if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return;
    e.preventDefault();
    emit('confirm', props.pending.id, true);
  }
}

watch(lastResultId, async (id, previous) => {
  if (!id || id === previous) return;
  if (autoFollow.value) {
    await nextTick();
    scrollToBottom();
  } else {
    hasNewOutput.value = true;
  }
});

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown);
  void nextTick(() => {
    scrollToBottom();
    inputEl.value?.focus();
  });
});
onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown);
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="cli">
    <div class="toolbar">
      <span v-if="readOnly" class="badge">{{ t('wv.redis.readOnly') }}</span>
      <span class="hint">{{ t('wv.redis.console.hint') }}</span>
      <span class="spacer" />
      <button v-if="hasNewOutput" class="btn tiny" @click="jumpToLatest">{{ t('wv.redis.console.newOutput') }}</button>
      <button class="btn tiny" :disabled="!visibleResults.length" @click="clearOutput">{{ t('wv.redis.console.clear') }}</button>
    </div>
    <div ref="resultsEl" class="history" @scroll="onScroll">
      <div v-for="r in visibleResults" :key="r.id" class="entry" :class="{ err: !r.ok }">
        <div class="entry-head">
          <pre class="sent">&gt; {{ r.command }}</pre>
          <span class="cost">{{ t('wv.redis.console.duration', { ms: r.costMs }) }}</span>
          <button class="btn tiny" :title="copiedId === r.id ? t('wv.redis.console.copied') : t('wv.redis.console.copyEntry')" @click="copyEntry(r)">
            {{ copiedId === r.id ? '✓' : '⧉' }}
          </button>
        </div>
        <pre v-if="r.ok">{{ r.result }}</pre>
        <pre v-else class="error">{{ r.error }}</pre>
      </div>
      <div v-if="!visibleResults.length" class="empty">{{ t('wv.redis.console.empty') }}</div>
    </div>
    <div class="input-row">
      <input ref="inputEl" v-model="input" list="redis-cmd-suggest" :placeholder="t('wv.redis.console.placeholder')" @keydown="onKeydown" />
      <datalist id="redis-cmd-suggest">
        <option v-for="c in suggestions" :key="c" :value="c" />
      </datalist>
      <button class="btn" :disabled="!!pending" @click="submit">{{ t('wv.redis.console.run') }}</button>
    </div>
    <div v-if="pending" class="confirm-mask">
      <div class="confirm">
        <h4>{{ t('wv.redis.confirm.title') }}</h4>
        <p>{{ t('wv.redis.confirm.message', { command: pending.command }) }}</p>
        <div class="actions">
          <button class="btn" @click="emit('confirm', pending.id, true)">{{ t('wv.redis.confirm.run') }}</button>
          <button class="btn" @click="emit('confirm', pending.id, false)">{{ t('wv.redis.confirm.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cli { display: flex; flex-direction: column; height: 100%; position: relative; }
.toolbar { display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
.spacer { flex: 1; }
.badge { padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.history { flex: 1; overflow-y: auto; }
.entry { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); padding: 4px 0; }
.entry-head { display: flex; gap: 6px; align-items: flex-start; }
.entry pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.entry-head pre.sent { flex: 1; color: var(--vscode-descriptionForeground); }
.entry pre.error { color: var(--vscode-errorForeground); }
.cost { flex: none; font-size: 10px; color: var(--vscode-descriptionForeground); padding-top: 2px; }
.input-row { display: flex; gap: 6px; padding-top: 6px; }
.input-row input { flex: 1; padding: 4px 6px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; font-size: 12px; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.tiny { padding: 1px 5px; }
.btn:disabled { opacity: .45; cursor: default; }
.confirm-mask { position: absolute; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; }
.confirm { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); border-radius: 6px; padding: 14px 16px; max-width: 460px; }
.confirm h4 { margin: 0 0 8px; }
.confirm p { margin: 0 0 12px; font-size: 12px; word-break: break-all; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>