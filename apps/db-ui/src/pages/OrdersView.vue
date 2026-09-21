<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { withBase } from '../lib/router';
import { listOrders, type ConsoleOrder } from '../api/orders';
import { setAccessToken } from '@devbelt/auth-client';
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
/** 展示状态：pending 但已过本地有效期 → 视为 expired（避免「待支付」与「已过期」同屏矛盾）。 */
function displayStatus(o: ConsoleOrder): string {
  return o.status === 'pending' && remainingMs(o) <= 0 ? 'expired' : o.status;
}
/** 可重新下单：已过期（含 pending 超时与 sweep 后 expired）或支付失败。 */
function canReorder(o: ConsoleOrder): boolean {
  const s = displayStatus(o);
  return s === 'expired' || s === 'failed';
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
  statusFilter.value ? orders.value.filter((o) => displayStatus(o) === statusFilter.value) : orders.value,
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
    <header class="head">
      <h2>订单</h2>
      <p class="sub">查看历史订单与支付状态。</p>
    </header>

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
            <span class="badge" :class="displayStatus(o)">{{ STATUS_LABEL[displayStatus(o)] ?? displayStatus(o) }}</span>
          </span>
          <span class="muted">¥{{ fmtCents(o.amountCents) }} · {{ channelLabel(o.channel) }} · {{ formatDateTime(o.createTime) }}</span>
          <span v-if="displayStatus(o) === 'pending'" class="muted">
            剩余 {{ formatRemaining(remainingMs(o)) }}
          </span>
        </button>
        <div v-if="canReorder(o)" class="reorder">
          <a class="btn small" :href="withBase('/checkout')">重新下单</a>
        </div>
        <div v-if="expandedOrderNo === o.orderNo" class="detail">
          <dl>
            <dt>订单号</dt><dd>{{ o.orderNo }}</dd>
            <dt>状态</dt><dd>{{ STATUS_LABEL[displayStatus(o)] ?? displayStatus(o) }}</dd>
            <dt>金额</dt><dd>¥{{ fmtCents(o.amountCents) }}</dd>
            <dt>渠道</dt><dd>{{ channelLabel(o.channel) }}</dd>
            <dt>创建时间</dt><dd>{{ formatDateTime(o.createTime) }}</dd>
            <dt>过期时间</dt><dd>{{ formatDateTime(o.expiresTime) }}</dd>
            <dt v-if="displayStatus(o) === 'pending'">有效期</dt>
            <dd v-if="displayStatus(o) === 'pending'">剩余 {{ formatRemaining(remainingMs(o)) }}</dd>
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
.page { max-width: 720px; margin: 0 auto; }
.head { margin-bottom: 16px; }
.head h2 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--c-text-muted); }
.bar { display: flex; gap: 8px; margin: 0 0 16px; }
.bar select { max-width: 180px; }
.item { transition: border-color .15s; }
.item:hover { border-color: var(--c-border-strong); }
.reorder .btn { background: var(--c-surface-muted); color: var(--c-text); border: 1px solid var(--c-border-strong); font-weight: 500; }
.load-more .btn { background: var(--c-surface-muted); color: var(--c-text); border: 1px solid var(--c-border-strong); font-weight: 500; }
select { box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--c-border-strong); border-radius: 6px; font-size: 14px; }
.list { list-style: none; padding: 0; margin: 16px 0 0; }
.item { background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
.row { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; background: none; border: none; padding: 14px 16px; cursor: pointer; }
.row:hover { background: var(--c-surface-muted); }
.meta { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 600; }
.badge.pending { background: var(--c-warn-bg); color: var(--c-warn-text); }
.badge.paid { background: var(--c-accent-bg); color: var(--c-accent); }
.badge.fulfilled { background: #dafbe1; color: var(--c-success-text); }
.badge.failed, .badge.expired, .badge.refunded { background: #ffebe9; color: var(--c-danger); }
.detail { border-top: 1px solid #eaeef2; padding: 12px 16px; }
.detail dl { margin: 0; display: grid; grid-template-columns: 92px 1fr; gap: 6px 12px; }
.detail dt { color: var(--c-text-muted); font-size: 13px; }
.detail dd { margin: 0; font-size: 13px; color: var(--c-text); word-break: break-all; }
.reorder { padding: 0 16px 12px; }
.btn.small { display: inline-block; padding: 4px 12px; font-size: 13px; text-decoration: none; }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
.load-more { margin: 16px 0; }
.btn.secondary { background: var(--c-surface-muted); color: var(--c-text); border: 1px solid var(--c-border-strong); padding: 8px 14px; border-radius: 6px; cursor: pointer; }
</style>