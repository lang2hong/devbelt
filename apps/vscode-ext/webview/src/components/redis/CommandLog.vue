<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { filterCommandLog, isNearBottom } from './types';

interface CommandLogEntry { command: string; args: string[]; durationMs: number; ok: boolean; error: string | null; at: number }
interface ConnectionEvent { event: string; detail: string | null; at: number }

const props = defineProps<{
  entries: CommandLogEntry[];
  events: ConnectionEvent[];
}>();
const { t } = useI18n();
const EVENT_KEYS: Record<string, string> = {
  connect: 'wv.redis.event.connect',
  ready: 'wv.redis.event.ready',
  reconnecting: 'wv.redis.event.reconnecting',
  end: 'wv.redis.event.end',
  close: 'wv.redis.event.close',
  error: 'wv.redis.event.error',
};
function eventLabel(event: string): string {
  const key = EVENT_KEYS[event];
  return key ? t(key) : event;
}

const query = ref('');
const onlyFailed = ref(false);
const paused = ref(false);
const frozen = ref<CommandLogEntry[] | null>(null);
const clearedBefore = ref<number | null>(null);
const logEl = ref<HTMLElement | null>(null);
const autoFollow = ref(true);
const hasNewLog = ref(false);

const sourceEntries = computed(() => (paused.value && frozen.value ? frozen.value : props.entries));
const shownEntries = computed(() => {
  const threshold = clearedBefore.value;
  const visible = threshold === null ? sourceEntries.value : sourceEntries.value.filter((e) => e.at > threshold);
  return filterCommandLog(visible, query.value, onlyFailed.value);
});
const lastIncomingKey = computed(() => {
  const last = props.entries[props.entries.length - 1];
  return last ? `${last.at}:${last.command}:${last.args.join(' ')}` : '';
});

watch(paused, (isPaused) => {
  frozen.value = isPaused ? props.entries.slice() : null;
  if (!isPaused) {
    hasNewLog.value = false;
    if (autoFollow.value) void nextTick(scrollToBottom);
  }
});

function scrollToBottom(): void {
  const el = logEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onScroll(): void {
  const el = logEl.value;
  if (!el) return;
  const near = isNearBottom({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
  autoFollow.value = near;
  if (near) hasNewLog.value = false;
}
function jumpToLatest(): void {
  autoFollow.value = true;
  hasNewLog.value = false;
  void nextTick(scrollToBottom);
}
function clearLog(): void {
  clearedBefore.value = props.entries.reduce((max, e) => Math.max(max, e.at), 0);
  hasNewLog.value = false;
}

watch(lastIncomingKey, async (key, previous) => {
  if (!key || key === previous || paused.value) return;
  if (autoFollow.value) {
    await nextTick();
    scrollToBottom();
  } else {
    hasNewLog.value = true;
  }
});

onMounted(() => {
  void nextTick(scrollToBottom);
});
</script>

<template>
  <div class="cmdlog">
    <div class="toolbar">
      <input v-model="query" class="filter" :placeholder="t('wv.redis.commandLog.filter')" />
      <label class="only-failed">
        <input v-model="onlyFailed" type="checkbox" />
        {{ t('wv.redis.commandLog.onlyFailed') }}
      </label>
      <span v-if="paused" class="paused">{{ t('wv.redis.commandLog.paused') }}</span>
      <span class="count">{{ t('wv.redis.commandLog.count', { count: shownEntries.length }) }}</span>
      <span class="spacer" />
      <button v-if="hasNewLog" class="btn tiny" @click="jumpToLatest">{{ t('wv.redis.commandLog.newOutput') }}</button>
      <button class="btn tiny" @click="paused = !paused">{{ paused ? t('wv.redis.commandLog.resume') : t('wv.redis.commandLog.pause') }}</button>
      <button class="btn tiny" :disabled="!props.entries.length" @click="clearLog">{{ t('wv.redis.commandLog.clear') }}</button>
    </div>
    <div ref="logEl" class="log-body" @scroll="onScroll">
      <div class="events">
        <strong>{{ t('wv.redis.events.title') }}</strong>
        <div v-if="!props.events.length" class="empty">{{ t('wv.redis.events.empty') }}</div>
        <div v-for="(e, i) in props.events" :key="'e' + i" class="ev">
          {{ new Date(e.at).toLocaleTimeString() }} · {{ eventLabel(e.event) }}{{ e.detail ? ' ' + e.detail : '' }}
        </div>
      </div>
      <div v-if="!shownEntries.length" class="empty">{{ t('wv.redis.commandLog.empty') }}</div>
      <table v-else>
        <thead>
          <tr>
            <th>{{ t('wv.redis.commandLog.time') }}</th>
            <th>{{ t('wv.redis.commandLog.command') }}</th>
            <th>{{ t('wv.redis.commandLog.cost') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(e, i) in shownEntries" :key="`${e.at}-${i}`" :class="{ err: !e.ok }">
            <td>{{ new Date(e.at).toLocaleTimeString() }}</td>
            <td class="mono">
              <div>{{ e.command }} {{ e.args.join(' ') }}</div>
              <div v-if="e.error" class="err-detail">{{ e.error }}</div>
            </td>
            <td>{{ t('wv.redis.console.duration', { ms: e.durationMs }) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.cmdlog { flex: 1; min-height: 0; display: flex; flex-direction: column; font-size: 12px; }
.toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 2px 0 6px; }
.filter { width: 180px; max-width: 45vw; padding: 2px 5px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.only-failed { display: flex; gap: 3px; align-items: center; color: var(--vscode-descriptionForeground); font-size: 11px; }
.paused { color: var(--vscode-editorWarning-foreground, #d29922); font-size: 11px; }
.count { color: var(--vscode-descriptionForeground); font-size: 11px; }
.spacer { flex: 1; }
.log-body { flex: 1; min-height: 0; overflow: auto; }
.cmdlog table { width: 100%; border-collapse: collapse; }
.cmdlog th, .cmdlog td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); vertical-align: top; }
.cmdlog .mono { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.cmdlog tr.err td { color: var(--vscode-errorForeground); }
.err-detail { opacity: .85; font-size: 11px; margin-top: 2px; }
.cmdlog .empty { color: var(--vscode-descriptionForeground); padding: 12px; text-align: center; }
.cmdlog .events { padding: 2px 0 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); }
.cmdlog .ev { color: var(--vscode-descriptionForeground); font-size: 11px; }
.btn { padding: 2px 7px; font-size: 11px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.tiny { padding: 1px 5px; }
.btn:disabled { opacity: .45; cursor: default; }
</style>