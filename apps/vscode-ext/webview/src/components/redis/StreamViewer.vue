<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { base64ToBytes, bytesToHex } from './bytes';
import type { ValueInfo } from './types';

const { t } = useI18n();
const props = defineProps<{
  info: ValueInfo;
  detail: { group: string; consumers: Record<string, string>[]; pending: { count: number; minId: string; maxId: string; consumers: [string, string][] } } | null;
  done: boolean;
  readOnly: boolean;
}>();
const emit = defineEmits<{
  (e: 'add', key: string, id: string, fields: [string, string][]): void;
  (e: 'del', key: string, ids: string[]): void;
  (e: 'trim', key: string, maxlen: number): void;
  (e: 'groupCreate', key: string, group: string, id: string, mkstream: boolean): void;
  (e: 'groupDestroy', key: string, group: string): void;
  (e: 'groupDelConsumer', key: string, group: string, consumer: string): void;
  (e: 'groupDetail', key: string, group: string): void;
  (e: 'loadMore', key: string, start: string): void;
}>();

const data = computed(() => (props.info.data?.kind === 'stream' ? props.info.data : null));
const key = computed(() => props.info.key);
const selected = ref<Set<string>>(new Set());
const newId = ref('*');
const fields = ref<[string, string][]>([['', '']]);
const maxlen = ref('1000');
const newGroup = ref('');
const newGroupId = ref('$');

