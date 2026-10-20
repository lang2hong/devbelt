<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase, navigate } from '../lib/router';
import { listAdminOrders, refundAdminOrder, type AdminOrder } from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { formatDateTime } from '../lib/formatTime';
import { toFromIso, toInclusiveEndIso } from '../lib/dateRange';
import Modal from '../components/Modal.vue';
import FormField from '../components/FormField.vue';

const orders = ref<AdminOrder[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const userId = ref('');
const status = ref('');
const channel = ref('');
const purpose = ref('');
const planCode = ref('');
const createdFrom = ref('');
const createdTo = ref('');
const nextCursor = ref<string | null>(null);

const error = ref('');
const loadError = ref('');
const busy = ref(false);
const refundWrite = useIdempotencyKey();
const refundForm = ref<AdminOrder | null>(null);
const refundReason = ref('');
const detailForm = ref<AdminOrder | null>(null);

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
  return ch === 'wechat' ? '微信' : ch === 'alipay' ? '支付宝' : '手工';
}

function purposeLabel(p: string): string {
  return p === 'topup' ? '积分充值' : '套餐';
}

function goUser(uid: string): void {
  navigate(`/users/${uid}`);
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
      purpose: purpose.value || undefined,
      planCode: planCode.value || undefined,
      createdFrom: toFromIso(createdFrom.value),
      createdTo: toInclusiveEndIso(createdTo.value),
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

function resetFilters(): void {
  userId.value = '';
  status.value = '';
  channel.value = '';
  purpose.value = '';
  planCode.value = '';
  createdFrom.value = '';
  createdTo.value = '';
  search();
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
    <header class="head">
      <h2>订单</h2>
      <p class="sub">平台订单查询与退款。</p>
    </header>

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
        <option value="manual">手工</option>
      </select>
      <select v-model="purpose">
        <option value="">全部用途</option>
        <option value="plan">套餐</option>
        <option value="topup">加油包</option>
      </select>
      <input v-model="planCode" type="text" placeholder="套餐" @keyup.enter="search" />
      <label class="range">创建时间
        <input v-model="createdFrom" type="datetime-local" />
        至
        <input v-model="createdTo" type="datetime-local" />
      </label>
      <button class="btn" @click="search">查询</button>
      <button class="btn secondary" @click="resetFilters">重置</button>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">{{ loadError || '加载失败。' }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <table v-if="state === 'ready'" class="table">
      <thead>
        <tr><th>订单号</th><th>用户</th><th>商品</th><th>金额</th><th>状态</th><th>创建时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="o in orders" :key="o.orderNo">
          <td class="mono">{{ o.orderNo }}</td>
          <td><a class="user-link" :href="withBase(`/users/${o.userId}`)" :title="`用户 ID ${o.userId}`" @click.prevent="goUser(o.userId)">{{ o.userEmail ?? o.userId }}</a></td>
          <td>{{ purposeLabel(o.purpose) }} · {{ o.planCode ?? o.skuCode ?? '—' }}</td>
          <td>¥{{ fmtCents(o.amountCents) }}</td>
          <td><span class="badge" :class="o.status">{{ STATUS_LABEL[o.status] ?? o.status }}</span></td>
          <td>{{ formatDateTime(o.createTime) }}</td>
          <td class="actions">
            <button class="btn small secondary" :disabled="busy" @click="detailForm = o">详情</button>
            <button v-if="(o.status === 'paid' || o.status === 'fulfilled') && o.purpose !== 'topup'" class="btn small danger" :disabled="busy" @click="openRefund(o)">退款</button>
          </td>
        </tr>
        <tr v-if="orders.length === 0"><td colspan="7" class="muted">无匹配订单。</td></tr>
      </tbody>
    </table>

    <p v-if="nextCursor" class="load-more"><button class="btn secondary" @click="load(false)">加载更多</button></p>

    <Modal v-if="detailForm" :title="`订单详情 · ${detailForm.orderNo}`" :closable="!busy" @close="detailForm = null">
      <table class="kv">
        <tbody>
          <tr><th>订单号</th><td class="mono">{{ detailForm.orderNo }}</td></tr>
          <tr><th>用户</th><td>{{ detailForm.userEmail ?? '—' }}<span class="muted">（ID {{ detailForm.userId }}，{{ detailForm.userDisplayName ?? '未设置昵称' }}）</span></td></tr>
          <tr><th>商品</th><td>{{ purposeLabel(detailForm.purpose) }} · {{ detailForm.planCode ?? detailForm.skuCode ?? '—' }}</td></tr>
          <tr><th>金额</th><td>¥{{ fmtCents(detailForm.amountCents) }}</td></tr>
          <tr><th>支付渠道</th><td>{{ channelLabel(detailForm.channel) }}<span v-if="detailForm.channelTradeNo" class="muted"> · 渠道单号 {{ detailForm.channelTradeNo }}</span></td></tr>
          <tr><th>状态</th><td><span class="badge" :class="detailForm.status">{{ STATUS_LABEL[detailForm.status] ?? detailForm.status }}</span></td></tr>
          <tr><th>创建时间</th><td>{{ formatDateTime(detailForm.createTime) }}</td></tr>
          <tr><th>过期时间</th><td>{{ formatDateTime(detailForm.expiresTime) }}</td></tr>
          <tr><th>支付时间</th><td>{{ formatDateTime(detailForm.paidTime) }}</td></tr>
        </tbody>
      </table>
      <p class="muted" v-if="detailForm.purpose === 'topup'">积分充值订单的入账/退款请到「AI 积分 → 订单」页操作。</p>
      <div class="modal-actions">
        <button class="btn secondary" :disabled="busy" @click="detailForm = null">关闭</button>
      </div>
    </Modal>

    <Modal v-if="refundForm" title="退款登记" :closable="!busy" @close="closeRefund">
      <p class="muted">{{ refundForm.orderNo }} · ¥{{ fmtCents(refundForm.amountCents) }}</p>
      <FormField label="退款原因" required hint="必填，会记录到审计日志。">
        <input v-model="refundReason" type="text" maxlength="500" placeholder="例如：用户误购，客服处理" />
      </FormField>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn danger" :disabled="busy" @click="confirmRefund">确认退款</button>
        <button class="btn secondary" :disabled="busy" @click="closeRefund">取消</button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.user-link { color: var(--c-accent); text-decoration: none; }
.user-link:hover { text-decoration: underline; }
.range { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text-muted); }
.kv { border-collapse: collapse; }
.kv th { width: 100px; text-align: left; padding: 8px 12px; color: var(--c-text-muted); font-weight: 500; font-size: 13px; vertical-align: top; white-space: nowrap; }
.kv td { padding: 8px 12px; font-size: 13.5px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
.badge.pending { background: var(--c-warn-bg); color: var(--c-warn-text); }
.badge.paid { background: var(--c-accent-bg); color: var(--c-accent); }
.badge.fulfilled { background: var(--c-success-bg); color: var(--c-success-text); }
.badge.failed, .badge.expired, .badge.refunded { background: var(--c-danger-bg); color: var(--c-danger); }
</style>