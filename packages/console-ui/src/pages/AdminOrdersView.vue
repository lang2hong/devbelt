<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { listAdminOrders, refundAdminOrder, type AdminOrder } from '../api/admin';
import { ensureCsrf, setAccessToken } from '../api/consoleAuth';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { formatDateTime } from '../lib/formatTime';
import AdminNav from './AdminNav.vue';
import Modal from '../components/Modal.vue';

const orders = ref<AdminOrder[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const userId = ref('');
const status = ref('');
const channel = ref('');
const planCode = ref('');
const nextCursor = ref<string | null>(null);

const error = ref('');
const loadError = ref('');
const busy = ref(false);
const refundWrite = useIdempotencyKey();
const refundForm = ref<AdminOrder | null>(null);
const refundReason = ref('');

const STATUS_LABEL: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  fulfilled: '已生效',
  failed: '支付失败',
  refunded: '已退款',
  expired: '已过期',
};

const STATUS_OPTIONS = ['pending', 'paid', 'fulfilled', 'failed', 'refunded', 'expired'];

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

function fmtCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

let loadSeq = 0;
let paging = false;

function channelLabel(ch: string): string {
  return ch === 'wechat' ? '微信' : '支付宝';
}

async function load(reset = true): Promise<void> {
  if (!reset && paging) return;
  const seq = ++loadSeq;
  if (reset) paging = false;
  else paging = true;
  try {
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
    const r = await listAdminOrders({
      userId: rawUserId || undefined,
      status: status.value || undefined,
      channel: channel.value || undefined,
      planCode: planCode.value || undefined,
      cursor: reset ? undefined : (nextCursor.value ?? undefined),
    });
    if (seq !== loadSeq) return;
    if (r.kind === 'ok') {
      orders.value = reset ? r.value.items : [...orders.value, ...r.value.items];
      nextCursor.value = r.value.nextCursor;
      state.value = 'ready';
    } else if (r.kind === 'unauthorized') relogin();
    else {
      state.value = 'error';
      loadError.value = '加载失败。';
    }
  } finally {
    if (!reset) paging = false;
  }
}

onMounted(() => load());

function search(): void {
  orders.value = [];
  nextCursor.value = null;
  void load(true);
}

function openRefund(o: AdminOrder): void {
  refundForm.value = o;
  refundReason.value = '';
  error.value = '';
}

function closeRefund(): void {
  if (busy.value) return;
  refundForm.value = null;
}

async function confirmRefund(): Promise<void> {
  if (!refundForm.value || busy.value) return;
  const o = refundForm.value;
  const reasonValue = refundReason.value.trim();
  if (!reasonValue) {
    error.value = '请填写退款原因。';
    return;
  }
  const tag = `refund:${o.orderNo}:${reasonValue}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await refundAdminOrder(o.orderNo, reasonValue, refundWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      refundWrite.reset(tag);
      refundForm.value = null;
      await load(true);
    } else if (r.kind === 'unauthorized') {
      refundWrite.reset(tag);
      relogin();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '操作失败，请重试。';
    } else {
      refundWrite.reset(tag);
      error.value = '操作失败：仅已支付/已生效订单可退款。';
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="page">
    <AdminNav />
    <h2>订单</h2>

    <div class="bar">
      <input v-model="userId" type="text" placeholder="用户ID" @keyup.enter="search" />
      <select v-model="status">
        <option value="">全部状态</option>
        <option v-for="s in STATUS_OPTIONS" :key="s" :value="s">{{ STATUS_LABEL[s] }}</option>
      </select>
      <select v-model="channel">
        <option value="">全部渠道</option>
        <option value="wechat">微信</option>
        <option value="alipay">支付宝</option>
      </select>
      <input v-model="planCode" type="text" placeholder="套餐" @keyup.enter="search" />
      <button class="btn" @click="search">查询</button>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">{{ loadError || '加载失败。' }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <table v-if="state === 'ready'" class="table">
      <thead>
        <tr><th>订单号</th><th>用户ID</th><th>套餐</th><th>金额</th><th>渠道</th><th>状态</th><th>渠道单号</th><th>创建时间</th><th>过期时间</th><th>支付时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="o in orders" :key="o.orderNo">
          <td class="mono">{{ o.orderNo }}</td>
          <td class="mono">{{ o.userId }}</td>
          <td>{{ o.planCode }}</td>
          <td>¥{{ fmtCents(o.amountCents) }}</td>
          <td>{{ channelLabel(o.channel) }}</td>
          <td><span class="badge" :class="o.status">{{ STATUS_LABEL[o.status] ?? o.status }}</span></td>
          <td class="mono">{{ o.channelTradeNo ?? '—' }}</td>
          <td>{{ formatDateTime(o.createTime) }}</td>
          <td>{{ formatDateTime(o.expiresTime) }}</td>
          <td>{{ formatDateTime(o.paidTime) }}</td>
          <td class="actions">
            <button v-if="o.status === 'paid' || o.status === 'fulfilled'" class="btn small danger" :disabled="busy" @click="openRefund(o)">退款</button>
          </td>
        </tr>
        <tr v-if="orders.length === 0"><td colspan="11" class="muted">无匹配订单。</td></tr>
      </tbody>
    </table>

    <p v-if="nextCursor" class="load-more"><button class="btn secondary" @click="load(false)">加载更多</button></p>

    <Modal v-if="refundForm" title="退款登记" :closable="!busy" @close="closeRefund">
      <p class="muted">{{ refundForm.orderNo }} · ¥{{ fmtCents(refundForm.amountCents) }}</p>
      <input v-model="refundReason" type="text" maxlength="500" placeholder="退款原因（必填）" />
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn danger" :disabled="busy" @click="confirmRefund">确认退款</button>
        <button class="btn secondary" :disabled="busy" @click="closeRefund">取消</button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.page { max-width: 1200px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; }
.bar { display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
input, select { box-sizing: border-box; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
.table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eaeef2; font-size: 13px; }
th { white-space: nowrap; color: #57606a; font-weight: 600; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
.badge.pending { background: #fff8c5; color: #9a6700; }
.badge.paid { background: #ddf4ff; color: #0969da; }
.badge.fulfilled { background: #dafbe1; color: #1a7f37; }
.badge.failed, .badge.expired, .badge.refunded { background: #ffebe9; color: #cf222e; }
.btn { background: #0969da; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.btn.secondary { background: #f6f8fa; color: #24292f; border: 1px solid #d0d7de; }
.btn.small { padding: 5px 10px; font-size: 13px; }
.btn.danger { background: #cf222e; }
.btn:disabled { opacity: 0.6; cursor: default; }
.actions { display: flex; gap: 6px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.muted { color: #57606a; font-size: 13px; }
.error { color: #cf222e; font-size: 13px; }
.load-more { margin: 16px 0; }
</style>