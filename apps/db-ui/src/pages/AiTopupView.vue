<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { withBase } from '../lib/router';
import { ensureCsrf } from '@devbelt/auth-client';
import QRCode from 'qrcode';
import { formatDateTime } from '../lib/formatTime';
import { formatRemaining, useNow } from '../lib/useNow';
import { createAiTopupOrder, listAiSkus, type AiTopupSku } from '../api/ai';
import { getOrder, type PayParams } from '../api/orders';

/**
 * AI 加油包购买页（P9.1c）：档位卡片 → 选渠道下单 → 收银台（扫码/跳转）→
 * 轮询订单状态直至入账。支付参数与订单号只暂存内存/sessionStorage（同 CheckoutView 口径）。
 */

const skus = ref<AiTopupSku[]>([]);
const skusState = ref<'loading' | 'ready' | 'error'>('loading');
const selected = ref<string | null>(null);
const channel = ref<'alipay' | 'wechat'>('alipay');
const submitting = ref(false);
const error = ref('');
const success = ref('');

const orderNo = ref<string | null>(null);
const payParams = ref<PayParams | null>(null);
const qrDataUrl = ref<string | null>(null);
const pollStatus = ref<string | null>(null);
const pollTimedOut = ref(false);
const now = useNow();
const orderExpires = ref<number | null>(null);

const orderRemaining = computed<number | null>(() =>
  orderExpires.value === null ? null : orderExpires.value - now.value,
);
const orderExpired = computed<boolean>(() => orderRemaining.value !== null && orderRemaining.value <= 0);

const POLL_MSG: Record<string, string> = {
  pending: '待支付',
  paid: '已支付，额度入账中…',
  fulfilled: '已生效（额度已入账）',
  failed: '支付失败',
  refunded: '已退款',
  expired: '已过期',
};

/** 轮询上限：40 × 3s = 2 分钟（对齐 CheckoutView）。 */
const POLL_MAX_TICKS = 40;
const PENDING_ORDER_KEY = 'devbelt.console.aiTopupPendingOrder';

const selectedSku = computed(() => skus.value.find((s) => s.code === selected.value) ?? null);

function fmtCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n.toLocaleString();
}

function readPendingOrder(): string | null {
  try {
    return sessionStorage.getItem(PENDING_ORDER_KEY) ?? null;
  } catch {
    return null;
  }
}

function writePendingOrder(no: string): void {
  try {
    sessionStorage.setItem(PENDING_ORDER_KEY, no);
  } catch {
    // 隐私/受限存储不可写时仍可依赖内存轮询，不阻断下单。
  }
}

function clearPendingOrder(): void {
  try {
    sessionStorage.removeItem(PENDING_ORDER_KEY);
  } catch {
    // ignore
  }
}

const TERMINAL_STATUSES = new Set(['paid', 'fulfilled', 'failed', 'expired', 'refunded']);

let pollTimer: number | undefined;
let pollTicks = 0;
let generation = 0;
let mounted = false;
let pollReqSeq = 0;

