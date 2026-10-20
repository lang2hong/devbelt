<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase, navigate } from '../lib/router';
import { listAdminInvoices, setInvoiceStatus, type AdminInvoice } from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { formatDateTime } from '../lib/formatTime';
import Modal from '../components/Modal.vue';
import FormField from '../components/FormField.vue';
import Pager from '../components/Pager.vue';
import { useCursorPages } from '../lib/useCursorPages';

const invoices = ref<AdminInvoice[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const loadError = ref('');
const statusFilter = ref('');
const userId = ref('');
const busy = ref(false);

const processWrite = useIdempotencyKey();
const processForm = ref<AdminInvoice | null>(null);
const processStatus = ref<'issued' | 'rejected' | 'failed'>('issued');
const processReason = ref('');

const STATUS_LABEL: Record<string, string> = { requested: '处理中', issued: '已开具', rejected: '已驳回', failed: '失败' };
const STATUS_OPTIONS = ['requested', 'issued', 'rejected', 'failed'];
const PROCESS_OPTIONS: Array<'issued' | 'rejected' | 'failed'> = ['issued', 'rejected', 'failed'];

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

function fmtCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

let loadSeq = 0;
const { page, pageSize, total, hasNext, cursor, reset: resetPager, apply: applyPage, next: nextPage, prev: prevPage, setPageSize } = useCursorPages();

async function load(): Promise<void> {
  const seq = ++loadSeq;
  state.value = 'loading';
  loadError.value = '';
  const rawUserId = userId.value.trim();
  if (rawUserId) {
    const uidNum = Number(rawUserId);
    if (!/^[0-9]+$/.test(rawUserId) || !Number.isSafeInteger(uidNum) || uidNum <= 0) {
      state.value = 'error';
      loadError.value = '用户 ID 必须为正整数。';
      return;
    }
  }
  const r = await listAdminInvoices({
    userId: rawUserId || undefined,
    status: statusFilter.value || undefined,
    cursor: cursor.value,
    limit: pageSize.value,
  });
  if (seq !== loadSeq) return;
  if (r.kind === 'ok') {
    invoices.value = r.value.items;
    applyPage({ nextCursor: r.value.nextCursor, total: r.value.total });
    state.value = 'ready';
  } else if (r.kind === 'unauthorized') relogin();
  else {
    state.value = 'error';
    loadError.value = '加载失败。';
  }
}

onMounted(() => load());

function search(): void {
  invoices.value = [];
  resetPager();
  void load();
}

function goPrev(): void {
  if (prevPage()) void load();
}

function goNext(): void {
  if (nextPage()) void load();
}

function changePageSize(size: number): void {
  setPageSize(size);
  void load();
}

function goUser(uid: string): void {
  navigate(`/users/${uid}`);
}

function openProcess(inv: AdminInvoice): void {
  processForm.value = inv;
  processStatus.value = 'issued';
  processReason.value = '';
  error.value = '';
}

function closeProcess(): void {
  if (busy.value) return;
  processForm.value = null;
}

async function confirm(): Promise<void> {
  if (!processForm.value || busy.value) return;
  const inv = processForm.value;
  const reasonValue = processReason.value.trim();
  if ((processStatus.value === 'rejected' || processStatus.value === 'failed') && !reasonValue) {
    error.value = '请填写原因。';
    return;
  }
  const tag = `invoice:${inv.invoiceId}:${processStatus.value}:${reasonValue}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await setInvoiceStatus(inv.invoiceId, processStatus.value, reasonValue, processWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      processWrite.reset(tag);
      processForm.value = null;
      await load();
    } else if (r.kind === 'unauthorized') {
      processWrite.reset(tag);
      relogin();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '操作失败，请重试。';
    } else {
      processWrite.reset(tag);
      error.value = '操作失败：仅「处理中」的发票可处理。';
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>发票</h2>
      <p class="sub">处理用户提交的开票申请：确认后标记已开票，无法开票时填写原因拒绝。</p>
    </header>

    <div class="bar">
      <input v-model="userId" type="text" placeholder="用户ID" @keyup.enter="search" />
      <select v-model="statusFilter">
        <option value="">全部状态</option>
        <option v-for="s in STATUS_OPTIONS" :key="s" :value="s">{{ STATUS_LABEL[s] }}</option>
      </select>
      <button class="btn" @click="search">查询</button>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">{{ loadError }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <table v-if="state === 'ready'" class="table">
      <thead>
        <tr><th>发票ID</th><th>用户ID</th><th>抬头</th><th>税号</th><th>金额</th><th>邮箱</th><th>状态</th><th>原因</th><th>申请时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="i in invoices" :key="i.invoiceId">
          <td class="mono">{{ i.invoiceId }}</td>
          <td class="mono"><a class="user-link" :href="withBase(`/users/${i.userId}`)" @click.prevent="goUser(i.userId)">{{ i.userId }}</a></td>
          <td>{{ i.title }}</td>
          <td class="mono">{{ i.taxNo ?? '—' }}</td>
          <td>¥{{ fmtCents(i.amountCents) }}</td>
          <td>{{ i.email }}</td>
          <td><span class="badge" :class="i.status">{{ STATUS_LABEL[i.status] ?? i.status }}</span></td>
          <td class="muted">{{ i.reason ?? '—' }}</td>
          <td>{{ formatDateTime(i.createTime) }}</td>
          <td class="actions">
            <button v-if="i.status === 'requested'" class="btn small" :disabled="busy" @click="openProcess(i)">处理</button>
          </td>
        </tr>
        <tr v-if="invoices.length === 0"><td colspan="10" class="muted">无匹配发票。</td></tr>
      </tbody>
    </table>

    <Pager
      v-if="state === 'ready'"
      :page="page"
      :page-size="pageSize"
      :total="total"
      :count="invoices.length"
      :has-next="hasNext"
      :loading="state === 'loading'"
      @prev="goPrev"
      @next="goNext"
      @update:page-size="changePageSize"
    />

    <Modal v-if="processForm" title="处理发票" :closable="!busy" @close="closeProcess">
      <table class="kv">
        <tbody>
          <tr><th>抬头</th><td>{{ processForm.title }}</td></tr>
          <tr><th>税号</th><td class="mono">{{ processForm.taxNo ?? '—' }}</td></tr>
          <tr><th>金额</th><td>¥{{ fmtCents(processForm.amountCents) }}</td></tr>
          <tr><th>接收邮箱</th><td>{{ processForm.email }}</td></tr>
        </tbody>
      </table>
      <label>处理结果</label>
      <select v-model="processStatus">
        <option v-for="s in PROCESS_OPTIONS" :key="s" :value="s">{{ STATUS_LABEL[s] }}</option>
      </select>
      <label v-if="processStatus === 'rejected' || processStatus === 'failed'">原因（必填）</label>
      <FormField v-if="processStatus === 'rejected' || processStatus === 'failed'" label="原因" required hint="必填，会记录到审计日志。">
        <input v-model="processReason" type="text" maxlength="500" placeholder="例如：抬头信息不全" />
      </FormField>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :disabled="busy" @click="confirm">确认</button>
        <button class="btn secondary" :disabled="busy" @click="closeProcess">取消</button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.user-link { color: var(--c-accent); text-decoration: none; }
.user-link:hover { text-decoration: underline; }
label { display: block; font-size: 13px; color: var(--c-text-muted); margin: 8px 0 4px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.kv { border-collapse: collapse; width: 100%; margin-bottom: 10px; }
.kv th { width: 88px; text-align: left; padding: 6px 10px 6px 0; color: var(--c-text-muted); font-weight: 500; font-size: 13px; vertical-align: top; }
.kv td { padding: 6px 0; font-size: 13.5px; word-break: break-all; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; background: var(--c-accent-bg); color: var(--c-accent); }
.badge.rejected, .badge.failed { background: var(--c-danger-bg); color: var(--c-danger); }
.badge.issued { background: var(--c-success-bg); color: var(--c-success-text); }
.badge.requested { background: var(--c-warn-bg); color: var(--c-warn-text); }
</style>