<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
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

function submit(): void {
  const line = input.value.trim();
  if (!line) return;
  emit('run', line);
  input.value = '';
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="cli">
    <div class="toolbar">
      <span v-if="readOnly" class="badge">{{ t('wv.redis.readOnly') }}</span>
      <span class="hint">{{ t('wv.redis.console.hint') }}</span>
    </div>
    <div class="history">
      <div v-for="r in results" :key="r.id" class="entry" :class="{ err: !r.ok }">
        <pre class="sent">&gt; {{ r.command }}</pre>
        <pre v-if="r.ok">{{ r.result }}</pre>
        <pre v-else class="error">{{ r.error }}</pre>
        <span class="cost">{{ t('wv.redis.console.duration', { ms: r.costMs }) }}</span>
      </div>
      <div v-if="!results.length" class="empty">{{ t('wv.redis.console.empty') }}</div>
    </div>
    <div class="input-row">
      <input v-model="input" list="redis-cmd-suggest" :placeholder="t('wv.redis.console.placeholder')" @keydown="onKeydown" />
      <datalist id="redis-cmd-suggest">
        <option v-for="c in suggestions" :key="c" :value="c" />
      </datalist>
      <button class="btn" @click="submit">{{ t('wv.redis.console.run') }}</button>
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
.badge { padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.history { flex: 1; overflow-y: auto; }
.entry { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); padding: 4px 0; position: relative; }
.entry pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.entry pre.sent { color: var(--vscode-descriptionForeground); }
.entry pre.error { color: var(--vscode-errorForeground); }
.cost { position: absolute; right: 4px; top: 4px; font-size: 10px; color: var(--vscode-descriptionForeground); }
.input-row { display: flex; gap: 6px; padding-top: 6px; }
.input-row input { flex: 1; padding: 4px 6px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; font-size: 12px; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.confirm-mask { position: absolute; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; }
.confirm { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); border-radius: 6px; padding: 14px 16px; max-width: 460px; }
.confirm h4 { margin: 0 0 8px; }
.confirm p { margin: 0 0 12px; font-size: 12px; word-break: break-all; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
