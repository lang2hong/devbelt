<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import type { AuthenticatorSnapshotEntry, AuthenticatorGroup, AuthenticatorTag, TagColorKey } from '../../../src/result/protocol';

/**
 * P5 S3 · 验证器视图：分组/标签/搜索/增删改/导出。
 *
 * code 切换以主进程 tick 为唯一权威，webview 不跑 TOTP。添加/编辑提交前只做本地
 * base32 格式校验；配额、密钥合法性等以主进程结果为准（回到 formError/升级提示）。
 */
const { post, onMessage } = useVsCode();
const { t } = useI18n();

const TAG_COLORS: TagColorKey[] = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'cyan', 'gray'];
const TAG_HEX: Record<TagColorKey, string> = {
  blue: '#3b82f6', green: '#22c55e', yellow: '#eab308', orange: '#f97316',
  red: '#ef4444', purple: '#a855f7', cyan: '#06b6d4', gray: '#9ca3af',
};

const entries = ref<AuthenticatorSnapshotEntry[]>([]);
const groups = ref<AuthenticatorGroup[]>([]);
const tags = ref<AuthenticatorTag[]>([]);
const codes = ref<Record<string, { code: string; secondsLeft: number }>>({});
const copiedId = ref<string | null>(null);
const errMsg = ref('');
const promptError = ref('');

const query = ref('');
const debouncedQuery = ref('');
const activeTag = ref<string | null>(null);
const folded = ref(new Set<string>());
/** 筛选期间被自动展开的折叠键；退出筛选时复位。 */
const autoExpanded = ref(new Set<string>());

const formOpen = ref(false);
const editingId = ref<string | null>(null);
const formError = ref('');
/** 仅在"本次提交后"关闭表单，避免无关快照把正在填写的表单关掉。 */
const pendingSubmit = ref(false);
const form = reactive({
  issuer: '', account: '', secret: '',
  algorithm: 'SHA1' as 'SHA1' | 'SHA256' | 'SHA512',
  digits: 6 as 6 | 8,
  period: 30 as 30 | 60,
  groupId: '' as string,
  tags: [] as string[],
});

const groupPrompt = ref<{ mode: 'new' | 'rename' | 'above' | 'below'; id?: string; beforeId?: string; afterId?: string; value: string } | null>(null);
const tagPrompt = ref<{ name: string; color: TagColorKey } | null>(null);
const menuFor = ref<string | null>(null);
const groupMenuFor = ref<string | null>(null);
const confirmDeleteId = ref<string | null>(null);
const confirmTagDeleteId = ref<string | null>(null);
const confirmDeleteGroupId = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const imgBusy = ref(false);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1600;
/** 位图解码后像素上限（createImageBitmap 之前无法预知；防超大 JPEG 瞬时占用数百 MB）。 */
const MAX_DECODE_PIXELS = 40_000_000;
/** 与主进程 qrDecode 的 base64 上限对齐（8MB），避免"有码却被判无效"。 */
const HOST_MAX_BYTES = 8 * 1024 * 1024;

const RING_CIRCUMFERENCE = 2 * Math.PI * 13;

let off: (() => void) | undefined;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
let errTimer: ReturnType<typeof setTimeout> | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

watch(query, (v) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { debouncedQuery.value = v; }, 150);
});

const filterActive = computed(() => !!debouncedQuery.value.trim() || !!activeTag.value);

// 筛选时自动展开折叠组，并通知主进程解除折叠（否则 tick 不下发这些组的 codes）；
// 退出筛选时按记录复位。
watch(filterActive, (active) => {
  if (active) {
    for (const k of Array.from(folded.value)) {
      autoExpanded.value.add(k);
      folded.value.delete(k);
      post({ type: 'toggleGroup', groupId: k === '' ? null : k, folded: false });
    }
  } else {
    for (const k of Array.from(autoExpanded.value)) {
      folded.value.add(k);
      post({ type: 'toggleGroup', groupId: k === '' ? null : k, folded: true });
    }
    autoExpanded.value.clear();
  }
});

