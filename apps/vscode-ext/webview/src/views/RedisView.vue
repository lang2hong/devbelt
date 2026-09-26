<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import ServerStatus from '../components/redis/ServerStatus.vue';
import KeyTree from '../components/redis/KeyTree.vue';
import ValueViewer from '../components/redis/ValueViewer.vue';
import StreamViewer from '../components/redis/StreamViewer.vue';
import KeyNewDialog from '../components/redis/KeyNewDialog.vue';
import CliConsole from '../components/redis/CliConsole.vue';
import SlowLog from '../components/redis/SlowLog.vue';
import CommandLog from '../components/redis/CommandLog.vue';
import { computeStreamDone, isKeyBrowserPanel, type CommandResult, type RedisKeyFolder, type RedisNewKeyValue, type RedisPanel, type SlowlogEntry, type ValueInfo } from '../components/redis/types';

const { post, onMessage } = useVsCode();
const { t } = useI18n();
let off: (() => void) | undefined;

const connName = ref('');
const db = ref<number | null>(null);
const panel = ref<RedisPanel>('keyBrowser');
const connMode = ref<'standalone' | 'cluster' | 'sentinel'>('standalone');
const readOnly = ref(false);
const commands = ref<string[]>([]);
const info = ref('');
const entries = ref<SlowlogEntry[]>([]);
const results = ref<CommandResult[]>([]);
const pendingConfirm = ref<{ id: string; command: string } | null>(null);
interface CommandLogEntry { command: string; args: string[]; durationMs: number; ok: boolean; error: string | null; at: number }
const commandLog = ref<CommandLogEntry[]>([]);
const connectionEvents = ref<{ event: string; detail: string | null; at: number }[]>([]);
/** 键浏览器左栏宽度（可拖拽，局部状态）。 */
const leftWidth = ref(300);

// 键树
const emptyFolders: RedisKeyFolder = { name: '', path: '', count: 0, folders: [], keys: [] };
const folders = ref<RedisKeyFolder>(emptyFolders);
const cursor = ref('0');
const done = ref(true);
const scanned = ref(0);
const match = ref('');
const count = ref(200);
const keysLoading = ref(false);
const value = ref<ValueInfo | null>(null);
const banner = ref('');
const pendingDelete = ref<string[] | null>(null);
const showNewKey = ref(false);
const streamDetail = ref<any>(null);
const streamDone = ref(true);
const pendingOpDetail = ref<string | null>(null);
let lastOp: any = null;

const isKeyBrowser = computed(() => isKeyBrowserPanel(panel.value));
let seq = 0;
function nextId(): string { seq += 1; return `r${seq}`; }

