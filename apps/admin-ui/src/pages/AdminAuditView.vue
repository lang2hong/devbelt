<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase, navigate } from '../lib/router';
import { queryAudit, exportAudit, type AdminAuditEvent } from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey } from '../lib/idempotentWrite';
import { formatDateTime } from '../lib/formatTime';
import { toFromIso, toInclusiveEndIso } from '../lib/dateRange';
import { auditEventLabel, auditTargetLabel } from '../lib/auditLabels';
import Modal from '../components/Modal.vue';

const events = ref<AdminAuditEvent[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const fromTime = ref('');
const toTime = ref('');
const eventType = ref('');
const actorUserId = ref('');
const targetType = ref('');
const targetId = ref('');
const resultFilter = ref<'' | 'success' | 'failed'>('');
const nextCursor = ref<string | null>(null);
const detailEvent = ref<AdminAuditEvent | null>(null);

const EVENT_TYPE_SUGGESTIONS = [
  'admin.users.read', 'admin.user.disabled', 'admin.user.enabled', 'admin.user.subscription.changed',
  'admin.orders.read',
  'admin.audit.read', 'admin.audit.export', 'admin.role.granted',
  'payment.order.created', 'payment.order.paid', 'payment.order.fulfilled', 'payment.callback.failed',
  'invoice.requested', 'auth.login.success', 'auth.login.failed', 'auth.logout', 'auth.password.changed',
  'account.displayName.changed',
  'sync.reset.handoff.created', 'sync.reset.handoff.consumed', 'sync.reset.handoff.failed',
  'system.receipts.cleanup', 'auth.refresh.reuse', 'console.auth.refresh.reuse',
];

const TARGET_TYPE_SUGGESTIONS = ['user', 'order', 'subscription', 'device', 'idempotency_receipts'];

const exportWrite = useIdempotencyKey();

let loadSeq = 0;
let paging = false;

function goUser(uid: string | null): void {
  if (uid) navigate(`/users/${uid}`);
}

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

async function load(reset = true): Promise<void> {
  if (!reset && paging) return;
  const seq = ++loadSeq;
  if (reset) paging = false;
  else paging = true;
  try {
    state.value = 'loading';
    const r = await queryAudit({
      fromTime: toFromIso(fromTime.value),
      toTime: toInclusiveEndIso(toTime.value),
      eventType: eventType.value || undefined,
      actorUserId: actorUserId.value || undefined,
      targetType: targetType.value || undefined,
      targetId: targetId.value.trim() || undefined,
      result: resultFilter.value || undefined,
      cursor: reset ? undefined : (nextCursor.value ?? undefined),
    });
    if (seq !== loadSeq) return;
    if (r.kind === 'ok') {
      events.value = reset ? r.value.items : [...events.value, ...r.value.items];
      nextCursor.value = r.value.nextCursor;
      state.value = 'ready';
    } else if (r.kind === 'unauthorized') relogin();
    else state.value = 'error';
  } finally {
    if (!reset) paging = false;
  }
}

onMounted(() => load());

function search(): void {
  detailEvent.value = null;
  events.value = [];
  nextCursor.value = null;
  void load(true);
}

async function doExport(format: 'csv' | 'json'): Promise<void> {
  // tag 纳入有效过滤条件：变更筛选即新业务意图，避免「同 key 异 body」触发 KEY_REUSED。
  const tag = `export:${format}:${fromTime.value}|${toTime.value}|${eventType.value}|${actorUserId.value}|${targetType.value}|${targetId.value}|${resultFilter.value}`;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await exportAudit(format, {
      fromTime: toFromIso(fromTime.value),
      toTime: toInclusiveEndIso(toTime.value),
      eventType: eventType.value || undefined,
      actorUserId: actorUserId.value || undefined,
      targetType: targetType.value || undefined,
      targetId: targetId.value.trim() || undefined,
      result: resultFilter.value || undefined,
    }, exportWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      exportWrite.reset(tag);
      const blob = new Blob([r.value], { type: format === 'json' ? 'application/json' : 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } else if (r.kind === 'unauthorized') {
      exportWrite.reset(tag);
      relogin();
    } else {
      error.value = r.kind === 'failure' ? '导出失败，请重试。' : '导出失败。';
    }
  } catch {
    error.value = '导出失败，请重试。';
  }
}
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>审计日志</h2>
      <p class="sub">平台与用户的关键操作记录，用于追溯「谁在什么时候做了什么」。</p>
    </header>

    <div class="bar">
      <label class="range">时间
        <input v-model="fromTime" type="datetime-local" />
        至
        <input v-model="toTime" type="datetime-local" />
      </label>
      <input v-model="eventType" type="text" placeholder="操作类型（可输入提示）" list="event-type-suggestions" />
      <datalist id="event-type-suggestions">
        <option v-for="et in EVENT_TYPE_SUGGESTIONS" :key="et" :value="et">{{ auditEventLabel(et) }}</option>
      </datalist>
      <input v-model="actorUserId" type="text" placeholder="操作者用户ID" @keyup.enter="search" />
      <input v-model="targetType" type="text" placeholder="对象类型（如 user/order）" list="target-type-suggestions" />
      <datalist id="target-type-suggestions">
        <option v-for="tt in TARGET_TYPE_SUGGESTIONS" :key="tt" :value="tt">{{ auditTargetLabel(tt) }}</option>
      </datalist>
      <input v-model="targetId" type="text" placeholder="对象 ID" @keyup.enter="search" />
      <select v-model="resultFilter">
        <option value="">全部结果</option>
        <option value="success">成功</option>
        <option value="failed">失败</option>
      </select>
      <button class="btn" @click="search">查询</button>
      <button class="btn secondary" @click="doExport('json')">导出 JSON</button>
      <button class="btn secondary" @click="doExport('csv')">导出 CSV</button>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败。</p>
    <p v-if="error" class="error">{{ error }}</p>

    <table v-if="state === 'ready'" class="table">
      <thead>
        <tr><th>时间</th><th>操作者</th><th>操作</th><th>对象</th><th>结果</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="e in events" :key="e.eventId">
          <td>{{ formatDateTime(e.eventTime) }}</td>
          <td>
            <a v-if="e.actorUserId" class="user-link" :href="withBase(`/users/${e.actorUserId}`)" @click.prevent="goUser(e.actorUserId)">{{ e.actorUserId }}</a>
            <span v-else class="muted">系统</span>
          </td>
          <td :title="e.eventType">{{ auditEventLabel(e.eventType) }}</td>
          <td>{{ e.targetType ? `${auditTargetLabel(e.targetType)} #${e.targetId ?? '—'}` : '—' }}</td>
          <td><span class="badge" :class="e.result === 'success' ? 'ok' : 'danger'">{{ e.result === 'success' ? '成功' : '失败' }}</span></td>
          <td class="actions"><button class="btn small secondary" @click="detailEvent = e">详情</button></td>
        </tr>
        <tr v-if="events.length === 0"><td colspan="6" class="muted">无匹配记录。</td></tr>
      </tbody>
    </table>

    <p v-if="nextCursor" class="load-more"><button class="btn secondary" @click="load(false)">加载更多</button></p>

    <Modal v-if="detailEvent" title="审计事件详情" @close="detailEvent = null">
      <table class="kv">
        <tbody>
          <tr><th>事件 ID</th><td class="mono">{{ detailEvent.eventId }}</td></tr>
          <tr><th>时间</th><td>{{ formatDateTime(detailEvent.eventTime) }}</td></tr>
          <tr><th>操作者</th><td>{{ detailEvent.actorUserId ?? '系统' }}<span class="muted" v-if="detailEvent.actorRole">（{{ detailEvent.actorRole }}）</span></td></tr>
          <tr><th>操作</th><td>{{ auditEventLabel(detailEvent.eventType) }}<span class="muted mono"> · {{ detailEvent.eventType }}</span></td></tr>
          <tr><th>对象</th><td>{{ detailEvent.targetType ? `${auditTargetLabel(detailEvent.targetType)} #${detailEvent.targetId ?? '—'}` : '—' }}</td></tr>
          <tr><th>结果</th><td><span class="badge" :class="detailEvent.result === 'success' ? 'ok' : 'danger'">{{ detailEvent.result === 'success' ? '成功' : '失败' }}</span></td></tr>
          <tr><th>失败码</th><td class="mono">{{ detailEvent.failureCode ?? '—' }}</td></tr>
          <tr><th>原因</th><td>{{ detailEvent.reason ?? '—' }}</td></tr>
          <tr><th>来源 IP</th><td class="mono">{{ detailEvent.sourceIp ?? '—' }}</td></tr>
          <tr><th>Request ID</th><td class="mono">{{ detailEvent.requestId ?? '—' }}</td></tr>
        </tbody>
      </table>
      <div class="modal-actions">
        <button class="btn secondary" @click="detailEvent = null">关闭</button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.range { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text-muted); }
.user-link { color: var(--c-accent); text-decoration: none; }
.user-link:hover { text-decoration: underline; }
.mono { font-family: var(--font-mono); font-size: 12px; word-break: break-all; }
.kv { border-collapse: collapse; width: 100%; }
.kv th { width: 96px; text-align: left; padding: 7px 10px 7px 0; color: var(--c-text-muted); font-weight: 500; font-size: 13px; vertical-align: top; white-space: nowrap; }
.kv td { padding: 7px 0; font-size: 13.5px; word-break: break-all; }
</style>