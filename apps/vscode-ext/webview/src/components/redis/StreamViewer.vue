<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { base64ToBytes, bytesToHex } from './bytes';
import type { ValueInfo } from './types';

const { t } = useI18n();
interface PendingEntry { id: string; consumer: string; idleMs: number; deliveryCount: number }

const props = defineProps<{
  info: ValueInfo;
  detail: { group: string; consumers: Record<string, string>[]; pending: { count: number; minId: string; maxId: string; consumers: [string, string][] }; pendingEntries?: PendingEntry[]; pendingTruncated?: boolean } | null;
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
  (e: 'pendingMore', key: string, group: string, start: string): void;
  (e: 'ack', key: string, group: string, ids: string[]): void;
  (e: 'claim', key: string, group: string, consumer: string, ids: string[]): void;
  (e: 'loadMore', key: string, start: string): void;
  (e: 'refresh'): void;
}>();

const data = computed(() => (props.info.data?.kind === 'stream' ? props.info.data : null));
const key = computed(() => props.info.key);
const entries = computed(() => data.value?.entries ?? []);
const selected = ref<Set<string>>(new Set());
const pendingSelected = ref<Set<string>>(new Set());
const claimConsumer = ref('');
const expandedId = ref<string | null>(null);
const copiedId = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const newId = ref('*');
const fields = ref<[string, string][]>([['', '']]);
const maxlen = ref('1000');
const newGroup = ref('');
const newGroupId = ref('$');

const allSelected = computed(() => entries.value.length > 0 && entries.value.every((e) => selected.value.has(e.id)));
const pendingEntries = computed(() => props.detail?.pendingEntries ?? []);
const lastPendingId = computed(() => pendingEntries.value.at(-1)?.id ?? '');
const allPendingSelected = computed(() => pendingEntries.value.length > 0 && pendingEntries.value.every((e) => pendingSelected.value.has(e.id)));
const canClaim = computed(() => !props.readOnly && !!claimConsumer.value.trim() && pendingSelected.value.size > 0);

function togglePending(id: string): void {
  const s = new Set(pendingSelected.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  pendingSelected.value = s;
}
function toggleAllPending(event: Event): void {
  pendingSelected.value = (event.target as HTMLInputElement).checked
    ? new Set(pendingEntries.value.map((e) => e.id))
    : new Set();
}
function loadMorePending(): void {
  if (!props.detail || !lastPendingId.value) return;
  emit('pendingMore', key.value, props.detail.group, lastPendingId.value);
}
function ackSelected(): void {
  if (!props.detail || !pendingSelected.value.size) return;
  emit('ack', key.value, props.detail.group, [...pendingSelected.value]);
  pendingSelected.value = new Set();
}
function claimSelected(): void {
  if (!props.detail || !canClaim.value) return;
  emit('claim', key.value, props.detail.group, claimConsumer.value.trim(), [...pendingSelected.value]);
  pendingSelected.value = new Set();
}
function idleText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function addField(): void { fields.value = [...fields.value, ['', '']]; }
function removeField(index: number): void {
  if (fields.value.length <= 1) fields.value = [['', '']];
  else fields.value = fields.value.filter((_, i) => i !== index);
}
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
function toggleAll(event: Event): void {
  selected.value = (event.target as HTMLInputElement).checked ? new Set(entries.value.map((e) => e.id)) : new Set();
}
function delSelected(): void {
  if (!selected.value.size) return;
  const ids = [...selected.value];
  selected.value = new Set();
  emit('del', key.value, ids);
}
function delOne(id: string): void {
  const s = new Set(selected.value);
  s.delete(id);
  selected.value = s;
  emit('del', key.value, [id]);
}
function trim(): void { const n = Number(maxlen.value); if (Number.isFinite(n) && n >= 0) emit('trim', key.value, n); }
function refresh(): void {
  selected.value = new Set();
  expandedId.value = null;
  emit('refresh');
}
function lastId(): string { return entries.value.at(-1)?.id ?? '-'; }
function toggleExpand(id: string): void { expandedId.value = expandedId.value === id ? null : id; }

/** Stage B（3C-1）读侧：二进制 field/value 以 hex 预览展示（fieldBytes 为并行 base64）。 */
const ITEM_HEX_PREVIEW_BYTES = 32;
function hexPreview(b64: string): string {
  const bytes = base64ToBytes(b64);
  const head = bytes.subarray(0, ITEM_HEX_PREVIEW_BYTES);
  return bytesToHex(head) + (bytes.length > ITEM_HEX_PREVIEW_BYTES ? ' …' : '');
}
function isLossy(text: string): boolean { return text.includes('\uFFFD'); }
function displayField(e: { fields: [string, string][]; fieldBytes?: [string, string][] }, index: number, which: 0 | 1): string {
  const text = e.fields[index]?.[which] ?? '';
  const b64 = e.fieldBytes?.[index]?.[which];
  return isLossy(text) && b64 ? hexPreview(b64) : text;
}
function displayFields(e: { fields: [string, string][]; fieldBytes?: [string, string][] }): string {
  return e.fields.map((_, i) => `${displayField(e, i, 0)}=${displayField(e, i, 1)}`).join(', ');
}
function copyField(e: { fields: [string, string][]; fieldBytes?: [string, string][] }, index: number, which: 0 | 1): string {
  const text = e.fields[index]?.[which] ?? '';
  const b64 = e.fieldBytes?.[index]?.[which];
  return isLossy(text) && b64 ? bytesToHex(base64ToBytes(b64)) : text;
}
async function copyEntry(e: { id: string; fields: [string, string][]; fieldBytes?: [string, string][] }): Promise<void> {
  const text = `${e.id}\n${e.fields.map((_, i) => `${copyField(e, i, 0)}=${copyField(e, i, 1)}`).join('\n')}`;
  try {
    await navigator.clipboard.writeText(text);
    copiedId.value = e.id;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedId.value = null; }, 1500);
  } catch {
    copiedId.value = null;
  }
}