function addField(): void { fields.value = [...fields.value, ['', '']]; }
function submitAdd(): void {
  const valid = fields.value.filter(([f]) => f.trim());
  if (!valid.length) return;
  emit('add', key.value, newId.value.trim() || '*', valid.map(([f, v]) => [f.trim(), v]));
  newId.value = '*';
  fields.value = [['', '']];
}
function toggle(id: string): void {
  const s = new Set(selected.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  selected.value = s;
}
function delSelected(): void { if (selected.value.size) emit('del', key.value, [...selected.value]); }
function delOne(id: string): void { emit('del', key.value, [id]); }
function trim(): void { const n = Number(maxlen.value); if (Number.isFinite(n) && n >= 0) emit('trim', key.value, n); }
function lastId(): string { return data.value?.entries.at(-1)?.id ?? '-'; }

/** Stage B（3C-1）读侧：二进制 field/value 以 hex 预览展示（fieldBytes 为并行 base64）。 */
const ITEM_HEX_PREVIEW_BYTES = 32;
function hexPreview(b64: string): string {
  const bytes = base64ToBytes(b64);
  const head = bytes.subarray(0, ITEM_HEX_PREVIEW_BYTES);
  return bytesToHex(head) + (bytes.length > ITEM_HEX_PREVIEW_BYTES ? ' …' : '');
}
function isLossy(text: string): boolean { return text.includes('\uFFFD'); }
function displayFields(e: { fields: [string, string][]; fieldBytes?: [string, string][] }): string {
  return e.fields
    .map(([f, v], i) => {
      const b = e.fieldBytes?.[i];
      const ff = isLossy(f) && b ? hexPreview(b[0]) : f;
      const vv = isLossy(v) && b ? hexPreview(b[1]) : v;
      return `${ff}=${vv}`;
    })
    .join(', ');
}
</script>

<template>
  <div class="stream">
    <div class="key-line">
      <span class="key-name" :title="key">{{ key }}</span>
      <span v-if="info.keyBinary" class="key-meta warn">{{ t('wv.redis.value.binaryKey') }}</span>
    </div>
    <div class="toolbar">
      <span class="meta">{{ t('wv.redis.stream.len', { count: data?.len ?? 0 }) }}</span>
      <input v-model="maxlen" class="num" :title="t('wv.redis.stream.maxlen')" />
      <button class="btn" :disabled="readOnly" @click="trim">{{ t('wv.redis.stream.trim') }}</button>
      <button v-if="selected.size" class="btn danger" :disabled="readOnly" @click="delSelected">
        {{ t('wv.redis.stream.delSelected') }} ({{ selected.size }})
      </button>
    </div>

    <div class="add" v-if="!readOnly">
      <input v-model="newId" class="id" :placeholder="t('wv.redis.stream.newId')" />
      <div v-for="(pair, i) in fields" :key="i" class="pair">
        <input v-model="pair[0]" :placeholder="t('wv.redis.stream.field')" />
        <input v-model="pair[1]" :placeholder="t('wv.redis.stream.value')" />
      </div>
      <div class="add-actions">
        <button class="btn" @click="addField">{{ t('wv.redis.stream.addField') }}</button>
        <button class="btn" @click="submitAdd">{{ t('wv.redis.stream.add') }}</button>
      </div>
    </div>

    <table class="entries">
      <thead><tr><th></th><th>{{ t('wv.redis.stream.id') }}</th><th>{{ t('wv.redis.stream.fields') }}</th><th></th></tr></thead>
      <tbody>
        <tr v-for="e in data?.entries ?? []" :key="e.id">
          <td><input type="checkbox" :checked="selected.has(e.id)" @change="toggle(e.id)" /></td>
          <td class="mono">{{ e.id }}</td>
          <td class="mono">{{ displayFields(e) }}</td>
          <td><button class="btn tiny" :disabled="readOnly" @click="delOne(e.id)">✕</button></td>
        </tr>
      </tbody>
    </table>
    <div v-if="!data?.entries?.length" class="empty">{{ t('wv.redis.stream.empty') }}</div>
    <button v-if="!done" class="btn" @click="emit('loadMore', key, lastId())">{{ t('wv.redis.stream.loadMore') }}</button>

    <h4>{{ t('wv.redis.stream.groups') }}</h4>
    <table class="groups">
      <thead><tr><th>{{ t('wv.redis.stream.group') }}</th><th>{{ t('wv.redis.stream.consumers') }}</th><th>{{ t('wv.redis.stream.pending') }}</th><th>{{ t('wv.redis.stream.lastDelivered') }}</th><th></th></tr></thead>
      <tbody>
        <tr v-for="g in data?.groups ?? []" :key="g.name">
          <td class="mono">{{ g.name }}</td>
          <td>{{ g.consumers }}</td>
          <td>{{ g.pending }}</td>
          <td class="mono">{{ g['last-delivered-id'] }}</td>
          <td>
            <button class="btn tiny" @click="emit('groupDetail', key, g.name)">{{ t('wv.redis.stream.groupDetail') }}</button>
            <button class="btn tiny danger" :disabled="readOnly" @click="emit('groupDestroy', key, g.name)">{{ t('wv.redis.stream.destroyGroup') }}</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div class="add" v-if="!readOnly">
      <input v-model="newGroup" :placeholder="t('wv.redis.stream.group')" />
      <input v-model="newGroupId" class="id" placeholder="$" />
      <button class="btn" :disabled="!newGroup" @click="emit('groupCreate', key, newGroup, newGroupId || '$', true); newGroup=''">
        {{ t('wv.redis.stream.createGroup') }}
      </button>
    </div>

    <div v-if="detail" class="detail">
      <h5>{{ detail.group }}</h5>
      <div class="meta">
        {{ t('wv.redis.stream.pendingCount', { count: detail.pending.count }) }}
        · {{ t('wv.redis.stream.minId') }} {{ detail.pending.minId }}
        · {{ t('wv.redis.stream.maxId') }} {{ detail.pending.maxId }}
      </div>
      <table>
        <tr v-for="c in detail.consumers" :key="c.name">
          <td class="mono">{{ c.name }}</td>
          <td>{{ c.pending }}</td>
          <td><button class="btn tiny danger" :disabled="readOnly" @click="emit('groupDelConsumer', key, detail!.group, c.name)">{{ t('wv.redis.stream.delConsumer') }}</button></td>
        </tr>
      </table>
    </div>
  </div>
</template>

<style scoped>
.stream { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.key-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.key-name { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; word-break: break-all; user-select: text; }
.toolbar { display: flex; gap: 6px; align-items: center; }
.meta { color: var(--vscode-descriptionForeground); }
.key-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
.key-meta.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
.add { display: flex; flex-direction: column; gap: 4px; }
.pair { display: flex; gap: 6px; }
.add-actions { display: flex; gap: 6px; }
input { padding: 3px 5px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
input.id, input.num { width: 120px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); }
.mono { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.empty { color: var(--vscode-descriptionForeground); padding: 8px; }
.detail { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); padding-top: 6px; }
h4, h5 { margin: 6px 0 2px; }
.btn { padding: 2px 8px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.tiny { padding: 1px 5px; }
.btn.danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-foreground); }
</style>
