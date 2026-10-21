<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { base64ToBytes, bytesToBase64, bytesToHex, decodeUtf8, encodeUtf8, hexToBytes, hexToBytesLimited } from './bytes';
import HexEditor from './HexEditor.vue';
import { matchesTextFilter } from './types';
import type { ValueInfo } from './types';

const { t } = useI18n();
const props = defineProps<{ info: ValueInfo | null; readOnly: boolean }>();

/** 与 host 的 FORCE_LOAD_MAX_BYTES 对齐（仅用于提示文案）。 */
const FORCE_CAP_TEXT = '32 MB';
const emit = defineEmits<{
  (e: 'refresh'): void;
  (e: 'load'): void;
  (e: 'saveString', key: string, value: string): void;
  (e: 'saveStringBytes', key: string, base64: string): void;
  (e: 'appendString', key: string, value: string): void;
  (e: 'setTtl', key: string, seconds: number): void;
  (e: 'persist', key: string): void;
  (e: 'rename', key: string, newKey: string): void;
  (e: 'remove', key: string): void;
  (e: 'copyKey', key: string): void;
  (e: 'hashSet', key: string, field: string, value: string, oldField?: string, fieldBase64?: string, valueBase64?: string): void;
  (e: 'hashDel', key: string, fields: string[], fieldsBase64?: string[]): void;
  (e: 'listPush', key: string, side: 'left' | 'right', values: string[]): void;
  (e: 'listSet', key: string, index: number, value: string, original: string, valueBase64?: string, originalBase64?: string): void;
  (e: 'listRem', key: string, index: number, value: string, valueBase64?: string): void;
  (e: 'listPop', key: string, side: 'left' | 'right'): void;
  (e: 'setAdd', key: string, members: string[]): void;
  (e: 'setRem', key: string, members: string[], membersBase64?: string[]): void;
  (e: 'zsetAdd', key: string, score: string, member: string, oldMember?: string, memberBase64?: string): void;
  (e: 'zsetRem', key: string, members: string[], membersBase64?: string[]): void;
  (e: 'loadMore'): void;
}>();

const stringMode = ref<'text' | 'json' | 'hex'>('text');
const stringText = ref('');
/** 追加专用输入：避免把编辑框里的完整值再追加一遍（值重复）。 */
const appendText = ref('');
const hexText = ref('');
const rawBytes = ref<Uint8Array>(new Uint8Array());
const jsonError = ref('');
const hexError = ref('');
const hashFilter = ref('');
/** list/set/zset 已加载项过滤（与 hash 的字段过滤分开，避免切换类型残留）。 */
const collectionFilter = ref('');
const pendingPop = ref<{ side: 'left' | 'right' } | null>(null);
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
/** 行内编辑态（hash field+value / list 元素 / zset member+score）；draftKey 仅 hash/zset 用。 */
interface EditState { kind: 'hash' | 'list' | 'zset'; id: string; draft: string; draftKey?: string; idx?: number; hex?: boolean; draftHex?: string }
const editing = ref<EditState | null>(null);

const key = computed(() => props.info?.key ?? '');
const TYPE_KEYS: Record<string, string> = {
  string: 'wv.redis.type.string',
  hash: 'wv.redis.type.hash',
  list: 'wv.redis.type.list',
  set: 'wv.redis.type.set',
  zset: 'wv.redis.type.zset',
  stream: 'wv.redis.type.stream',
  none: 'wv.redis.type.none',
};
const typeLabel = computed(() => {
  const raw = props.info?.keyType ?? '';
  const key = TYPE_KEYS[raw];
  return key ? t(key) : raw;
});
const isBinaryString = computed(() => (props.info?.data?.kind === 'string' ? props.info.data.binary : false));
/** H5：键名有损 → 整个值只读；单个字段/成员/元素有损 → 该项只读。 */
const ro = computed(() => props.readOnly || !!props.info?.keyBinary);
const binarySet = computed(() => new Set(props.info?.binaryFields ?? []));
const isBin = (s: string): boolean => binarySet.value.has(s) || s.includes('\uFFFD');
/** 大 key 强制加载的截断预览：只读，禁止保存（否则会用预览覆盖整值）。 */
const truncated = computed(() => !!(props.info as { truncated?: boolean } | null)?.truncated);
const locked = computed(() => props.readOnly || !!props.info?.keyBinary || truncated.value);
/** JSON 模式仅展示格式化（原文保存在 stringText，保存用原文）；二进制在 text 模式禁保存。 */
const jsonPretty = ref('');
const textLocked = computed(() => locked.value
  || stringMode.value === 'json'
  || (isBinaryString.value && stringMode.value === 'text'));