watch(() => props.info.key, () => {
  selected.value = new Set();
  pendingSelected.value = new Set();
  expandedId.value = null;
  claimConsumer.value = '';
});
watch(() => props.detail?.group, () => {
  pendingSelected.value = new Set();
  claimConsumer.value = '';
});
onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="stream">
    <div class="key-line">
      <span class="key-name" :title="key">{{ key }}</span>
      <span v-if="info.keyBinary" class="key-meta warn">{{ t('wv.redis.value.binaryKey') }}</span>
    </div>
    <div class="toolbar">
      <span class="meta">{{ t('wv.redis.stream.len', { count: data?.len ?? 0 }) }}</span>
      <button class="btn" @click="refresh">{{ t('wv.redis.refresh') }}</button>
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
        <button class="btn tiny" :title="t('wv.redis.stream.removeField')" @click="removeField(i)">✕</button>
      </div>
      <div class="add-actions">
        <button class="btn" @click="addField">{{ t('wv.redis.stream.addField') }}</button>
        <button class="btn" @click="submitAdd">{{ t('wv.redis.stream.add') }}</button>
      </div>
    </div>

    <table class="entries">
      <thead>
        <tr>
          <th class="check"><input type="checkbox" :checked="allSelected" :aria-label="t('wv.redis.stream.selectAll')" @change="toggleAll" /></th>
          <th>{{ t('wv.redis.stream.id') }}</th>
          <th>{{ t('wv.redis.stream.fields') }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="e in entries" :key="e.id">
          <tr>
            <td><input type="checkbox" :checked="selected.has(e.id)" @change="toggle(e.id)" /></td>
            <td class="mono entry-id">
              <button class="btn tiny" :title="t('wv.redis.stream.toggleDetail')" @click="toggleExpand(e.id)">{{ expandedId === e.id ? '▾' : '▸' }}</button>
              {{ e.id }}
            </td>
            <td class="mono">{{ displayFields(e) }}</td>
            <td class="row-actions">
              <button class="btn tiny" :title="copiedId === e.id ? t('wv.redis.console.copied') : t('wv.redis.value.copy')" @click="copyEntry(e)">{{ copiedId === e.id ? '✓' : '⧉' }}</button>
              <button class="btn tiny" :disabled="readOnly" @click="delOne(e.id)">✕</button>
            </td>
          </tr>
          <tr v-if="expandedId === e.id" class="detail-row">
            <td colspan="4">
              <table class="detail-fields">
                <tr v-for="(field, i) in e.fields" :key="i">
                  <td>{{ displayField(e, i, 0) }}</td>
                  <td>{{ displayField(e, i, 1) }}</td>
                </tr>
              </table>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <div v-if="!entries.length" class="empty">{{ t('wv.redis.stream.empty') }}</div>
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

      <div class="pending-head">
        <h5>{{ t('wv.redis.stream.pendingEntries') }}</h5>
        <span class="meta">{{ t('wv.redis.stream.pendingLoaded', { shown: pendingEntries.length, total: detail.pending.count }) }}</span>
      </div>
      <p v-if="detail.pendingTruncated" class="warn">{{ t('wv.redis.stream.pendingTruncated') }}</p>
      <div v-if="pendingEntries.length" class="pending-actions">
        <input v-model="claimConsumer" :placeholder="t('wv.redis.stream.claimConsumer')" />
        <button class="btn" :disabled="readOnly || !pendingSelected.size" @click="ackSelected">
          {{ t('wv.redis.stream.ackSelected', { count: pendingSelected.size }) }}
        </button>
        <button class="btn" :disabled="!canClaim" @click="claimSelected">
          {{ t('wv.redis.stream.claimSelected', { count: pendingSelected.size }) }}
        </button>
      </div>
      <div v-if="!pendingEntries.length" class="empty">{{ t('wv.redis.stream.pendingEmpty') }}</div>
      <table v-else class="pending">
        <thead>
          <tr>
            <th class="check"><input type="checkbox" :checked="allPendingSelected" :aria-label="t('wv.redis.stream.selectAllPending')" @change="toggleAllPending" /></th>
            <th>{{ t('wv.redis.stream.id') }}</th>
            <th>{{ t('wv.redis.stream.consumer') }}</th>
            <th>{{ t('wv.redis.stream.idle') }}</th>
            <th>{{ t('wv.redis.stream.deliveries') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in pendingEntries" :key="p.id">
            <td><input type="checkbox" :checked="pendingSelected.has(p.id)" @change="togglePending(p.id)" /></td>
            <td class="mono">{{ p.id }}</td>
            <td class="mono">{{ p.consumer }}</td>
            <td>{{ idleText(p.idleMs) }}</td>
            <td>{{ p.deliveryCount }}</td>
          </tr>
        </tbody>
      </table>
      <button v-if="detail.pendingTruncated" class="btn" @click="loadMorePending">{{ t('wv.redis.stream.pendingLoadMore') }}</button>
    </div>
  </div>
</template>

<style scoped>
.stream { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.key-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.key-name { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; word-break: break-all; user-select: text; }
.toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.meta { color: var(--vscode-descriptionForeground); }
.key-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
.key-meta.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
.add { display: flex; flex-direction: column; gap: 4px; }
.pair { display: flex; gap: 6px; }
.pair input { flex: 1; }
.add-actions { display: flex; gap: 6px; }
input { padding: 3px 5px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
input.id, input.num { width: 120px; flex: none; }
table { width: 100%; border-collapse: collapse; }
table.entries, table.groups {
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, transparent);
}
th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); vertical-align: top; }
th.check { width: 28px; }
.row-actions { white-space: nowrap; text-align: right; }
.entry-id { white-space: nowrap; }
.detail-row td { background: var(--vscode-editorWidget-background, rgba(128,128,128,0.08)); }
.detail-fields { width: 100%; }
.detail-fields td:first-child { width: 35%; font-family: var(--vscode-editor-font-family, monospace); }
.detail-fields td:last-child { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.mono { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.empty { color: var(--vscode-descriptionForeground); padding: 8px; }
.detail { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); padding-top: 6px; }
.pending-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-top: 8px; }
.pending-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
.pending-actions input { flex: 1; min-width: 140px; }
.warn { color: var(--vscode-editorWarning-foreground, #d29922); font-size: 11px; margin: 2px 0; }
h4, h5 { margin: 6px 0 2px; }
.btn { padding: 2px 8px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.tiny { padding: 1px 5px; }
.btn:disabled { opacity: .45; cursor: default; }
.btn.danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-foreground); }
</style>
