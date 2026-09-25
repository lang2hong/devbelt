<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import type { ValueInfo } from './types';

const { t } = useI18n();
const props = defineProps<{ info: ValueInfo | null; readOnly: boolean }>();
const emit = defineEmits<{
  (e: 'refresh'): void;
  (e: 'load'): void;
  (e: 'saveString', key: string, value: string): void;
  (e: 'appendString', key: string, value: string): void;
  (e: 'setTtl', key: string, seconds: number): void;
  (e: 'persist', key: string): void;
  (e: 'rename', key: string, newKey: string): void;
  (e: 'remove', key: string): void;
  (e: 'copyKey', key: string): void;
  (e: 'hashSet', key: string, field: string, value: string): void;
  (e: 'hashDel', key: string, fields: string[]): void;
  (e: 'listPush', key: string, side: 'left' | 'right', values: string[]): void;
  (e: 'listSet', key: string, index: number, value: string): void;
  (e: 'listRem', key: string, count: number, value: string): void;
  (e: 'listPop', key: string, side: 'left' | 'right'): void;
  (e: 'setAdd', key: string, members: string[]): void;
  (e: 'setRem', key: string, members: string[]): void;
  (e: 'zsetAdd', key: string, score: string, member: string): void;
  (e: 'zsetRem', key: string, members: string[]): void;
}>();

const stringMode = ref<'text' | 'json' | 'hex'>('text');
const stringText = ref('');
const hexText = ref('');
const jsonError = ref('');
const hashFilter = ref('');
const newField = ref('');
const newHashValue = ref('');
const listValue = ref('');
const listSide = ref<'left' | 'right'>('right');
const setMember = ref('');
const zsetMember = ref('');
const zsetScore = ref('0');
const renameOpen = ref(false);
const renameValue = ref('');
const ttlOpen = ref(false);
const ttlValue = ref('');
const copied = ref(false);

const key = computed(() => props.info?.key ?? '');
const ttlText = computed(() => {
  const ttl = props.info?.ttl ?? -2;
  if (ttl === -1) return t('wv.redis.value.forever');
  if (ttl === -2) return t('wv.redis.value.missing');
  return String(ttl);
});

watch(() => props.info, (info) => {
  stringMode.value = 'text';
  jsonError.value = '';
  renameOpen.value = false;
  ttlOpen.value = false;
  copied.value = false;
  hashFilter.value = '';
  if (info?.data?.kind === 'string') {
    stringText.value = info.data.text;
    hexText.value = toHex(info.data.text);
  } else {
    stringText.value = '';
    hexText.value = '';
  }
}, { immediate: true });