const displayText = computed({
  get: () => (stringMode.value === 'json' ? jsonPretty.value : stringText.value),
  set: (v: string) => { if (stringMode.value === 'json') jsonPretty.value = v; else stringText.value = v; },
});
/** hex 预览封顶（16KB ≈ 1024 行），避免大值全量 DOM + 每次键击全量解析。 */
const HEX_PREVIEW_BYTES = 16 * 1024;
const hexPreview = computed<{ bytes: Uint8Array; truncated: boolean }>(() => {
  try { return hexToBytesLimited(hexText.value, HEX_PREVIEW_BYTES); }
  catch { return { bytes: new Uint8Array(), truncated: false }; }
});
const ttlText = computed(() => {
  const ttl = props.info?.ttl ?? -2;
  if (ttl === -1) return t('wv.redis.value.forever');
  if (ttl === -2) return t('wv.redis.value.missing');
  return String(ttl);
});

watch(() => props.info, (info) => {
  // 二进制值默认进 hex 模式（文本模式保存会损坏字节）；JSON 展示缓存清空。
  stringMode.value = info?.data?.kind === 'string' && info.data.binary ? 'hex' : 'text';
  jsonPretty.value = '';
  jsonError.value = '';
  hexError.value = '';
  renameOpen.value = false;
  ttlOpen.value = false;
  copied.value = false;
  hashFilter.value = '';
  collectionFilter.value = '';
  pendingPop.value = null;
  editing.value = null;
  if (info?.data?.kind === 'string') {
    stringText.value = info.data.text;
    rawBytes.value = base64ToBytes(info.data.base64);
    hexText.value = bytesToHex(rawBytes.value);
  } else {
    stringText.value = '';
    rawBytes.value = new Uint8Array();
    hexText.value = '';
  }
}, { immediate: true });

/** 文本/JSON 编辑 → 字节（编辑 textarea 后切模式/保存时同步）。 */
function syncFromText(): void {
  rawBytes.value = encodeUtf8(stringText.value);
  hexText.value = bytesToHex(rawBytes.value);
}
/** hex 编辑 → 字节/文本；非法 hex 记录错误、不覆盖字节。 */
function syncFromHex(): void {
  try {
    rawBytes.value = hexToBytes(hexText.value);
    stringText.value = decodeUtf8(rawBytes.value);
    hexError.value = '';
  } catch (err) {
    hexError.value = (err as Error).message;
  }
}

function switchMode(mode: 'text' | 'json' | 'hex'): void {
  if (mode === stringMode.value) return;
  jsonError.value = '';
  hexError.value = '';
  // 先把当前编辑器内容落回字节，避免切换时丢失编辑。
  if (stringMode.value === 'hex') syncFromHex();
  else syncFromText();
  if (mode === 'json') {
    // 只格式化到展示缓冲，**不改** stringText（保存用原文；大整数不因 parse 丢精度）。
    try {
      jsonPretty.value = JSON.stringify(JSON.parse(stringText.value || 'null'), null, 2);
    } catch {
      jsonError.value = t('wv.redis.string.invalidJson');
    }
  }
  if (mode === 'hex') hexText.value = bytesToHex(rawBytes.value);
  stringMode.value = mode;
}

function saveString(): void {
  if (jsonError.value) return;
  if (stringMode.value === 'hex') {
    syncFromHex();
    if (hexError.value) return;
    emit('saveStringBytes', key.value, bytesToBase64(rawBytes.value));
    return;
  }
  emit('saveString', key.value, stringText.value);
}

function copyKey(): void {
  void navigator.clipboard?.writeText(key.value);
  copied.value = true;
}