const filteredEntries = computed(() => {
  const q = debouncedQuery.value.trim().toLowerCase();
  return entries.value.filter((e) => {
    if (activeTag.value && !e.tags.includes(activeTag.value)) return false;
    if (q) {
      const hay = `${e.issuer} ${e.account ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
});

const orderedGroupIds = computed(() =>
  groups.value.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((g) => g.id));

const sections = computed(() => {
  const validGroupIds = new Set(groups.value.map((g) => g.id));
  const named = groups.value
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((g) => ({ key: g.id, name: g.name, groupId: g.id as string | null, entries: filteredEntries.value.filter((e) => e.groupId === g.id) }));
  // 未分组 = 无 groupId，或 groupId 指向已不存在的分组（孤儿引用回落未分组，
  // 否则该条目不会出现在任何 section，表现为“条目消失”）。
  const ungrouped = filteredEntries.value.filter((e) => !e.groupId || !validGroupIds.has(e.groupId));
  named.push({ key: '__ungrouped__', name: t('wv.authenticator.ungrouped'), groupId: null, entries: ungrouped });
  return named;
});

function keyOf(gid: string | null): string { return gid ?? ''; }
function isFolded(gid: string | null): boolean { return folded.value.has(keyOf(gid)); }
function toggleFold(gid: string | null): void {
  const k = keyOf(gid);
  const next = !folded.value.has(k);
  if (next) folded.value.add(k); else folded.value.delete(k);
  post({ type: 'toggleGroup', groupId: gid, folded: next });
}

function nameOf(e: AuthenticatorSnapshotEntry): string { return e.issuer || e.account || ''; }
function accountOf(e: AuthenticatorSnapshotEntry): string { return e.issuer && e.account ? e.account : ''; }
function codeOf(e: AuthenticatorSnapshotEntry): string { return codes.value[e.id]?.code ?? '••••••'; }
function secondsLeft(e: AuthenticatorSnapshotEntry): number { return codes.value[e.id]?.secondsLeft ?? 0; }
function dashOffset(e: AuthenticatorSnapshotEntry): number {
  const period = e.period || 30;
  const frac = Math.max(0, Math.min(1, secondsLeft(e) / period));
  return RING_CIRCUMFERENCE * (1 - frac);
}
function tagOf(id: string): AuthenticatorTag | undefined { return tags.value.find((x) => x.id === id); }

function copy(e: AuthenticatorSnapshotEntry): void {
  const c = codes.value[e.id];
  if (!c) return;
  post({ type: 'copy', code: c.code, entryId: e.id });
}

function onMsg(msg: any): void {
  if (msg.type === 'snapshot') {
    entries.value = msg.entries ?? [];
    groups.value = msg.groups ?? [];
    tags.value = msg.tags ?? [];
    // 仅"本次提交成功"后的快照才关闭表单（无关变更不应丢弃用户正在填写的内容）。
    if (formOpen.value && pendingSubmit.value) {
      formOpen.value = false;
      editingId.value = null;
      formError.value = '';
      pendingSubmit.value = false;
      form.secret = '';
    }
  } else if (msg.type === 'tick') {
    codes.value = msg.codes ?? {};
  } else if (msg.type === 'copyOk') {
    copiedId.value = msg.entryId;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedId.value = null; }, 1200);
  } else if (msg.type === 'formError') {
    const external = msg.source === 'external';
    if (!external && formOpen.value) { formError.value = msg.message ?? ''; pendingSubmit.value = false; }
    else promptError.value = msg.message ?? '';
  } else if (msg.type === 'openAddForm') {
    startAdd();
  } else if (msg.type === 'error') {
    errMsg.value = msg.message ?? '';
    if (errTimer) clearTimeout(errTimer);
    errTimer = setTimeout(() => { errMsg.value = ''; }, 4000);
  }
}

function isValidBase32(s: string): boolean {
  const compact = s.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z2-7]+=*$/.test(compact);
}

function startAdd(): void {
  editingId.value = null;
  formError.value = '';
  pendingSubmit.value = false;
  Object.assign(form, { issuer: '', account: '', secret: '', algorithm: 'SHA1', digits: 6, period: 30, groupId: '', tags: [] });
  formOpen.value = true;
}
function startEdit(e: AuthenticatorSnapshotEntry): void {
  editingId.value = e.id;
  formError.value = '';
  pendingSubmit.value = false;
  Object.assign(form, {
    issuer: e.issuer, account: e.account ?? '', secret: '',
    algorithm: e.algorithm, digits: e.digits, period: e.period,
    groupId: e.groupId ?? '', tags: [...e.tags],
  });
  formOpen.value = true;
  menuFor.value = null;
}
function cancelForm(): void {
  formOpen.value = false;
  editingId.value = null;
  formError.value = '';
  pendingSubmit.value = false;
  form.secret = '';
}
function toggleFormTag(id: string): void {
  const i = form.tags.indexOf(id);
  if (i >= 0) form.tags.splice(i, 1); else form.tags.push(id);
}
function submitForm(): void {
  formError.value = '';
  const secret = form.secret.trim();
  if (editingId.value === null && !secret) { formError.value = t('wv.authenticator.form.invalidSecret'); return; }
  if (secret && !isValidBase32(secret)) { formError.value = t('wv.authenticator.form.invalidSecret'); return; }
  const groupId = form.groupId || null;
  pendingSubmit.value = true;
  if (editingId.value) {
    post({
      type: 'update', id: editingId.value,
      patch: {
        issuer: form.issuer,
        account: form.account, // 空串=清空（store 用 ?? 判定，'' 会真正清空）
        ...(secret ? { secret } : {}),
        algorithm: form.algorithm, digits: form.digits, period: form.period,
        groupId, tags: [...form.tags],
      },
    });
  } else {
    post({
      type: 'add',
      entry: {
        issuer: form.issuer, account: form.account || undefined, secret,
        algorithm: form.algorithm, digits: form.digits, period: form.period,
        groupId, tags: [...form.tags],
      },
    });
  }
}

function requestAdd(): void { post({ type: 'requestAddForm' }); }
function requestExport(): void { post({ type: 'export' }); }
function pickImage(): void { fileInput.value?.click(); }
async function processImage(blob: Blob): Promise<void> {
  if (imgBusy.value) return;
  if (blob.size > MAX_IMAGE_BYTES) { promptError.value = t('wv.authenticator.image.tooLarge'); return; }
  imgBusy.value = true;
  promptError.value = '';
  try {
    const bmp = await createImageBitmap(blob);
    if (bmp.width * bmp.height > MAX_DECODE_PIXELS) { bmp.close?.(); throw new ImageTooLarge(); }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    // 逐步降低长边，直到编码后的 dataURL 字节数不超过主进程上限（与 8MB 对齐）。
    let side = MAX_IMAGE_SIDE;
    let dataUrl = '';
    for (;;) {
      const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(bmp, 0, 0, w, h);
      dataUrl = canvas.toDataURL('image/png');
      if (dataUrlBytes(dataUrl) <= HOST_MAX_BYTES || side <= 512) break;
      side = Math.max(512, Math.floor(side / 2));
    }
    bmp.close?.();
    post({ type: 'addImage', dataUrl });
  } catch (e) {
    promptError.value = e instanceof ImageTooLarge
      ? t('wv.authenticator.image.tooLarge')
      : t('wv.authenticator.image.invalid');
  } finally {
    imgBusy.value = false;
  }
}
class ImageTooLarge extends Error {}
function dataUrlBytes(u: string): number {
  const i = u.indexOf(',');
  if (i < 0) return u.length;
  return Math.floor(((u.length - i - 1) * 3) / 4);
}
function onFileInput(e: Event): void {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f) void processImage(f);
  input.value = '';
}
function isTextEntry(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (!e) return false;
  const tag = e.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || e.isContentEditable === true;
}
function onPaste(e: ClipboardEvent): void {
  const dt = e.clipboardData;
  if (!dt) return;
  const text = dt.getData('text/plain').trim();
  // otpauth 链接粘贴：链接语义明确，无论焦点在哪都走"粘贴链接"（secret 不进 webview）。
  if (text.startsWith('otpauth://') || text.startsWith('otpauth-migration://')) {
    e.preventDefault();
    post({ type: 'addUri', uri: text });
    return;
  }
  // 其余情况：输入框内粘贴不劫持，避免吞掉正常文本粘贴。
  if (isTextEntry(e.target)) return;
  for (const it of dt.items) {
    if (it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); void processImage(f); }
      return;
    }
  }
}
function onDrop(e: DragEvent): void {
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith('image/')) { e.preventDefault(); void processImage(f); }
}
function toggleEntryMenu(id: string): void {
  confirmDeleteId.value = null; // 切换菜单时复位上一个条目的确认态
  menuFor.value = menuFor.value === id ? null : id;
}
function requestDelete(id: string): void { post({ type: 'delete', id }); menuFor.value = null; confirmDeleteId.value = null; }

function toggleGroupMenu(id: string): void {
  confirmDeleteGroupId.value = null; // 切换菜单时复位上一个分组的确认态
  groupMenuFor.value = groupMenuFor.value === id ? null : id;
}
function openGroupPrompt(mode: 'new' | 'rename' | 'above' | 'below', opts?: { id?: string; beforeId?: string; afterId?: string; name?: string }): void {
  promptError.value = '';
  groupPrompt.value = { mode, id: opts?.id, beforeId: opts?.beforeId, afterId: opts?.afterId, value: opts?.name ?? '' };
  groupMenuFor.value = null;
}
function submitGroupPrompt(): void {
  const p = groupPrompt.value;
  if (!p) return;
  const name = p.value.trim();
  groupPrompt.value = null;
  promptError.value = '';
  if (!name) return;
  if (p.mode === 'rename' && p.id) post({ type: 'updateGroup', id: p.id, name });
  else if (p.mode === 'above' && p.beforeId) post({ type: 'addGroup', name, beforeId: p.beforeId });
  else if (p.mode === 'below' && p.afterId) post({ type: 'addGroup', name, afterId: p.afterId });
  else post({ type: 'addGroup', name }); // new / 缺锚点 → 追加
}
function moveGroup(id: string, dir: -1 | 1): void {
  const ordered = [...orderedGroupIds.value];
  const i = ordered.indexOf(id);
  const j = i + dir;
  groupMenuFor.value = null;
  if (i < 0 || j < 0 || j >= ordered.length) return;
  [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  post({ type: 'reorderGroup', orderedGroupIds: ordered });
}
function requestDeleteGroup(id: string): void {
  groupMenuFor.value = null;
  confirmDeleteGroupId.value = null;
  if (!groups.value.some((g) => g.id === id)) return;
  post({ type: 'deleteGroup', id });
  // 不做乐观提示：删除结果由快照体现（条目回落到未分组），避免失败时误报。
}

function openTagPrompt(): void { promptError.value = ''; tagPrompt.value = { name: '', color: 'blue' }; }
function submitTagPrompt(): void {
  const p = tagPrompt.value;
  if (!p) return;
  const name = p.name.trim();
  tagPrompt.value = null;
  promptError.value = '';
  if (name) post({ type: 'addTag', name, color: p.color });
}
function requestDeleteTag(id: string): void {
  if (confirmTagDeleteId.value === id) {
    post({ type: 'removeTag', id });
    confirmTagDeleteId.value = null;
    if (activeTag.value === id) activeTag.value = null;
  } else {
    confirmTagDeleteId.value = id;
  }
}

onMounted(() => {
  post({ type: 'ready' });
  off = onMessage(onMsg);
  window.addEventListener('paste', onPaste);
});
onUnmounted(() => {
  off?.();
  window.removeEventListener('paste', onPaste);
  if (copiedTimer) clearTimeout(copiedTimer);
  if (errTimer) clearTimeout(errTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<template>
  <div class="auth" @dragover.prevent @drop.prevent="onDrop">
    <div v-if="errMsg" class="auth-err">{{ errMsg }}</div>

    <div class="toolbar">
      <input v-model="query" class="search" type="text" :placeholder="t('wv.authenticator.search')" />
      <button class="btn" :title="t('wv.authenticator.add')" @click="requestAdd">＋</button>
      <button class="btn" :title="t('wv.authenticator.image.button')" :aria-label="t('wv.authenticator.image.pasteHint')" :disabled="imgBusy" @click="pickImage">🖼</button>
      <button class="btn" :title="t('wv.authenticator.export')" @click="requestExport">⭳</button>
      <input ref="fileInput" class="hidden-file" type="file" accept="image/*" @change="onFileInput" />
    </div>

    <div class="tagbar">
      <button class="tagchip" :class="{ active: activeTag === null }" @click="activeTag = null">{{ t('wv.authenticator.tag.all') }}</button>
      <button
        v-for="tg in tags"
        :key="tg.id"
        class="tagchip"
        :class="{ active: activeTag === tg.id }"
        :style="{ borderColor: TAG_HEX[tg.color] }"
        @click="activeTag = tg.id"
      >
        <span class="dot" :style="{ background: TAG_HEX[tg.color] }" />{{ tg.name }}
        <span class="tag-x" :title="t('wv.authenticator.tag.delete')" @click.stop="requestDeleteTag(tg.id)">{{ confirmTagDeleteId === tg.id ? '✓' : '×' }}</span>
      </button>
      <button class="tagchip add" @click="openTagPrompt">＋{{ t('wv.authenticator.tag.new') }}</button>
    </div>

    <div v-if="promptError" class="form-error">{{ promptError }}</div>

    <div v-if="tagPrompt" class="inline-prompt">
      <input v-model="tagPrompt.name" class="inline-input" :placeholder="t('wv.authenticator.tag.new')" />
      <select v-model="tagPrompt.color" class="inline-select">
        <option v-for="c in TAG_COLORS" :key="c" :value="c">{{ c }}</option>
      </select>
      <button class="btn" @click="submitTagPrompt">{{ t('wv.common.save') }}</button>
      <button class="btn" @click="tagPrompt = null">{{ t('wv.common.cancel') }}</button>
    </div>

    <div v-if="groupPrompt" class="inline-prompt">
      <input v-model="groupPrompt.value" class="inline-input" :placeholder="t('wv.authenticator.group.prompt')" @keydown.enter="submitGroupPrompt" />
      <button class="btn" @click="submitGroupPrompt">{{ t('wv.common.save') }}</button>
      <button class="btn" @click="groupPrompt = null">{{ t('wv.common.cancel') }}</button>
    </div>

    <div v-if="formOpen" class="form">
      <div class="form-row">
        <label>{{ t('wv.authenticator.form.issuer') }}</label>
        <input v-model="form.issuer" class="inline-input" />
      </div>
      <div class="form-row">
        <label>{{ t('wv.authenticator.form.account') }}</label>
        <input v-model="form.account" class="inline-input" />
      </div>
      <div class="form-row">
        <label>{{ t('wv.authenticator.form.secret') }}</label>
        <input
          v-model="form.secret"
          class="inline-input"
          type="password"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :placeholder="editingId ? t('wv.authenticator.form.secretKeep') : ''"
        />
      </div>
      <div class="form-row">
        <label>{{ t('wv.authenticator.form.algorithm') }}</label>
        <select v-model="form.algorithm" class="inline-select">
          <option value="SHA1">SHA1</option>
          <option value="SHA256">SHA256</option>
          <option value="SHA512">SHA512</option>
        </select>
        <label>{{ t('wv.authenticator.form.digits') }}</label>
        <select v-model.number="form.digits" class="inline-select">
          <option :value="6">6</option>
          <option :value="8">8</option>
        </select>
        <label>{{ t('wv.authenticator.form.period') }}</label>
        <select v-model.number="form.period" class="inline-select">
          <option :value="30">30</option>
          <option :value="60">60</option>
        </select>
      </div>
      <div class="form-row">
        <label>{{ t('wv.authenticator.form.group') }}</label>
        <select v-model="form.groupId" class="inline-select">
          <option value="">{{ t('wv.authenticator.form.noGroup') }}</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
      </div>
      <div class="form-row tags-row">
        <label>{{ t('wv.authenticator.form.tags') }}</label>
        <button
          v-for="tg in tags"
          :key="tg.id"
          class="tagchip"
          :class="{ active: form.tags.includes(tg.id) }"
          :style="{ borderColor: TAG_HEX[tg.color] }"
          @click="toggleFormTag(tg.id)"
        >
          <span class="dot" :style="{ background: TAG_HEX[tg.color] }" />{{ tg.name }}
        </button>
      </div>
      <div v-if="formError" class="form-error">{{ formError }}</div>
      <div class="form-actions">
        <button class="btn primary" @click="submitForm">{{ t('wv.common.save') }}</button>
        <button class="btn" @click="cancelForm">{{ t('wv.common.cancel') }}</button>
      </div>
    </div>

    <div v-if="entries.length === 0" class="auth-empty">{{ t('wv.authenticator.empty') }}</div>
    <div v-else-if="filteredEntries.length === 0" class="auth-empty">{{ t('wv.authenticator.emptySearch') }}</div>
    <div v-else class="groups">
      <section v-for="sec in sections" :key="sec.key" class="group">
        <header class="group-head">
          <button class="fold" @click="toggleFold(sec.groupId)">{{ isFolded(sec.groupId) ? '▸' : '▾' }}</button>
          <span class="group-name">{{ sec.name }}</span>
          <span class="count">{{ sec.entries.length }}</span>
          <span class="group-actions">
            <template v-if="sec.groupId">
              <button class="icon" :title="t('wv.authenticator.group.menu')" @click="toggleGroupMenu(sec.groupId)">⋯</button>
              <div v-if="groupMenuFor === sec.groupId" class="menu" @click.stop>
                <button class="menu-item" @click="openGroupPrompt('above', { beforeId: sec.groupId })">{{ t('wv.authenticator.group.addAbove') }}</button>
                <button class="menu-item" @click="openGroupPrompt('below', { afterId: sec.groupId })">{{ t('wv.authenticator.group.addBelow') }}</button>
                <button class="menu-item" @click="moveGroup(sec.groupId, -1)">{{ t('wv.authenticator.group.moveUp') }}</button>
                <button class="menu-item" @click="moveGroup(sec.groupId, 1)">{{ t('wv.authenticator.group.moveDown') }}</button>
                <button class="menu-item" @click="openGroupPrompt('rename', { id: sec.groupId, name: sec.name })">{{ t('wv.authenticator.group.rename') }}</button>
                <button v-if="confirmDeleteGroupId !== sec.groupId" class="menu-item danger" @click="confirmDeleteGroupId = sec.groupId">{{ t('wv.authenticator.group.delete') }}</button>
                <button v-else class="menu-item danger" @click="requestDeleteGroup(sec.groupId)">✓ {{ t('wv.authenticator.group.delete') }}</button>
              </div>
            </template>
            <button v-else class="icon" :title="t('wv.authenticator.group.new')" @click="openGroupPrompt('new')">＋</button>
          </span>
        </header>
        <ul v-if="!isFolded(sec.groupId)" class="auth-list">
          <li v-if="sec.entries.length === 0" class="group-empty">{{ t('wv.authenticator.emptyGroup') }}</li>
          <li
            v-for="e in sec.entries"
            :key="e.id"
            class="auth-card"
            :class="{ missing: e.error === 'secretMissing', warn: secondsLeft(e) <= 5 }"
            role="button"
            tabindex="0"
            @click="copy(e)"
            @keydown.enter.self.prevent="copy(e)"
            @keydown.space.self.prevent="copy(e)"
          >
            <div class="meta">
              <div class="issuer">{{ nameOf(e) }}</div>
              <div v-if="accountOf(e)" class="account">{{ accountOf(e) }}</div>
              <div v-if="e.tags.length" class="card-tags">
                <span v-for="tid in e.tags" :key="tid" class="card-tag" :style="{ color: tagOf(tid) ? TAG_HEX[tagOf(tid)!.color] : '' }">{{ tagOf(tid)?.name }}</span>
              </div>
              <div v-if="e.localOnly || e.syncError === 'quota'" class="sync-flag">{{ t('wv.authenticator.sync.quota') }}</div>
            </div>
            <div class="code-area">
              <span v-if="e.error === 'secretMissing'" class="missing-text">{{ t('wv.authenticator.secretMissing') }}</span>
              <template v-else>
                <span class="code">{{ codeOf(e) }}</span>
                <svg class="ring" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
                  <circle class="ring-track" cx="16" cy="16" r="13" />
                  <circle class="ring-progress" cx="16" cy="16" r="13" :stroke-dasharray="RING_CIRCUMFERENCE" :stroke-dashoffset="dashOffset(e)" />
                </svg>
              </template>
            </div>
            <div class="card-menu">
              <button class="icon" @click.stop="toggleEntryMenu(e.id)">⋯</button>
              <div v-if="menuFor === e.id" class="menu" @click.stop>
                <button class="menu-item" @click="startEdit(e)">{{ t('wv.authenticator.entry.edit') }}</button>
                <button v-if="confirmDeleteId !== e.id" class="menu-item" @click="confirmDeleteId = e.id">{{ t('wv.authenticator.entry.delete') }}</button>
                <button v-else class="menu-item danger" @click="requestDelete(e.id)">✓ {{ t('wv.authenticator.entry.delete') }}</button>
              </div>
            </div>
            <span v-if="copiedId === e.id" class="copied">{{ t('wv.authenticator.copied') }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.auth { padding: 8px; color: var(--vscode-foreground); font-size: 13px; }
.auth-err {
  margin-bottom: 8px; padding: 6px 8px; border-radius: 4px;
  background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
  color: var(--vscode-errorForeground);
}
.toolbar { display: flex; gap: 6px; margin-bottom: 6px; }
.search { flex: 1; min-width: 0; }
.hidden-file { display: none; }
input, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 3px 6px; }
.btn { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2)); color: var(--vscode-button-secondaryForeground, inherit); border: none; border-radius: 3px; padding: 3px 8px; cursor: pointer; }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.tagbar { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.tagchip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 1px 6px; border-radius: 10px; border: 1px solid transparent; background: transparent; color: var(--vscode-foreground); cursor: pointer; }
.tagchip.active { background: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,0.3)); }
.tagchip .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.tagchip .tag-x { opacity: 0.5; margin-left: 2px; }
.tagchip .tag-x:hover { opacity: 1; }
.inline-prompt { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
.inline-input { flex: 1; min-width: 0; }
.inline-select { max-width: 120px; }
.form { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); border-radius: 6px; padding: 8px; margin-bottom: 8px; }
.form-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.form-row label { font-size: 11px; opacity: 0.8; min-width: 52px; }
.form-row .inline-input { flex: 1; }
.tags-row { align-items: flex-start; }
.form-error { color: var(--vscode-errorForeground); font-size: 12px; margin-bottom: 6px; }
.form-actions { display: flex; gap: 6px; }
.auth-empty { padding: 16px 8px; opacity: 0.8; line-height: 1.5; }
.groups { display: flex; flex-direction: column; gap: 10px; }
.group-head { display: flex; align-items: center; gap: 6px; }
.group-head .fold { background: none; border: none; cursor: pointer; color: inherit; padding: 0 2px; }
.group-name { font-weight: 600; }
.group-head .count { opacity: 0.6; font-size: 11px; }
.group-actions { margin-left: auto; position: relative; display: flex; gap: 2px; }
.icon { background: none; border: none; cursor: pointer; color: inherit; padding: 0 3px; opacity: 0.8; }
.icon:hover { opacity: 1; }
.auth-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.group-empty { opacity: 0.6; font-size: 12px; padding: 6px 4px; }
.auth-card {
  position: relative; display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 8px 10px; border-radius: 6px; cursor: pointer;
  background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
  border: 1px solid var(--vscode-widget-border, transparent);
}
.auth-card:hover { background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.16)); }
.auth-card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.auth-card.missing { opacity: 0.7; cursor: default; }
.auth-card.warn .code { color: var(--vscode-errorForeground); }
.meta { min-width: 0; display: flex; flex-direction: column; }
.issuer { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account { font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px; }
.card-tag { font-size: 10px; opacity: 0.9; }
.sync-flag { font-size: 10px; margin-top: 2px; color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground)); }
.code-area { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.code { font-family: var(--vscode-editor-font-family, monospace); font-size: 20px; letter-spacing: 2px; }
.missing-text { font-size: 11px; color: var(--vscode-errorForeground); max-width: 140px; }
.ring { transform: rotate(-90deg); }
.ring-track { fill: none; stroke: var(--vscode-foreground, #888); opacity: 0.2; stroke-width: 2.5; }
.ring-progress { fill: none; stroke: var(--vscode-progressBar-background, #0a84ff); stroke-width: 2.5; stroke-linecap: round; transition: stroke-dashoffset 0.9s linear; }
.card-menu { position: relative; flex-shrink: 0; }
.menu { position: absolute; right: 0; top: 100%; z-index: 10; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border)); border-radius: 4px; padding: 2px; display: flex; flex-direction: column; }
.menu-item { background: none; border: none; text-align: left; padding: 3px 10px; cursor: pointer; color: inherit; white-space: nowrap; }
.menu-item:hover { background: var(--vscode-menu-selectionBackground, rgba(128,128,128,0.3)); }
.menu-item.danger { color: var(--vscode-errorForeground); }
.copied { position: absolute; top: 4px; right: 30px; font-size: 10px; color: var(--vscode-descriptionForeground); }
</style>