function stopPolling(): void {
  pollReqSeq += 1;
  if (pollTimer !== undefined) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

onMounted(async () => {
  mounted = true;
  const r = await listAiSkus();
  if (r.kind === 'ok') {
    skus.value = r.value.items;
    selected.value = r.value.items[0]?.code ?? null;
    skusState.value = 'ready';
  } else if (r.kind === 'unauthorized') {
    window.location.assign('/login');
  } else {
    skusState.value = 'error';
  }
  // 恢复未完成订单（支付宝跳转返回/刷新）。
  const pending = readPendingOrder();
  if (pending) startPolling(pending, ++generation);
});

onUnmounted(() => {
  mounted = false;
  stopPolling();
});

async function submit(mode?: 'qr' | 'redirect'): Promise<void> {
  if (submitting.value) return;
  if (!selectedSku.value) {
    error.value = '请先选择档位。';
    return;
  }
  const requested: 'qr' | 'redirect' = mode === 'qr' || mode === 'redirect' ? mode : 'redirect';
  const payMode: 'qr' | 'redirect' = channel.value === 'wechat' ? 'qr' : requested;
  submitting.value = true;
  error.value = '';
  success.value = '';
  stopPolling();
  payParams.value = null;
  qrDataUrl.value = null;
  orderNo.value = null;
  pollStatus.value = null;
  pollTimedOut.value = false;
  generation += 1;
  const gen = generation;
  try {
    const csrf = await ensureCsrf();
    const r = await createAiTopupOrder(
      { skuCode: selectedSku.value.code, channel: channel.value, mode: payMode },
      csrf,
    );
    if (!mounted || gen !== generation) return;
    if (r.kind !== 'ok') {
      if (r.kind === 'unauthorized') {
        window.location.assign('/login');
        return;
      }
      if (r.kind === 'failure') {
        error.value = r.code === 'FEATURE_TEMPORARILY_DISABLED'
          ? '支付通道暂未开放，请稍后再试。'
          : (r.message || r.code || '下单失败，请重试。');
        return;
      }
      error.value = '档位不存在或已下架，请刷新后重选。';
      return;
    }
    const newOrderNo = r.value.order.orderNo;
    payParams.value = r.value.payParams;
    orderNo.value = newOrderNo;
    orderExpires.value = new Date(r.value.order.expiresTime).getTime();
    writePendingOrder(newOrderNo);
    if (r.value.payParams.redirectUrl) {
      window.location.href = r.value.payParams.redirectUrl;
      startPolling(newOrderNo, gen);
    } else if (r.value.payParams.codeUrl) {
      qrDataUrl.value = await QRCode.toDataURL(r.value.payParams.codeUrl);
      if (!mounted || gen !== generation) return;
      startPolling(newOrderNo, gen);
    } else {
      error.value = '下单成功但未返回支付参数，请稍后在订单页查看。';
    }
  } catch {
    error.value = '下单失败，请重试。';
  } finally {
    submitting.value = false;
  }
}

/** 轮询订单直到 fulfilled（加油包入账），成功后提示并引导回账户页。 */
function startPolling(no: string, gen: number): void {
  stopPolling();
  pollStatus.value = 'pending';
  pollTimedOut.value = false;
  pollTicks = 0;
  const tick = async (): Promise<void> => {
    if (!mounted || gen !== generation) return;
    pollTicks += 1;
    const req = ++pollReqSeq;
    const r = await getOrder(no);
    if (!mounted || gen !== generation || req !== pollReqSeq) return;
    if (r.kind !== 'ok') {
      pollTimer = window.setTimeout(tick, 3000);
      return;
    }
    const status = r.value.status;
    pollStatus.value = status;
    if (status === 'fulfilled') {
      stopPolling();
      clearPendingOrder();
      success.value = '加油包已生效，额度已入账。';
      return;
    }
    if (status === 'paid') {
      // 入账瞬时窗口，继续轮询至 fulfilled。
      pollTimer = window.setTimeout(tick, 3000);
      return;
    }
    if (status === 'failed' || status === 'expired' || status === 'refunded') {
      stopPolling();
      clearPendingOrder();
      return;
    }
    if (pollTicks >= POLL_MAX_TICKS) {
      stopPolling();
      pollTimedOut.value = true;
      return;
    }
    pollTimer = window.setTimeout(tick, 3000);
  };
  pollTimer = window.setTimeout(tick, 3000);
}

async function manualCheck(): Promise<void> {
  if (!orderNo.value) return;
  const r = await getOrder(orderNo.value);
  if (r.kind !== 'ok') return;
  pollStatus.value = r.value.status;
  if (TERMINAL_STATUSES.has(r.value.status)) clearPendingOrder();
  if (r.value.status === 'fulfilled') success.value = '加油包已生效，额度已入账。';
}

function statusLabel(s: string | null): string {
  return s ? (POLL_MSG[s] ?? s) : '';
}

function goAccount(): void {
  window.location.assign(withBase('/account'));
}
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>AI 加油包</h2>
      <p class="sub">一次性额度包，购买即入账（月额度优先扣，加油包按到期先后扣）。</p>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="success" class="success">{{ success }} <a :href="withBase('/account')">查看配额</a></p>

    <p class="muted" v-if="skusState === 'loading'">加载中…</p>
    <p class="error" v-if="skusState === 'error'">档位加载失败，请刷新重试。</p>

    <div v-if="skusState === 'ready'" class="sku-grid">
      <button
        v-for="s in skus"
        :key="s.code"
        type="button"
        class="sku-card"
        :class="{ on: selected === s.code }"
        @click="selected = s.code"
      >
        <span class="sku-name">{{ s.label.zh }}</span>
        <span class="sku-tokens">{{ fmtTokens(s.tokens) }} tokens</span>
        <span class="sku-price">¥{{ fmtCents(s.priceCents) }}</span>
        <span class="sku-valid">有效期 {{ s.validDays }} 天</span>
      </button>
      <p v-if="skus.length === 0" class="muted">暂无可购档位。</p>
    </div>

    <div class="bar" v-if="skusState === 'ready'">
      <select v-model="channel">
        <option value="alipay">支付宝</option>
        <option value="wechat">微信支付</option>
      </select>
      <button class="btn accent" :disabled="submitting || !selected" @click="submit()">
        {{ submitting ? '下单中…' : `购买${selectedSku ? ` · ¥${fmtCents(selectedSku.priceCents)}` : ''}` }}
      </button>
      <span v-if="selectedSku" class="muted">支付后额度即时入账，订单可在「订单」页查看。</span>
    </div>

    <div v-if="qrDataUrl || pollStatus" class="pay-panel">
      <p class="muted" v-if="orderNo">订单号：<span class="mono">{{ orderNo }}</span></p>
      <img v-if="qrDataUrl" :src="qrDataUrl" alt="支付二维码" class="qr" />
      <p class="muted">
        {{ statusLabel(pollStatus) }}
        <template v-if="orderRemaining !== null && !orderExpired && pollStatus === 'pending'">
          （{{ formatRemaining(orderRemaining) }} 后过期）
        </template>
      </p>
      <p v-if="pollTimedOut" class="muted">轮询超时——若已完成支付请点击确认；未支付可重新下单。</p>
      <button v-if="orderNo && (pollTimedOut || pollStatus === 'pending')" class="btn secondary" @click="manualCheck">我已支付，确认状态</button>
      <p v-if="orderExpired" class="error">订单已过期，请重新下单。</p>
      <button v-if="success" class="btn secondary" @click="goAccount">返回账户页</button>
    </div>
  </section>
</template>

<style scoped>
.sku-grid { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
.sku-card {
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start;
  padding: 14px 16px; min-width: 150px;
  background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 10px;
  cursor: pointer; text-align: left;
}
.sku-card.on { border-color: var(--c-accent); box-shadow: 0 0 0 1px var(--c-accent); }
.sku-name { font-size: 14px; font-weight: 600; }
.sku-tokens { font-size: 13px; color: var(--c-text-muted); }
.sku-price { font-size: 18px; font-weight: 700; color: var(--c-accent); }
.sku-valid { font-size: 12px; color: var(--c-text-muted); }
select { padding: 8px 10px; border: 1px solid var(--c-border-strong); border-radius: 6px; font-size: 14px; }
.btn.accent { background: var(--c-accent); color: #fff; }
.pay-panel { margin: 20px 0; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.qr { width: 200px; height: 200px; border: 1px solid var(--c-border-strong); border-radius: 8px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.success { color: var(--c-success-text); font-size: 13px; }
</style>