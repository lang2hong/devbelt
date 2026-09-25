<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import type { RedisNewKeyValue } from './types';

const { t } = useI18n();
defineProps<{ show: boolean }>();
const emit = defineEmits<{
  (e: 'create', key: string, value: RedisNewKeyValue, ttlSeconds: number | null): void;
  (e: 'cancel'): void;
}>();

type KeyType = 'string' | 'hash' | 'list' | 'set' | 'zset';
const key = ref('');
const type = ref<KeyType>('string');
const ttl = ref('');
const text = ref('');
const lines = ref('');

function buildValue(): RedisNewKeyValue | null {
  const rows = lines.value.split('\n').map((l) => l.trim()).filter(Boolean);
  switch (type.value) {
    case 'string': return { kind: 'string', text: text.value };
    case 'hash': return { kind: 'hash', entries: rows.map((l) => split2(l)) };
    case 'list': return { kind: 'list', items: rows };
    case 'set': return { kind: 'set', members: rows };
    case 'zset': return { kind: 'zset', items: rows.map((l) => split2(l)) };
  }
}
function split2(line: string): [string, string] {
  const idx = line.search(/\s/);
  return idx < 0 ? [line, ''] : [line.slice(0, idx), line.slice(idx + 1).trim()];
}

function submit(): void {
  const value = buildValue();
  if (!key.value || !value) return;
  const seconds = ttl.value === '' ? null : Number(ttl.value);
  emit('create', key.value, value, Number.isFinite(seconds as number) ? seconds : null);
  key.value = ''; text.value = ''; lines.value = ''; ttl.value = '';
}
</script>

<template>
  <div v-if="show" class="mask">
    <div class="dialog">
      <h4>{{ t('wv.redis.newKey.title') }}</h4>
      <label>{{ t('wv.redis.newKey.key') }}<input v-model="key" /></label>
      <label>{{ t('wv.redis.newKey.type') }}
        <select v-model="type">
          <option value="string">string</option>
          <option value="hash">hash</option>
          <option value="list">list</option>
          <option value="set">set</option>
          <option value="zset">zset</option>
        </select>
      </label>
      <label>{{ t('wv.redis.newKey.ttl') }}<input v-model="ttl" /></label>
      <label v-if="type === 'string'">{{ t('wv.redis.newKey.value') }}<textarea v-model="text" /></label>
      <label v-else>{{ t('wv.redis.newKey.value') }}
        <textarea v-model="lines" :placeholder="t('wv.redis.newKey.entriesHint')" />
      </label>
      <div class="actions">
        <button class="btn" @click="submit">{{ t('wv.redis.newKey.create') }}</button>
        <button class="btn" @click="emit('cancel')">{{ t('wv.redis.newKey.cancel') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask { position: absolute; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; z-index: 10; }
.dialog { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); border-radius: 6px; padding: 14px 16px; min-width: 380px; max-width: 520px; }
.dialog h4 { margin: 0 0 10px; }
label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; margin-bottom: 8px; }
input, select, textarea { padding: 3px 5px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
textarea { min-height: 80px; resize: vertical; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
