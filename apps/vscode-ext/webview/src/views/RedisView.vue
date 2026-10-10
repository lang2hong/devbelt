<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import ServerStatus from '../components/redis/ServerStatus.vue';
import MonitorPanel from '../components/redis/MonitorPanel.vue';
import ValueViewer from '../components/redis/ValueViewer.vue';
import StreamViewer from '../components/redis/StreamViewer.vue';
import CliConsole from '../components/redis/CliConsole.vue';
import SlowLog from '../components/redis/SlowLog.vue';
import CommandLog from '../components/redis/CommandLog.vue';
import { appendCollectionPage, computeStreamDone, isKeyBrowserPanel, type CommandResult, type RedisMonitorMetrics, type RedisPanel, type SlowlogEntry, type ValueInfo } from '../components/redis/types';

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
/** 监控面板：最新采样 + 最近 60 点历史（趋势用）。 */
const monitorMetrics = ref<RedisMonitorMetrics | null>(null);
const monitorSamples = ref<RedisMonitorMetrics[]>([]);
const entries = ref<SlowlogEntry[]>([]);
const results = ref<CommandResult[]>([]);
const pendingConfirm = ref<{ id: string; command: string } | null>(null);
interface CommandLogEntry { command: string; args: string[]; durationMs: number; ok: boolean; error: string | null; at: number }
const commandLog = ref<CommandLogEntry[]>([]);
const connectionEvents = ref<{ event: string; detail: string | null; at: number }[]>([]);

/** keyBrowser 面板 = 纯值查看/编辑（键导航在 explorer 树侧，见 S5-3/C-1）。 */
const value = ref<ValueInfo | null>(null);
const banner = ref('');
const pendingDelete = ref<string[] | null>(null);
const streamDetail = ref<any>(null);
const streamDone = ref(true);
const pendingOpDetail = ref<string | null>(null);
let lastOp: any = null;

const isValuePanel = computed(() => isKeyBrowserPanel(panel.value));
let seq = 0;
function nextId(): string { seq += 1; return `r${seq}`; }

function confirmDelete(): void {
  const keys = pendingDelete.value;
  pendingDelete.value = null;
  if (keys?.length) post({ type: 'deleteKeys', keys });
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
/** 集合续页（hash/list/set/zset）：token 带回自 value.more，host 按 token 取下一页。 */
function loadMoreCollections(): void {
  const v = value.value;
  const d = v?.data;
  if (!v || !d) return;
  const kind = d.kind;
  if (kind !== 'hash' && kind !== 'list' && kind !== 'set' && kind !== 'zset') return;
  post({ type: 'collectionMore', key: v.key, kind, cursor: v.more?.cursor, offset: v.more?.offset });
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

/** 快捷键：Enter/Esc 走确认模态（键新建已移至 explorer 树）。 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (pendingOpDetail.value !== null) { confirmOp(false); return; }
    if (pendingDelete.value) { pendingDelete.value = null; }
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
      monitorMetrics.value = null;
      monitorSamples.value = [];
    } else if (msg.type === 'value') {
      value.value = msg as ValueInfo;
      streamDetail.value = null;
      // done 由 entries 与 XLEN 精确判定（不能硬编码 true，否则恰满一页的 stream 无法续页）。
      streamDone.value = computeStreamDone((msg as ValueInfo).data);
    } else if (msg.type === 'keyAction') {
      banner.value = msg.ok ? '' : String(msg.error ?? '');
    } else if (msg.type === 'info') {
      info.value = msg.info ?? '';
    } else if (msg.type === 'monitorSample') {
      monitorMetrics.value = msg.metrics as RedisMonitorMetrics;
      monitorSamples.value = [...monitorSamples.value, msg.metrics as RedisMonitorMetrics].slice(-60);
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
    } else if (msg.type === 'collectionMoreResult') {
      // 只把结果贴回它所属的 key/类型（选中态可能已切换）；R1：并行 base64 同序同长合并。
      const d = value.value?.data;
      if (value.value && value.value.key === msg.key && d?.kind === msg.kind) {
        value.value = { ...value.value, data: appendCollectionPage(d, msg), more: msg.more };
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
    </header>
    <div v-if="banner" class="banner" @click="banner = ''">{{ banner }}</div>

    <template v-if="isValuePanel">
      <div v-if="!value" class="single empty-hint">{{ t('wv.redis.value.selectHint') }}</div>
      <StreamViewer
        v-else-if="value.keyType === 'stream' && value.data?.kind === 'stream'"
        class="single"
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
        class="single"
        :info="value"
        :read-only="readOnly"
        @refresh="value && post({ type: 'selectKey', key: value.key })"
        @load="value && post({ type: 'load', key: value.key })"
        @save-string="(k, v) => post({ type: 'saveString', key: k, value: v })"
        @save-string-bytes="(k, b) => post({ type: 'saveStringBytes', key: k, base64: b })"
        @append-string="(k, v) => post({ type: 'appendString', key: k, value: v })"
        @set-ttl="(k, s) => post({ type: 'setTtl', key: k, seconds: s })"
        @persist="(k) => post({ type: 'persistKey', key: k })"
        @rename="(k, n) => post({ type: 'renameKey', key: k, newKey: n })"
        @remove="(k) => pendingDelete = [k]"
        @copy-key="() => {}"
        @hash-set="(k, f, v, old, fb64, vb64) => post({ type: 'hashSet', key: k, field: f, value: v, oldField: old, fieldBase64: fb64, valueBase64: vb64 })"
        @hash-del="(k, f, b64) => post({ type: 'hashDel', key: k, fields: f, fieldsBase64: b64 })"
        @list-push="(k, s, v) => post({ type: 'listPush', key: k, side: s, values: v })"
        @list-set="(k, i, v, o, vb64, ob64) => post({ type: 'listSet', key: k, index: i, value: v, original: o, valueBase64: vb64, originalBase64: ob64 })"
        @list-rem="(k, i, v, b64) => post({ type: 'listRem', key: k, index: i, value: v, valueBase64: b64 })"
        @list-pop="(k, s) => post({ type: 'listPop', key: k, side: s })"
        @set-add="(k, m) => post({ type: 'setAdd', key: k, members: m })"
        @set-rem="(k, m, b64) => post({ type: 'setRem', key: k, members: m, membersBase64: b64 })"
        @zset-add="(k, s, m, old, mb64) => post({ type: 'zsetAdd', key: k, score: s, member: m, oldMember: old, memberBase64: mb64 })"
        @zset-rem="(k, m, b64) => post({ type: 'zsetRem', key: k, members: m, membersBase64: b64 })"
        @load-more="loadMoreCollections"
      />
    </template>
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
    <MonitorPanel
      v-else-if="panel === 'monitor'"
      class="single"
      :metrics="monitorMetrics"
      :samples="monitorSamples"
      @sample="post({ type: 'sampleMonitor' })"
    />

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
        <p>{{ t('wv.redis.confirm.deleteKey') }}</p>
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
/* 单栏面板（值/console/slowlog/commandLog/status）撑满。 */
.single { flex: 1; min-height: 0; margin-top: 8px; }
.empty-hint { display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); }
.mask { position: absolute; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; }
.confirm { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); border-radius: 6px; padding: 14px 16px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-foreground); }
</style>