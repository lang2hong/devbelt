<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { listAdminOrders, type AdminOrder } from '../api/admin';
import { setAccessToken } from '../api/consoleAuth';
import AdminNav from './AdminNav.vue';

const orders = ref<AdminOrder[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const userId = ref('');
const status = ref('');
const channel = ref('');
const planCode = ref('');
const nextCursor = ref<string | null>(null);

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

function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function channelLabel(ch: string): string {
  return ch === 'wechat' ? '微信' : '支付宝';
}

async function load(reset = true): Promise<void> {
  state.value = 'loading';
  const r = await listAdminOrders({
    userId: userId.value || undefined,
    status: status.value || undefined,
    channel: channel.value || undefined,
    planCode: planCode.value || undefined,
    cursor: reset ? undefined : (nextCursor.value ?? undefined),
  });
  if (r.kind === 'ok') {
    orders.value = reset ? r.value.items : [...orders.value, ...r.value.items];
    nextCursor.value = r.value.nextCursor;
    state.value = 'ready';
  } else if (r.kind === 'unauthorized') relogin();
  else state.value = 'error';
}

onMounted(() => load());

function search(): void {
  orders.value = [];
  nextCursor.value = null;
  void load(true);
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
    <p class="error" v-if="state === 'error'">加载失败。</p>

    <table v-if="state === 'ready'" class="table">
      <thead>
        <tr><th>订单号</th><th>用户ID</th><th>套餐</th><th>金额</th><th>渠道</th><th>状态</th><th>渠道单号</th><th>创建时间</th><th>过期时间</th><th>支付时间</th></tr>
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
          <td>{{ fmtTime(o.createTime) }}</td>
          <td>{{ fmtTime(o.expiresTime) }}</td>
          <td>{{ fmtTime(o.paidTime) }}</td>
        </tr>
        <tr v-if="orders.length === 0"><td colspan="10" class="muted">无匹配订单。</td></tr>
      </tbody>
    </table>

    <p v-if="nextCursor" class="load-more"><button class="btn secondary" @click="load(false)">加载更多</button></p>
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
.muted { color: #57606a; font-size: 13px; }
.error { color: #cf222e; font-size: 13px; }
.load-more { margin: 16px 0; }
</style>