function filteredHash(): { f: string; v: string; i: number }[] {
  const data = props.info?.data;
  if (data?.kind !== 'hash') return [];
  return data.entries.map(([f, v], i) => ({ f, v, i })).filter(({ f }) => matchesTextFilter(f, hashFilter.value));
}
const filteredList = computed(() => {
  const data = props.info?.data;
  if (data?.kind !== 'list') return [];
  return data.items.map((item, i) => ({ item, i })).filter(({ item }) => matchesTextFilter(item, collectionFilter.value));
});
const filteredSet = computed(() => {
  const data = props.info?.data;
  if (data?.kind !== 'set') return [];
  return data.members.map((member, i) => ({ member, i })).filter(({ member }) => matchesTextFilter(member, collectionFilter.value));
});
const filteredZset = computed(() => {
  const data = props.info?.data;
  if (data?.kind !== 'zset') return [];
  return data.items.map(([member, score], i) => ({ member, score, i }))
    .filter(({ member, score }) => matchesTextFilter(`${member} ${score}`, collectionFilter.value));
});

/** Stage B（3C-1）：有损文本（U+FFFD）配合并行 base64 展示/复制/删除原始字节。 */
function isLossy(text: string): boolean {
  return text.includes('\uFFFD');
}
function bytesOfHash(i: number, which: 0 | 1): string | undefined {
  const d = props.info?.data;
  return d?.kind === 'hash' && d.entryBytes ? d.entryBytes[i]?.[which] : undefined;
}
function bytesOfList(i: number): string | undefined {
  const d = props.info?.data;
  return d?.kind === 'list' && d.itemBytes ? d.itemBytes[i] : undefined;
}
function bytesOfSet(i: number): string | undefined {
  const d = props.info?.data;
  return d?.kind === 'set' && d.memberBytes ? d.memberBytes[i] : undefined;
}
function bytesOfZset(i: number): string | undefined {
  const d = props.info?.data;
  return d?.kind === 'zset' && d.itemBytes ? d.itemBytes[i]?.[0] : undefined;
}
/** 二进制项内联 hex 预览（截断 32 字节）。 */
const ITEM_HEX_PREVIEW_BYTES = 32;
function itemHexPreview(b64: string): string {
  const bytes = base64ToBytes(b64);
  const head = bytes.subarray(0, ITEM_HEX_PREVIEW_BYTES);
  return bytesToHex(head) + (bytes.length > ITEM_HEX_PREVIEW_BYTES ? ' …' : '');
}
/** 二进制项复制为完整 hex（与 string hex 模式口径一致）。 */
function copyBytes(b64: string): void {
  void navigator.clipboard?.writeText(bytesToHex(base64ToBytes(b64)));
}
/** 展示：有损文本且有精确字节 → hex 预览；否则原文。 */
function displayHash(i: number, which: 0 | 1, text: string): string {
  const b64 = bytesOfHash(i, which);
  return isLossy(text) && b64 ? itemHexPreview(b64) : text;
}
function displayList(i: number, text: string): string {
  const b64 = bytesOfList(i);
  return isLossy(text) && b64 ? itemHexPreview(b64) : text;
}
function displaySet(i: number, text: string): string {
  const b64 = bytesOfSet(i);
  return isLossy(text) && b64 ? itemHexPreview(b64) : text;
}
function displayZset(i: number, text: string): string {
  const b64 = bytesOfZset(i);
  return isLossy(text) && b64 ? itemHexPreview(b64) : text;
}
/** 复制：有损项复制完整 hex；否则复制原文。 */
function copyItem(b64: string | undefined, text: string): void {
  if (b64 && isLossy(text)) copyBytes(b64);
  else copyValue(text);
}
/** 删除请求：有损项必须带精确字节（有损文本无法在服务端命中）。 */
function delHash(i: number, f: string): void {
  const b64 = bytesOfHash(i, 0);
  if (b64 && isLossy(f)) emit('hashDel', key.value, [f], [b64]);
  else emit('hashDel', key.value, [f]);
}
function delList(i: number, item: string): void {
  const b64 = bytesOfList(i);
  if (b64 && isLossy(item)) emit('listRem', key.value, i, item, b64);
  else emit('listRem', key.value, i, item);
}
function delSet(i: number, m: string): void {
  const b64 = bytesOfSet(i);
  if (b64 && isLossy(m)) emit('setRem', key.value, [m], [b64]);
  else emit('setRem', key.value, [m]);
}
function delZset(i: number, m: string): void {
  const b64 = bytesOfZset(i);
  if (b64 && isLossy(m)) emit('zsetRem', key.value, [m], [b64]);
  else emit('zsetRem', key.value, [m]);
}