/** 左栏拖拽（键浏览器），clamp 180–600px。 */
function startDrag(e: MouseEvent): void {
  e.preventDefault();
  const startX = e.clientX;
  const startW = leftWidth.value;
  const onMove = (ev: MouseEvent) => { leftWidth.value = Math.min(600, Math.max(180, startW + ev.clientX - startX)); };
  const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function onRefreshKeys(m: string, c: number): void {
  keysLoading.value = true;
  post({ type: 'refreshKeys', match: m, count: c });
}
function onLoadMore(): void {
  if (done.value) return;
  keysLoading.value = true;
  post({ type: 'loadMoreKeys' });
}
function onSelect(key: string): void {
  value.value = null;
  post({ type: 'selectKey', key });
}
function confirmDelete(): void {
  const keys = pendingDelete.value;
  pendingDelete.value = null;
  if (keys?.length) post({ type: 'deleteKeys', keys });
}
function onCreate(key: string, val: RedisNewKeyValue, ttlSeconds: number | null): void {
  showNewKey.value = false;
  post({ type: 'createKey', key, value: val, ttlSeconds });
}
function run(line: string): void { post({ type: 'runCommand', id: nextId(), line }); }
/** Stream/破坏性操作：记住原始 op，确认后带 confirmed 重发。 */
function postOp(msg: any): void { lastOp = msg; post(msg); }
function streamOps(): Record<string, (...a: any[]) => void> {
  return {
    add: (key, id, fields) => postOp({ type: 'streamAdd', key, id, fields }),
    del: (key, ids) => postOp({ type: 'streamDel', key, ids }),
    trim: (key, maxlen) => postOp({ type: 'streamTrim', key, maxlen }),
    groupCreate: (key, group, id, mkstream) => postOp({ type: 'streamGroupCreate', key, group, id, mkstream }),
    groupDestroy: (key, group) => postOp({ type: 'streamGroupDestroy', key, group }),
    groupDelConsumer: (key, group, consumer) => postOp({ type: 'streamGroupDelConsumer', key, group, consumer }),
    groupDetail: (key, group) => post({ type: 'streamGroupDetail', key, group }),
    loadMore: (key, start) => post({ type: 'streamRange', key, start }),
  };
}
const DESTRUCTIVE_OPS = new Set(['streamDel', 'streamTrim', 'streamGroupDestroy', 'streamGroupDelConsumer']);
function confirmOp(accept: boolean): void {
  const op = lastOp;
  pendingOpDetail.value = null;
  // 仅重发破坏性 op：确认模态只挡鼠标，期间键盘提交的普通 op（如 streamAdd）不得被 confirmed 重发。
  if (accept && op && DESTRUCTIVE_OPS.has(op.type)) post({ ...op, confirmed: true });
}
function confirmDanger(id: string, accept: boolean): void {
  pendingConfirm.value = null;
  post({ type: 'confirmDanger', id, accept });
}

/** 快捷键：Ctrl/Cmd+N 新建 key；Enter/Esc 操作模态（确认提交流程的键盘路径）。 */
function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
    if (isKeyBrowser.value && !readOnly.value) { e.preventDefault(); showNewKey.value = true; }
    return;
  }
  if (e.key === 'Escape') {
    if (pendingOpDetail.value !== null) { confirmOp(false); return; }
    if (pendingDelete.value) { pendingDelete.value = null; return; }
    if (showNewKey.value) { showNewKey.value = false; }
    return;
  }
  if (e.key === 'Enter') {
    if (pendingOpDetail.value !== null) { confirmOp(true); return; }
    if (pendingDelete.value) { confirmDelete(); }
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  post({ type: 'ready' });
  off = onMessage((msg: any) => {
    if (msg.type === 'config') {
      connName.value = msg.connName ?? '';
      db.value = typeof msg.db === 'number' ? msg.db : null;
      panel.value = (msg.panel as RedisPanel) ?? 'keyBrowser';
      connMode.value = (msg.connMode as typeof connMode.value) ?? 'standalone';
      readOnly.value = !!msg.readOnly;
      commands.value = msg.commands ?? [];
      // 切换面板/DB 时重置视图态，避免旧值残留。
      value.value = null;
      banner.value = '';
      folders.value = emptyFolders;
      if (isKeyBrowser.value) keysLoading.value = true;
    } else if (msg.type === 'keys') {
      folders.value = msg.folders ?? emptyFolders;
      cursor.value = msg.cursor ?? '0';
      done.value = !!msg.done;
      scanned.value = msg.scanned ?? 0;
      match.value = msg.match ?? '';
      keysLoading.value = false;
    } else if (msg.type === 'value') {
      value.value = msg as ValueInfo;
      streamDetail.value = null;
      // done 由 entries 与 XLEN 精确判定（不能硬编码 true，否则恰满一页的 stream 无法续页）。
      streamDone.value = computeStreamDone((msg as ValueInfo).data);
    } else if (msg.type === 'keyAction') {
      banner.value = msg.ok ? '' : String(msg.error ?? '');
    } else if (msg.type === 'info') {
      info.value = msg.info ?? '';
    } else if (msg.type === 'slowlog') {
      entries.value = msg.entries ?? [];
    } else if (msg.type === 'commandResult') {
      results.value = [...results.value, msg as CommandResult].slice(-100);
    } else if (msg.type === 'confirmRequired') {
      pendingConfirm.value = { id: msg.id, command: msg.command };
    } else if (msg.type === 'streamGroupDetail') {
      streamDetail.value = msg;
    } else if (msg.type === 'streamRangeResult') {
      // 只把结果贴回它所属的 key（选中态可能已切到另一个 stream）。
      if (value.value?.data?.kind === 'stream' && value.value.key === msg.key) {
        value.value = { ...value.value, data: { ...value.value.data, entries: [...value.value.data.entries, ...(msg.entries ?? [])] } };
        streamDone.value = !!msg.done;
      }
    } else if (msg.type === 'commandLog') {
      const e = msg.entry ?? {};
      commandLog.value = [...commandLog.value, { command: String(e.command ?? ''), args: e.args ?? [], durationMs: Number(e.durationMs ?? 0), ok: !!e.ok, error: e.error ?? null, at: Date.now() }].slice(-500);
    } else if (msg.type === 'connectionEvent') {
      connectionEvents.value = [...connectionEvents.value, { event: String(msg.event ?? ''), detail: msg.detail ?? null, at: Number(msg.at ?? Date.now()) }].slice(-100);
    } else if (msg.type === 'confirmOpRequired') {
      pendingOpDetail.value = String(msg.detail ?? '');
    } else if (msg.type === 'error') {
      banner.value = String(msg.message ?? '');
    }
  });
});
onUnmounted(() => { off?.(); window.removeEventListener('keydown', onKeydown); });
</script>

