<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { listOrders, type ConsoleOrder } from '../api/orders';
import { setAccessToken } from '../api/consoleAuth';
import { formatDateTime } from '../lib/formatTime';
import { formatRemaining, useNow } from '../lib/useNow';

const orders = ref<ConsoleOrder[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const loadError = ref('');
const statusFilter = ref('');
const nextCursor = ref<string | null>(null);
const expandedOrderNo = ref<string | null>(null);
const now = useNow();

/** pending 订单剩余毫秒（<=0 即已过本地有效期）。 */
function remainingMs(o: ConsoleOrder): number {
  return new Date(o.expiresTime).getTime() - now.value;
}
function isPayable(o: ConsoleOrder): boolean {
  return o.status === 'pending' && remainingMs(o) > 0;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  fulfilled: '已生效',
  failed: '支付失败',
  refunded: '已退款',
  expired: '已过期',
};

const STATUS_OPTIONS = ['pending', 'paid', 'fulfilled', 'failed', 'refunded', 'expired'];

const visible = computed<ConsoleOrder[]>(() =>
  statusFilter.value ? orders.value.filter((o) => o.status === statusFilter.value) : orders.value,
);

function fmtCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function channelLabel(ch: string): string {
  return ch === 'wechat' ? '微信' : '支付宝';
}

function toggle(o: ConsoleOrder): void {
  expandedOrderNo.value = expandedOrderNo.value === o.orderNo ? null : o.orderNo;
}

async function load(reset = true): Promise<void> {
  state.value = 'loading';
  loadError.value = '';
  const r = await listOrders(reset ? undefined : (nextCursor.value ?? undefined));
  if (r.kind === 'ok') {
    orders.value = reset ? r.value.items : [...orders.value, ...r.value.items];
    nextCursor.value = r.value.nextCursor;
    state.value = 'ready';
  } else if (r.kind === 'unauthorized') {
    setAccessToken(null);
    window.location.assign('/login');
  } else {
    state.value = 'error';
    loadError.value = r.kind === 'failure' ? (r.message || r.code || '加载失败，请刷新重试。') : '加载失败，请刷新重试。';
  }
}

onMounted(() => load());
</script>

<template>
  <section class="page">
    <h2>订单</h2>

    <div class="bar">
      <select v-model="statusFilter">
        <option value="">全部状态</option>
        <option v-for="s in STATUS_OPTIONS" :key="s" :value="s">{{ STATUS_LABEL[s] }}</option>
      </select>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">{{ loadError || '加载失败，请刷新重试。' }}</p>

    <ul v-if="state === 'ready'" class="list">
      <li v-for="o in visible" :key="o.orderNo" class="item">
        <button class="row" :aria-expanded="expandedOrderNo === o.orderNo" @click="toggle(o)">
          <span class="meta">
            <strong>{{ o.planCode === 'pro' ? 'Pro' : o.planCode }}</strong>
            <span class="badge" :class="o.status">{{ STATUS_LABEL[o.status] ?? o.status }}</span>
          </span>
          <span class="muted">¥{{ fmtCents(o.amountCents) }} · {{ channelLabel(o.channel) }} · {{ formatDateTime(o.createTime) }}</span>
          <span v-if="o.status === 'pending'" class="muted">
            {{ isPayable(o) ? '剩余 ' + formatRemaining(remainingMs(o)) : '已过期，可重新下单' }}
          </span>
        </button>
        <div v-if="expandedOrderNo === o.orderNo" class="detail">
          <dl>
            <dt>订单号</dt><dd>{{ o.orderNo }}</dd>
            <dt>状态</dt><dd>{{ STATUS_LABEL[o.status] ?? o.status }}</dd>
            <dt>金额</dt><dd>¥{{ fmtCents(o.amountCents) }}</dd>
            <dt>渠道</dt><dd>{{ channelLabel(o.channel) }}</dd>
            <dt>创建时间</dt><dd>{{ formatDateTime(o.createTime) }}</dd>
            <dt>过期时间</dt><dd>{{ formatDateTime(o.expiresTime) }}</dd>
            <dt v-if="o.status === 'pending'">有效期</dt>
            <dd v-if="o.status === 'pending'">
              {{ isPayable(o) ? '剩余 ' + formatRemaining(remainingMs(o)) : '已过期' }}
              <a v-if="!isPayable(o)" class="relink" href="/console/checkout">重新下单</a>
            </dd>
            <dt>支付时间</dt><dd>{{ o.paidTime ? formatDateTime(o.paidTime) : '—' }}</dd>
          </dl>
        </div>
      </li>
      <li v-if="visible.length === 0" class="muted">暂无订单。</li>
    </ul>

    <p v-if="nextCursor" class="load-more"><button class="btn secondary" @click="load(false)">加载更多</button></p>
  </section>
</template>

<style scoped>
.page { max-width: 620px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; }
.bar { display: flex; gap: 8px; margin: 16px 0; }
select { box-sizing: border-box; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
.list { list-style: none; padding: 0; margin: 16px 0 0; }
.item { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
.row { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; background: none; border: none; padding: 14px 16px; cursor: pointer; }
.row:hover { background: #f6f8fa; }
.meta { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 600; }
.badge.pending { background: #fff8c5; color: #9a6700; }
.badge.paid { background: #ddf4ff; color: #0969da; }
.badge.fulfilled { background: #dafbe1; color: #1a7f37; }
.badge.failed, .badge.expired, .badge.refunded { background: #ffebe9; color: #cf222e; }
.detail { border-top: 1px solid #eaeef2; padding: 12px 16px; }
.detail dl { margin: 0; display: grid; grid-template-columns: 92px 1fr; gap: 6px 12px; }
.detail dt { color: #57606a; font-size: 13px; }
.detail dd { margin: 0; font-size: 13px; color: #24292f; word-break: break-all; }
.relink { color: #0969da; margin-left: 6px; }
.muted { color: #57606a; font-size: 13px; }
.error { color: #cf222e; font-size: 13px; }
.load-more { margin: 16px 0; }
.btn.secondary { background: #f6f8fa; color: #24292f; border: 1px solid #d0d7de; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
</style>