function submitRename(): void {
  if (renameValue.value && renameValue.value !== key.value) emit('rename', key.value, renameValue.value);
  renameOpen.value = false;
}
function submitTtl(): void {
  const seconds = Number(ttlValue.value);
  // 与 host 校验一致：TTL 必须是正整数秒（0/负数无效）。
  if (Number.isInteger(seconds) && seconds > 0) emit('setTtl', key.value, seconds);
  ttlOpen.value = false;
}
const popSideLabel = computed(() => pendingPop.value?.side === 'left' ? t('wv.redis.list.popLeft') : t('wv.redis.list.popRight'));
function confirmPop(): void {
  const p = pendingPop.value;
  if (!p) return;
  pendingPop.value = null;
  emit('listPop', key.value, p.side);
}

/** zset 新增：score 必须是有限数字（空串 Number('')===0，须显式排除）。 */
const canAddZset = computed(() => !!zsetMember.value && zsetScore.value.trim() !== '' && Number.isFinite(Number(zsetScore.value)));

function startEdit(kind: EditState['kind'], id: string, draft: string, idx?: number): void {
  if (props.readOnly || props.info?.keyBinary) return;
  // Stage B（3C-2）：有损值/元素走 hex 编辑；zset 的 draft 是 score（文本），恒不 hex。
  const hex = kind !== 'zset' && isLossy(draft);
  const sourceB64 = kind === 'hash' ? bytesOfHash(idx ?? -1, 1) : kind === 'list' ? bytesOfList(idx ?? -1) : undefined;
  editing.value = {
    kind,
    id,
    draft,
    // hash/zset：draftKey 初值为原 field/member，允许改；list 无 key 维度。
    draftKey: kind === 'list' ? undefined : id,
    idx,
    hex,
    draftHex: hex && sourceB64 ? bytesToHex(base64ToBytes(sourceB64)) : undefined,
  };
  hexError.value = '';
}
function saveEdit(): void {
  const e = editing.value;
  if (!e) return;
  // Stage B（3C-2）：hex 编辑（有损值/元素）→ 校验后按精确字节提交（hash 二进制 field 禁改名）。
  if (e.hex) {
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(e.draftHex ?? '');
    } catch (err) {
      hexError.value = (err as Error).message;
      return;
    }
    hexError.value = '';
    const newB64 = bytesToBase64(bytes);
    if (e.kind === 'hash') {
      const fieldB64 = isLossy(e.id) ? bytesOfHash(e.idx ?? -1, 0) : undefined;
      emit('hashSet', key.value, e.id, e.draft, undefined, fieldB64, newB64);
    } else {
      emit('listSet', key.value, Number(e.id), e.draft, e.draft, newB64, bytesOfList(e.idx ?? -1));
    }
    editing.value = null;
    return;
  }
  // 仅当字段/成员名真的被改动时才 trim 并带 oldField/oldMember；否则只更新值，
  // 避免「只改值」被宿主误判为改名（曾把字段 ` a` 改成 `a` 或报「目标已存在」）。
  const rename = e.draftKey !== undefined && e.draftKey !== e.id;
  if (e.kind === 'hash') {
    const field = rename ? e.draftKey!.trim() : e.id;
    if (!field) return;
    emit('hashSet', key.value, field, e.draft, rename ? e.id : undefined);
  } else if (e.kind === 'list') {
    const items = props.info?.data?.kind === 'list' ? props.info.data.items : [];
    emit('listSet', key.value, Number(e.id), e.draft, items[Number(e.id)] ?? '');
  } else {
    // 有损 member 不可改名：只改 score，并按精确字节提交 member。
    const memberLossy = isLossy(e.id);
    const canRename = !memberLossy && e.draftKey !== undefined && e.draftKey !== e.id;
    const member = canRename ? e.draftKey!.trim() : e.id;
    if (!member) return;
    emit('zsetAdd', key.value, e.draft, member, canRename ? e.id : undefined, memberLossy ? bytesOfZset(e.idx ?? -1) : undefined);
  }
  editing.value = null;
}
function isEditing(kind: EditState['kind'], id: string): boolean {
  return editing.value?.kind === kind && editing.value.id === id;
}
/** 编辑草稿（模板 v-model 用；无编辑态时为空）。 */
const draft = computed({
  get: () => editing.value?.draft ?? '',
  set: (v: string) => { if (editing.value) editing.value.draft = v; },
});
/** 编辑草稿（field/member）。 */
const draftKey = computed({
  get: () => editing.value?.draftKey ?? '',
  set: (v: string) => { if (editing.value) editing.value.draftKey = v; },
});
/** 编辑草稿（hex 模式：有损值/元素）。 */
const draftHex = computed({
  get: () => editing.value?.draftHex ?? '',
  set: (v: string) => { if (editing.value) editing.value.draftHex = v; },
});
function copyValue(text: string): void {
  void navigator.clipboard?.writeText(text);
}
</script>