<template>
  <div class="redis-panel">
    <header class="header">
      <span class="conn">{{ connName }}</span>
      <span v-if="db !== null && connMode !== 'cluster'" class="db">db{{ db }}</span>
      <span v-if="readOnly" class="badge">{{ t('wv.redis.readOnly') }}</span>
      <button v-if="isKeyBrowser" class="btn" :disabled="readOnly" @click="showNewKey = true">＋ {{ t('wv.redis.newKey.title') }}</button>
    </header>
    <div v-if="banner" class="banner" @click="banner = ''">{{ banner }}</div>

    <div v-if="isKeyBrowser" class="kb">
      <aside class="left" :style="{ width: leftWidth + 'px' }">
        <KeyTree
          :folders="folders"
          :cursor="cursor"
          :done="done"
          :scanned="scanned"
          :match="match"
          :count="count"
          :loading="keysLoading"
          @refresh="onRefreshKeys"
          @load-more="onLoadMore"
          @select="onSelect"
          @delete-selected="pendingDelete = $event"
        />
      </aside>
      <div class="splitter" @mousedown="startDrag" />
      <section class="right">
          <StreamViewer
            v-if="value && value.keyType === 'stream' && value.data?.kind === 'stream'"
            :info="value"
            :detail="streamDetail"
            :done="streamDone"
            :read-only="readOnly"
            @add="streamOps().add"
            @del="streamOps().del"
            @trim="streamOps().trim"
            @group-create="streamOps().groupCreate"
            @group-destroy="streamOps().groupDestroy"
            @group-del-consumer="streamOps().groupDelConsumer"
            @group-detail="streamOps().groupDetail"
            @load-more="streamOps().loadMore"
          />
          <ValueViewer
            v-else
            :info="value"
            :read-only="readOnly"
            @refresh="value && post({ type: 'selectKey', key: value.key })"
            @load="value && post({ type: 'selectKey', key: value.key })"
            @save-string="(k, v) => post({ type: 'saveString', key: k, value: v })"
            @save-string-bytes="(k, b) => post({ type: 'saveStringBytes', key: k, base64: b })"
            @append-string="(k, v) => post({ type: 'appendString', key: k, value: v })"
            @set-ttl="(k, s) => post({ type: 'setTtl', key: k, seconds: s })"
            @persist="(k) => post({ type: 'persistKey', key: k })"
            @rename="(k, n) => post({ type: 'renameKey', key: k, newKey: n })"
            @remove="(k) => pendingDelete = [k]"
            @copy-key="() => {}"
            @hash-set="(k, f, v) => post({ type: 'hashSet', key: k, field: f, value: v })"
            @hash-del="(k, f) => post({ type: 'hashDel', key: k, fields: f })"
            @list-push="(k, s, v) => post({ type: 'listPush', key: k, side: s, values: v })"
            @list-set="(k, i, v) => post({ type: 'listSet', key: k, index: i, value: v })"
            @list-rem="(k, c, v) => post({ type: 'listRem', key: k, count: c, value: v })"
            @list-pop="(k, s) => post({ type: 'listPop', key: k, side: s })"
            @set-add="(k, m) => post({ type: 'setAdd', key: k, members: m })"
            @set-rem="(k, m) => post({ type: 'setRem', key: k, members: m })"
            @zset-add="(k, s, m) => post({ type: 'zsetAdd', key: k, score: s, member: m })"
            @zset-rem="(k, m) => post({ type: 'zsetRem', key: k, members: m })"
          />
        </section>
    </div>

    <CliConsole
      v-else-if="panel === 'console'"
      class="single"
      :results="results"
      :read-only="readOnly"
      :pending="pendingConfirm"
      :commands="commands"
      @run="run"
      @confirm="confirmDanger"
    />
    <SlowLog
      v-else-if="panel === 'slowlog'"
      class="single"
      :entries="entries"
      @refresh="post({ type: 'refreshSlowlog' })"
    />
    <CommandLog
      v-else-if="panel === 'commandLog'"
      class="single"
      :entries="commandLog"
      :events="connectionEvents"
    />
    <ServerStatus v-else-if="panel === 'serverStatus'" :info="info" @refresh="post({ type: 'refreshInfo' })" class="single" />

    <KeyNewDialog :show="showNewKey" @create="onCreate" @cancel="showNewKey = false" />

    <div v-if="pendingOpDetail !== null" class="mask">
      <div class="confirm">
        <p>{{ t('wv.redis.stream.confirm', { detail: pendingOpDetail }) }}</p>
        <div class="actions">
          <button class="btn danger" @click="confirmOp(true)">{{ t('wv.redis.confirm.run') }}</button>
          <button class="btn" @click="confirmOp(false)">{{ t('wv.redis.confirm.cancel') }}</button>
        </div>
      </div>
    </div>

    <div v-if="pendingDelete" class="mask">
      <div class="confirm">
        <p>{{ pendingDelete.length > 1 ? t('wv.redis.confirm.deleteKeys', { count: pendingDelete.length }) : t('wv.redis.confirm.deleteKey') }}</p>
        <div class="actions">
          <button class="btn danger" @click="confirmDelete">{{ t('wv.redis.value.delete') }}</button>
          <button class="btn" @click="pendingDelete = null">{{ t('wv.redis.confirm.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.redis-panel { display: flex; flex-direction: column; height: 100vh; padding: 8px 10px; box-sizing: border-box; font-size: 12px; position: relative; }
.header { display: flex; gap: 8px; align-items: center; }
.conn { font-weight: 600; }
.db { color: var(--vscode-descriptionForeground); }
.badge { padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
.banner { margin-top: 6px; padding: 4px 8px; border-radius: 3px; background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-errorForeground, #f88); cursor: pointer; }
/* 键浏览器：左树（可拖拽）+ 右值区，撑满高度。 */
.kb { flex: 1; min-height: 0; display: flex; margin-top: 8px; }
.left { flex: 0 0 auto; min-width: 180px; max-width: 600px; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); padding-right: 8px; overflow: hidden; }
.splitter { flex: 0 0 5px; cursor: col-resize; background: transparent; }
.splitter:hover { background: var(--vscode-focusBorder, rgba(128,128,128,0.4)); }
.right { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
/* 单栏面板（console/slowlog/commandLog/serverStatus）撑满。 */
.single { flex: 1; min-height: 0; margin-top: 8px; }
.mask { position: absolute; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; }
.confirm { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); border-radius: 6px; padding: 14px 16px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-foreground); }
</style>