function toHex(text: string): string {
  return [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
function fromHex(hex: string): string {
  const bytes = hex.split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16)).filter((n) => Number.isFinite(n));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function switchMode(mode: 'text' | 'json' | 'hex'): void {
  jsonError.value = '';
  if (mode === 'json') {
    try {
      stringText.value = JSON.stringify(JSON.parse(stringText.value || 'null'), null, 2);
    } catch {
      jsonError.value = t('wv.redis.string.invalidJson');
    }
  }
  if (mode === 'hex') hexText.value = toHex(stringText.value);
  stringMode.value = mode;
}

function saveString(): void {
  if (jsonError.value) return;
  const value = stringMode.value === 'hex' ? fromHex(hexText.value) : stringText.value;
  emit('saveString', key.value, value);
}

function copyKey(): void {
  void navigator.clipboard?.writeText(key.value);
  copied.value = true;
}

function filteredHash(): [string, string][] {
  const data = props.info?.data;
  if (data?.kind !== 'hash') return [];
  const q = hashFilter.value.toLowerCase();
  return q ? data.entries.filter(([f]) => f.toLowerCase().includes(q)) : data.entries;
}

function submitRename(): void {
  if (renameValue.value && renameValue.value !== key.value) emit('rename', key.value, renameValue.value);
  renameOpen.value = false;
}
function submitTtl(): void {
  const seconds = Number(ttlValue.value);
  if (Number.isFinite(seconds) && seconds >= 0) emit('setTtl', key.value, seconds);
  ttlOpen.value = false;
}
</script>

<template>
  <div class="value-viewer">
    <div v-if="!info" class="empty">{{ t('wv.redis.value.none') }}</div>
    <template v-else>
      <div class="toolbar">
        <span class="type">{{ info.keyType }}</span>
        <span class="ttl">{{ t('wv.redis.value.ttl') }}: {{ ttlText }}</span>
        <button class="btn" @click="emit('refresh')">{{ t('wv.redis.value.refresh') }}</button>
        <button class="btn" :disabled="readOnly" @click="renameOpen = true">{{ t('wv.redis.value.rename') }}</button>
        <button class="btn" :disabled="readOnly" @click="ttlOpen = true">{{ t('wv.redis.value.setTtl') }}</button>
        <button class="btn" :disabled="readOnly" @click="emit('persist', key)">{{ t('wv.redis.value.persist') }}</button>
        <button class="btn" @click="copyKey">{{ copied ? '✓' : t('wv.redis.value.copyKey') }}</button>
        <button class="btn danger" :disabled="readOnly" @click="emit('remove', key)">{{ t('wv.redis.value.delete') }}</button>
      </div>
      <div v-if="renameOpen" class="inline">
        <input v-model="renameValue" :placeholder="t('wv.redis.prompt.rename')" />
        <button class="btn" @click="submitRename">{{ t('wv.redis.value.rename') }}</button>
      </div>
      <div v-if="ttlOpen" class="inline">
        <input v-model="ttlValue" :placeholder="t('wv.redis.prompt.ttl')" />
        <button class="btn" @click="submitTtl">{{ t('wv.redis.value.setTtl') }}</button>
      </div>

      <div v-if="info.tooLarge" class="too-large">
        <span>{{ t('wv.redis.value.tooLarge', { size: info.size ?? 0 }) }}</span>
        <button class="btn" @click="emit('load')">{{ t('wv.redis.value.load') }}</button>
      </div>

      <div v-else-if="info.data?.kind === 'string'" class="string">
        <div class="tabs">
          <button :class="{ active: stringMode === 'text' }" @click="switchMode('text')">{{ t('wv.redis.string.text') }}</button>
          <button :class="{ active: stringMode === 'json' }" @click="switchMode('json')">{{ t('wv.redis.string.json') }}</button>
          <button :class="{ active: stringMode === 'hex' }" @click="switchMode('hex')">{{ t('wv.redis.string.hex') }}</button>
        </div>
        <textarea v-if="stringMode !== 'hex'" v-model="stringText" :readonly="readOnly" />
        <textarea v-else v-model="hexText" :readonly="readOnly" class="hex" />
        <div v-if="jsonError" class="error">{{ jsonError }}</div>
        <div class="actions">
          <button class="btn" :disabled="readOnly || !!jsonError" @click="saveString">{{ t('wv.redis.value.save') }}</button>
          <button class="btn" :disabled="readOnly || stringMode === 'hex'" @click="emit('appendString', key, stringText)">{{ t('wv.redis.value.append') }}</button>
        </div>
      </div>

      <div v-else-if="info.data?.kind === 'hash'" class="hash">
        <div class="meta">{{ t('wv.redis.hash.field') }} / {{ t('wv.redis.hash.value') }}</div>
        <input v-model="hashFilter" :placeholder="t('wv.redis.hash.field')" />
        <table>
          <tr v-for="[f, v] in filteredHash()" :key="f">
            <td class="f">{{ f }}</td>
            <td class="v">{{ v }}</td>
            <td><button class="btn tiny" :disabled="readOnly" @click="emit('hashDel', key, [f])">✕</button></td>
          </tr>
        </table>
        <div class="inline">
          <input v-model="newField" :placeholder="t('wv.redis.hash.field')" />
          <input v-model="newHashValue" :placeholder="t('wv.redis.hash.value')" />
          <button class="btn" :disabled="readOnly || !newField" @click="emit('hashSet', key, newField, newHashValue); newField=''; newHashValue=''">{{ t('wv.redis.hash.add') }}</button>
        </div>
      </div>

      <div v-else-if="info.data?.kind === 'list'" class="list">
        <div class="meta">{{ t('wv.redis.list.len', { count: info.data.len }) }}</div>
        <div class="inline">
          <input v-model="listValue" :placeholder="t('wv.redis.list.value')" />
          <select v-model="listSide">
            <option value="left">{{ t('wv.redis.list.pushLeft') }}</option>
            <option value="right">{{ t('wv.redis.list.pushRight') }}</option>
          </select>
          <button class="btn" :disabled="readOnly || !listValue" @click="emit('listPush', key, listSide, [listValue]); listValue=''">{{ t('wv.redis.list.push') }}</button>
          <button class="btn" :disabled="readOnly" @click="emit('listPop', key, listSide)">{{ t('wv.redis.list.pop') }}</button>
        </div>
        <table>
          <tr v-for="(item, i) in info.data.items" :key="i">
            <td class="idx">{{ i }}</td>
            <td class="v">{{ item }}</td>
            <td>
              <button class="btn tiny" :disabled="readOnly" @click="emit('listSet', key, i, item)">{{ t('wv.redis.value.save') }}</button>
              <button class="btn tiny" :disabled="readOnly" @click="emit('listRem', key, 0, item)">✕</button>
            </td>
          </tr>
        </table>
      </div>

      <div v-else-if="info.data?.kind === 'set'" class="set">
        <div class="meta">{{ t('wv.redis.set.card', { count: info.data.card }) }}</div>
        <div class="inline">
          <input v-model="setMember" :placeholder="t('wv.redis.set.member')" />
          <button class="btn" :disabled="readOnly || !setMember" @click="emit('setAdd', key, [setMember]); setMember=''">{{ t('wv.redis.set.add') }}</button>
        </div>
        <table>
          <tr v-for="m in info.data.members" :key="m">
            <td class="v">{{ m }}</td>
            <td><button class="btn tiny" :disabled="readOnly" @click="emit('setRem', key, [m])">✕</button></td>
          </tr>
        </table>
      </div>

      <div v-else-if="info.data?.kind === 'zset'" class="zset">
        <div class="meta">{{ t('wv.redis.zset.card', { count: info.data.card }) }}</div>
        <div class="inline">
          <input v-model="zsetScore" class="score" :placeholder="t('wv.redis.zset.score')" />
          <input v-model="zsetMember" :placeholder="t('wv.redis.zset.member')" />
          <button class="btn" :disabled="readOnly || !zsetMember" @click="emit('zsetAdd', key, zsetScore, zsetMember); zsetMember=''">{{ t('wv.redis.zset.add') }}</button>
        </div>
        <table>
          <tr v-for="[m, s] in info.data.items" :key="m">
            <td class="v">{{ m }}</td>
            <td class="idx">{{ s }}</td>
            <td><button class="btn tiny" :disabled="readOnly" @click="emit('zsetRem', key, [m])">✕</button></td>
          </tr>
        </table>
      </div>

      <div v-else class="empty">{{ t('wv.redis.value.none') }}</div>
    </template>
  </div>
</template>

<style scoped>
.value-viewer { display: flex; flex-direction: column; height: 100%; font-size: 12px; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding-bottom: 6px; }
.type { padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.ttl { color: var(--vscode-descriptionForeground); }
.inline { display: flex; gap: 6px; padding: 4px 0; }
input, select, textarea { padding: 3px 5px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
textarea { flex: 1; min-height: 140px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); }
textarea.hex { color: var(--vscode-descriptionForeground); }
.tabs { display: flex; gap: 4px; padding-bottom: 4px; }
.tabs button { padding: 2px 8px; font-size: 12px; cursor: pointer; border: none; background: transparent; color: var(--vscode-foreground); border-bottom: 2px solid transparent; }
.tabs button.active { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
.actions { padding-top: 4px; display: flex; gap: 6px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); word-break: break-all; }
td.idx { color: var(--vscode-descriptionForeground); width: 56px; }
td.f { width: 30%; }
.meta { color: var(--vscode-descriptionForeground); padding: 2px 0; }
.error { color: var(--vscode-errorForeground); }
.too-large { display: flex; gap: 8px; align-items: center; padding: 12px; color: var(--vscode-descriptionForeground); }
.btn { padding: 3px 8px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.tiny { padding: 1px 5px; }
.btn.danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-foreground); }
</style>