<template>
  <div class="value-viewer">
    <div v-if="!info" class="empty">{{ t('wv.redis.value.none') }}</div>
    <template v-else>
      <div class="key-line">
        <span class="key-name" :title="key">{{ key }}</span>
        <span class="type">{{ typeLabel }}</span>
        <span v-if="info.size !== null" class="key-meta">{{ t('wv.redis.value.size', { size: info.size }) }}</span>
        <span v-if="info.keyBinary" class="key-meta warn">{{ t('wv.redis.value.binaryKey') }}</span>
        <span v-if="truncated" class="key-meta warn">{{ t('wv.redis.value.previewOnly') }}</span>
      </div>
      <div class="toolbar">
        <span class="ttl">{{ t('wv.redis.value.ttl') }}: {{ ttlText }}</span>
        <button class="btn" @click="emit('refresh')">{{ t('wv.redis.value.refresh') }}</button>
        <button class="btn" :disabled="ro" @click="renameOpen = true">{{ t('wv.redis.value.rename') }}</button>
        <button class="btn" :disabled="ro" @click="ttlOpen = true">{{ t('wv.redis.value.setTtl') }}</button>
        <button class="btn" :disabled="ro" @click="emit('persist', key)">{{ t('wv.redis.value.persist') }}</button>
        <button class="btn" @click="copyKey">{{ copied ? '✓' : t('wv.redis.value.copyKey') }}</button>
        <button class="btn danger" :disabled="ro" @click="emit('remove', key)">{{ t('wv.redis.value.delete') }}</button>
      </div>
      <div v-if="renameOpen" class="inline">
        <input v-model="renameValue" :placeholder="t('wv.redis.prompt.rename')" />
        <button class="btn" @click="submitRename">{{ t('wv.redis.value.rename') }}</button>
      </div>
      <div v-if="ttlOpen" class="inline">
        <input v-model="ttlValue" :placeholder="t('wv.redis.prompt.ttl')" />
        <button class="btn" @click="submitTtl">{{ t('wv.redis.value.setTtl') }}</button>
      </div>

      <!-- Stage B（3C-2）：集合 hex 编辑错误（string 区自带错误行）。 -->
      <div v-if="hexError && info.data?.kind !== 'string'" class="error">{{ hexError }}</div>

      <div v-if="info.tooLarge" class="too-large">
        <span>{{ t('wv.redis.value.tooLarge', { size: info.size ?? 0 }) }}</span>
        <button class="btn" @click="emit('load')">{{ t('wv.redis.value.load') }}</button>
      </div>

      <div v-else-if="info.data?.kind === 'string'" class="string">
        <div v-if="truncated" class="truncated">{{ t('wv.redis.value.truncated', { size: FORCE_CAP_TEXT }) }}</div>
        <div class="tabs">
          <button :class="{ active: stringMode === 'text' }" @click="switchMode('text')">{{ t('wv.redis.string.text') }}</button>
          <button :class="{ active: stringMode === 'json' }" @click="switchMode('json')">{{ t('wv.redis.string.json') }}</button>
          <button :class="{ active: stringMode === 'hex' }" @click="switchMode('hex')">{{ t('wv.redis.string.hex') }}</button>
        </div>
        <textarea v-if="stringMode !== 'hex'" v-model="displayText" :readonly="textLocked" />
        <template v-else>
          <textarea v-model="hexText" :readonly="locked" class="hex" />
          <HexEditor :bytes="hexPreview.bytes" :truncated="hexPreview.truncated" />
        </template>
        <div v-if="isBinaryString && stringMode !== 'hex'" class="binary-warn">{{ t('wv.redis.string.binaryWarn') }}</div>
        <div v-if="jsonError" class="error">{{ jsonError }}</div>
        <div v-if="hexError" class="error">{{ hexError }}</div>
        <div class="actions">
          <button class="btn" :disabled="textLocked || !!jsonError || !!hexError" @click="saveString">{{ t('wv.redis.value.save') }}</button>
          <input v-model="appendText" :disabled="textLocked" :placeholder="t('wv.redis.value.appendHint')" />
          <button class="btn" :disabled="textLocked || stringMode === 'hex' || !appendText" @click="emit('appendString', key, appendText); appendText = ''">{{ t('wv.redis.value.append') }}</button>
        </div>
      </div>

      <div v-else-if="info.data?.kind === 'hash'" class="hash">
        <div class="meta">{{ t('wv.redis.hash.field') }} / {{ t('wv.redis.hash.value') }}</div>
        <div class="collection-filter">
          <input v-model="hashFilter" :placeholder="t('wv.redis.hash.field')" />
          <span class="meta">{{ t('wv.redis.collection.matches', { shown: filteredHash().length, total: info.data.entries.length }) }}</span>
        </div>
        <table>
          <tr v-for="row in filteredHash()" :key="row.i">
            <td class="f">
              <input v-if="isEditing('hash', row.f) && !editing?.hex && !isLossy(row.f)" v-model="draftKey" class="cell-input" @keydown.enter="saveEdit" @keydown.esc="editing = null" />
              <template v-else>{{ displayHash(row.i, 0, row.f) }}</template>
            </td>
            <td class="v">
              <textarea v-if="isEditing('hash', row.f) && editing?.hex" v-model="draftHex" class="cell-input hex-area" @keydown.enter.prevent="saveEdit" @keydown.esc="editing = null" />
              <input v-else-if="isEditing('hash', row.f)" v-model="draft" class="cell-input" @keydown.enter="saveEdit" @keydown.esc="editing = null" />
              <template v-else>{{ displayHash(row.i, 1, row.v) }}</template>
            </td>
            <td class="row-actions">
              <template v-if="isEditing('hash', row.f)">
                <button class="btn tiny" :disabled="!draftKey.trim()" @click="saveEdit">{{ t('wv.redis.value.save') }}</button>
                <button class="btn tiny" @click="editing = null">{{ t('wv.redis.confirm.cancel') }}</button>
              </template>
              <template v-else>
                <button class="btn tiny" :disabled="ro" :title="t('wv.redis.value.edit')" @click="startEdit('hash', row.f, row.v, row.i)">✎</button>
                <button class="btn tiny" :title="t('wv.redis.value.copy')" @click="copyItem(bytesOfHash(row.i, 1), row.v)">⧉</button>
                <button class="btn tiny" :disabled="ro" @click="delHash(row.i, row.f)">✕</button>
              </template>
            </td>
          </tr>
        </table>
        <div class="inline">
          <input v-model="newField" :placeholder="t('wv.redis.hash.field')" />
          <input v-model="newHashValue" :placeholder="t('wv.redis.hash.value')" />
          <button class="btn" :disabled="ro || !newField" @click="emit('hashSet', key, newField, newHashValue); newField=''; newHashValue=''">{{ t('wv.redis.hash.add') }}</button>
        </div>
        <button v-if="info.more && !info.more.done" class="btn more" @click="emit('loadMore')">{{ t('wv.redis.collection.loadMore') }}</button>
      </div>

      <div v-else-if="info.data?.kind === 'list'" class="list">
        <div class="meta">{{ t('wv.redis.list.len', { count: info.data.len }) }}</div>
        <div class="inline">
          <input v-model="listValue" :placeholder="t('wv.redis.list.value')" />
          <select v-model="listSide">
            <option value="left">{{ t('wv.redis.list.pushLeft') }}</option>
            <option value="right">{{ t('wv.redis.list.pushRight') }}</option>
          </select>
          <button class="btn" :disabled="ro || !listValue" @click="emit('listPush', key, listSide, [listValue]); listValue=''">{{ t('wv.redis.list.push') }}</button>
          <button class="btn" :disabled="ro" @click="pendingPop = { side: listSide }">{{ t('wv.redis.list.pop') }}</button>
        </div>
        <div class="collection-filter">
          <input v-model="collectionFilter" :placeholder="t('wv.redis.collection.filter')" />
          <span class="meta">{{ t('wv.redis.collection.matches', { shown: filteredList.length, total: info.data.items.length }) }}</span>
        </div>
        <table>
          <tr v-for="row in filteredList" :key="row.i">
            <td class="idx">{{ row.i }}</td>
            <td class="v">
              <textarea v-if="isEditing('list', String(row.i)) && editing?.hex" v-model="draftHex" class="cell-input hex-area" @keydown.enter.prevent="saveEdit" @keydown.esc="editing = null" />
              <input v-else-if="isEditing('list', String(row.i))" v-model="draft" class="cell-input" @keydown.enter="saveEdit" @keydown.esc="editing = null" />
              <template v-else>{{ displayList(row.i, row.item) }}</template>
            </td>
            <td class="row-actions">
              <template v-if="isEditing('list', String(row.i))">
                <button class="btn tiny" @click="saveEdit">{{ t('wv.redis.value.save') }}</button>
                <button class="btn tiny" @click="editing = null">{{ t('wv.redis.confirm.cancel') }}</button>
              </template>
              <template v-else>
                <button class="btn tiny" :disabled="ro" :title="t('wv.redis.value.edit')" @click="startEdit('list', String(row.i), row.item, row.i)">✎</button>
                <button class="btn tiny" :title="t('wv.redis.value.copy')" @click="copyItem(bytesOfList(row.i), row.item)">⧉</button>
                <button class="btn tiny" :disabled="ro" @click="delList(row.i, row.item)">✕</button>
              </template>
            </td>
          </tr>
        </table>
        <button v-if="info.more && !info.more.done" class="btn more" @click="emit('loadMore')">{{ t('wv.redis.collection.loadMore') }}</button>
      </div>

      <div v-else-if="info.data?.kind === 'set'" class="set">
        <div class="meta">{{ t('wv.redis.set.card', { count: info.data.card }) }}</div>
        <div class="inline">
          <input v-model="setMember" :placeholder="t('wv.redis.set.member')" />
          <button class="btn" :disabled="ro || !setMember" @click="emit('setAdd', key, [setMember]); setMember=''">{{ t('wv.redis.set.add') }}</button>
        </div>
        <div class="collection-filter">
          <input v-model="collectionFilter" :placeholder="t('wv.redis.collection.filter')" />
          <span class="meta">{{ t('wv.redis.collection.matches', { shown: filteredSet.length, total: info.data.members.length }) }}</span>
        </div>
        <table>
          <tr v-for="row in filteredSet" :key="row.i">
            <td class="v">{{ displaySet(row.i, row.member) }}</td>
            <td class="row-actions">
              <button class="btn tiny" :title="t('wv.redis.value.copy')" @click="copyItem(bytesOfSet(row.i), row.member)">⧉</button>
              <button class="btn tiny" :disabled="ro" @click="delSet(row.i, row.member)">✕</button>
            </td>
          </tr>
        </table>
        <button v-if="info.more && !info.more.done" class="btn more" @click="emit('loadMore')">{{ t('wv.redis.collection.loadMore') }}</button>
      </div>

      <div v-else-if="info.data?.kind === 'zset'" class="zset">
        <div class="meta">{{ t('wv.redis.zset.card', { count: info.data.card }) }}</div>
        <div class="inline">
          <input v-model="zsetScore" class="score" :placeholder="t('wv.redis.zset.score')" />
          <input v-model="zsetMember" :placeholder="t('wv.redis.zset.member')" />
          <button class="btn" :disabled="ro || !canAddZset" @click="emit('zsetAdd', key, zsetScore, zsetMember); zsetMember=''">{{ t('wv.redis.zset.add') }}</button>
        </div>
        <div class="collection-filter">
          <input v-model="collectionFilter" :placeholder="t('wv.redis.collection.filter')" />
          <span class="meta">{{ t('wv.redis.collection.matches', { shown: filteredZset.length, total: info.data.items.length }) }}</span>
        </div>
        <table>
          <tr v-for="row in filteredZset" :key="row.i">
            <td class="v">
              <input v-if="isEditing('zset', row.member) && !isLossy(row.member)" v-model="draftKey" class="cell-input" @keydown.enter="saveEdit" @keydown.esc="editing = null" />
              <template v-else>{{ displayZset(row.i, row.member) }}</template>
            </td>
            <td class="idx">
              <input v-if="isEditing('zset', row.member)" v-model="draft" class="cell-input score" @keydown.enter="saveEdit" @keydown.esc="editing = null" />
              <template v-else>{{ row.score }}</template>
            </td>
            <td class="row-actions">
              <template v-if="isEditing('zset', row.member)">
                <button class="btn tiny" :disabled="!draftKey.trim()" @click="saveEdit">{{ t('wv.redis.value.save') }}</button>
                <button class="btn tiny" @click="editing = null">{{ t('wv.redis.confirm.cancel') }}</button>
              </template>
              <template v-else>
                <button class="btn tiny" :disabled="ro" :title="t('wv.redis.value.edit')" @click="startEdit('zset', row.member, row.score, row.i)">✎</button>
                <button class="btn tiny" :title="t('wv.redis.value.copy')" @click="copyItem(bytesOfZset(row.i), row.member)">⧉</button>
                <button class="btn tiny" :disabled="ro" @click="delZset(row.i, row.member)">✕</button>
              </template>
            </td>
          </tr>
        </table>
        <button v-if="info.more && !info.more.done" class="btn more" @click="emit('loadMore')">{{ t('wv.redis.collection.loadMore') }}</button>
      </div>

      <div v-else class="empty">{{ t('wv.redis.value.none') }}</div>
    </template>

    <div v-if="pendingPop" class="mask">
      <div class="confirm">
        <p>{{ t('wv.redis.list.popConfirm', { side: popSideLabel }) }}</p>
        <div class="confirm-actions">
          <button class="btn danger" :disabled="ro" @click="confirmPop">{{ t('wv.redis.list.pop') }}</button>
          <button class="btn" @click="pendingPop = null">{{ t('wv.redis.confirm.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.value-viewer { display: flex; flex-direction: column; height: 100%; font-size: 12px; position: relative; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
.key-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding-bottom: 4px; }
.key-name { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; word-break: break-all; user-select: text; }
.key-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
.key-meta.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding-bottom: 6px; }
.type { padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.ttl { color: var(--vscode-descriptionForeground); }
.inline { display: flex; gap: 6px; padding: 4px 0; }
input, select, textarea { padding: 3px 5px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
textarea { flex: 1; min-height: 120px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); }
textarea.hex { color: var(--vscode-descriptionForeground); }
/* 值内容卡片：统一边缘轮廓，避免值与工具条视觉上悬空。 */
.string, .hash, .list, .set, .zset, .too-large {
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, transparent);
  padding: 8px;
  box-sizing: border-box;
}
.string { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.hash, .list, .set, .zset { flex: 1; min-height: 0; overflow: auto; }
.tabs { display: flex; gap: 4px; padding-bottom: 4px; }
.tabs button { padding: 2px 8px; font-size: 12px; cursor: pointer; border: none; background: transparent; color: var(--vscode-foreground); border-bottom: 2px solid transparent; }
.tabs button.active { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
.actions { padding-top: 4px; display: flex; gap: 6px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); word-break: break-all; }
td.idx { color: var(--vscode-descriptionForeground); width: 56px; }
td.f { width: 30%; }
td.row-actions { white-space: nowrap; text-align: right; }
.cell-input { width: 100%; box-sizing: border-box; }
.cell-input.score { width: 72px; }
/* Stage B（3C-2）：二进制项 hex 编辑（等宽、可换行）。 */
.hex-area { font-family: var(--vscode-editor-font-family, monospace); min-height: 44px; white-space: pre-wrap; word-break: break-all; }
.meta { color: var(--vscode-descriptionForeground); padding: 2px 0; }
.collection-filter { display: flex; gap: 8px; align-items: center; padding: 2px 0 4px; flex-wrap: wrap; }
.collection-filter input { flex: 1; min-width: 160px; }
.error { color: var(--vscode-errorForeground); }
.binary-warn { color: var(--vscode-editorWarning-foreground, #cca700); padding: 2px 0; }
.mask { position: absolute; inset: 0; z-index: 20; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; }
.confirm { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); border-radius: 6px; padding: 14px 16px; max-width: min(460px, 90vw); }
.confirm p { margin: 0 0 10px; word-break: break-all; }
.confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
.too-large { display: flex; gap: 8px; align-items: center; padding: 12px; color: var(--vscode-descriptionForeground); }
.btn { padding: 3px 8px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.tiny { padding: 1px 5px; }
.btn.danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-foreground); }
</style>
