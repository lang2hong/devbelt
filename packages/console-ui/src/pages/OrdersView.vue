<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { listOrders, type ConsoleOrder } from '../api/orders';
import { setAccessToken } from '../api/consoleAuth';

const orders = ref<ConsoleOrder[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');

const STATUS_LABEL: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  fulfilled: '已生效',
  failed: '支付失败',
  refunded: '已退款',
  expired: '已过期',
};

function fmtCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

async function load(): Promise<void> {
  state.value = 'loading';
  const r = await listOrders();
  if (r.kind === 'ok') {
    orders.value = r.value.items;
    state.value = 'ready';
  } else if (r.kind === 'unauthorized') {
    setAccessToken(null);
    window.location.assign('/login');
  } else {
    state.value = 'error';
  }
}

onMounted(load);
</script>

<template>
  <section class="page">
    <h2>订单</h2>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败，请刷新重试。</p>

    <ul v-if="state === 'ready'" class="list">
      <li v-for="o in orders" :key="o.orderNo" class="item">
        <div class="meta">
          <strong>{{ o.planCode === 'pro' ? 'Pro' : o.planCode }}</strong>
          <span class="badge" :class="o.status">{{ STATUS_LABEL[o.status] ?? o.status }}</span>
        </div>
        <div class="muted">
          ¥{{ fmtCents(o.amountCents) }} · {{ o.channel === 'wechat' ? '微信' : '支付宝' }}
          · {{ new Date(o.createTime).toLocaleString() }}
        </div>
        <div class="muted" v-if="o.paidTime">支付于 {{ new Date(o.paidTime).toLocaleString() }}</div>
      </li>
      <li v-if="orders.length === 0" class="muted">暂无订单。</li>
    </ul>
  </section>
</template>

<style scoped>
.page { max-width: 620px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; }
.list { list-style: none; padding: 0; margin: 16px 0 0; }
.item { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; }
.meta { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 600; }
.badge.pending { background: #fff8c5; color: #9a6700; }
.badge.paid { background: #ddf4ff; color: #0969da; }
.badge.fulfilled { background: #dafbe1; color: #1a7f37; }
.badge.failed, .badge.expired, .badge.refunded { background: #ffebe9; color: #cf222e; }
.muted { color: #57606a; font-size: 13px; }
.error { color: #cf222e; font-size: 13px; }
</style>