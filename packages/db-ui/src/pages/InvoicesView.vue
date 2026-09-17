<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase } from '../lib/router';
import { listInvoices, requestInvoice, type InvoiceRecord } from '../api/invoices';
import { listOrders, type ConsoleOrder } from '../api/orders';
import { ensureCsrf, setAccessToken } from '../api/consoleAuth';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';

const invoices = ref<InvoiceRecord[]>([]);
const orders = ref<ConsoleOrder[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');

const orderNo = ref('');
const title = ref('');
const taxNo = ref('');
const email = ref('');
const requesting = ref(false);

const requestWrite = useIdempotencyKey();

const STATUS_LABEL: Record<string, string> = { requested: '已申请', issued: '已开具', rejected: '已驳回', failed: '失败' };

function fmtCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

async function load(): Promise<void> {
  state.value = 'loading';
  const [invs, ords] = await Promise.all([listInvoices(), listOrders()]);
  if (invs.kind === 'unauthorized' || ords.kind === 'unauthorized') {
    setAccessToken(null);
    window.location.assign(withBase('/login'));
    return;
  }
  invoices.value = invs.kind === 'ok' ? invs.value.items : [];
  orders.value = ords.kind === 'ok' ? ords.value.items.filter((o) => o.status === 'fulfilled') : [];
  state.value = 'ready';
}

onMounted(load);

async function request(): Promise<void> {
  if (requesting.value || !orderNo.value || !title.value.trim() || !email.value.trim()) return;
  requesting.value = true;
  error.value = '';
  try {
    const tag = `invoice:${orderNo.value}`;
    const csrf = await ensureCsrf();
    const r = await requestInvoice(orderNo.value, title.value.trim(), email.value.trim(), taxNo.value.trim(), requestWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      requestWrite.reset(tag);
      await load();
    } else if (r.kind === 'unauthorized') {
      requestWrite.reset(tag);
      setAccessToken(null);
      window.location.assign(withBase('/login'));
    } else if (isRetryableFailure(r.kind)) {
      error.value = '申请失败，请重试。';
    } else {
      requestWrite.reset(tag);
      error.value = '申请失败：请确认订单已生效。';
    }
  } finally {
    requesting.value = false;
  }
}
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>发票</h2>
      <p class="sub">申请与查看发票。</p>
    </header>

    <div class="card">
      <h3>申请发票</h3>
      <label>已生效订单</label>
      <select v-model="orderNo">
        <option value="" disabled>选择订单</option>
        <option v-for="o in orders" :key="o.orderNo" :value="o.orderNo">
          {{ o.planCode === 'pro' ? 'Pro' : o.planCode }} · ¥{{ fmtCents(o.amountCents) }}
        </option>
      </select>
      <label>发票抬头</label>
      <input v-model="title" type="text" maxlength="200" placeholder="公司或个人名称" />
      <label>税号（选填）</label>
      <input v-model="taxNo" type="text" maxlength="64" placeholder="统一社会信用代码" />
      <label>接收邮箱</label>
      <input v-model="email" type="email" maxlength="255" placeholder="receipt@example.com" />
      <p v-if="error" class="error">{{ error }}</p>
      <button class="btn" :disabled="requesting" @click="request">{{ requesting ? '提交中…' : '申请开票' }}</button>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败，请刷新重试。</p>

    <ul v-if="state === 'ready'" class="list">
      <li v-for="i in invoices" :key="i.invoiceId" class="item">
        <div class="meta">
          <strong>{{ i.title }}</strong>
          <span class="badge">{{ STATUS_LABEL[i.status] ?? i.status }}</span>
        </div>
        <div class="muted">¥{{ fmtCents(i.amountCents) }} · {{ i.email }}<span v-if="i.taxNo"> · {{ i.taxNo }}</span></div>
        <div v-if="(i.status === 'rejected' || i.status === 'failed') && i.reason" class="muted">原因：{{ i.reason }}</div>
      </li>
      <li v-if="invoices.length === 0" class="muted">暂无发票申请。</li>
    </ul>
  </section>
</template>

<style scoped>
.page { max-width: 720px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: var(--c-text); }
.card { background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
h3 { font-size: 15px; font-weight: 600; color: var(--c-text); margin: 0 0 12px; }
label { display: block; font-size: 13px; color: var(--c-text-muted); margin: 12px 0 4px; }
input, select { width: 100%; box-sizing: border-box; padding: 9px 12px; border: 1px solid var(--c-border-strong); border-radius: 6px; font-size: 14px; }
.btn { margin-top: 16px; background: var(--c-accent); color: var(--c-surface); border: none; padding: 9px 16px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.list { list-style: none; padding: 0; margin: 0; }
.item { background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; }
.meta { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 600; background: var(--c-accent-bg); color: var(--c-accent); }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
.head { margin-bottom: 16px; }
.head h2 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--c-text-muted); }
</style>