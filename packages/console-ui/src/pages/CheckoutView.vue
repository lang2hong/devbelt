<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ensureCsrf } from '../api/consoleAuth';
import { createOrder, getOrder, type PayParams } from '../api/orders';
import QRCode from 'qrcode';
import { formatDateTime } from '../lib/formatTime';
import { formatRemaining, useNow } from '../lib/useNow';

/** 个人订阅快照（与 AccountView 同口径）。 */
interface Subscription {
  planCode: string | null;
  status: string;
  periodEndTime: string | null;
}

const props = defineProps<{ user: { email: string | null } | null; subscription: Subscription | null }>();

const channel = ref<'alipay' | 'wechat'>('alipay');
const submitting = ref(false);
const error = ref('');
const orderNo = ref<string | null>(null);
const payParams = ref<PayParams | null>(null);
const qrDataUrl = ref<string | null>(null);
const pollStatus = ref<string | null>(null);
const pollTimedOut = ref(false);
const manualBusy = ref(false);
const now = useNow();
/** 当前订单的本地有效期（epoch ms）；用于倒计时与过期提示。 */
const orderExpires = ref<number | null>(null);

const orderRemaining = computed<number | null>(() =>
  orderExpires.value === null ? null : orderExpires.value - now.value,
);
const orderExpired = computed<boolean>(() => orderRemaining.value !== null && orderRemaining.value <= 0);

const POLL_MSG: Record<string, string> = {
  pending: '待支付',
  paid: '已支付，权益生效中…',
  fulfilled: '已生效',
  failed: '支付失败',
  refunded: '已退款',
  expired: '已过期',
};

/** 轮询上限：40 × 3s = 2 分钟，超时停摆提示用户手动确认。 */
const POLL_MAX_TICKS = 40;

/**
 * 未完成订单号仅存非敏感标识，写入 sessionStorage 以便支付宝跳转（同标签页导航）
 * 或页面刷新后恢复支付状态；不落 localStorage、不持久化含签名/令牌的支付参数。
 */
const PENDING_ORDER_KEY = 'dbclient.console.pendingOrder';

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

/** 跳转支付宝/微信支付前记录订单号；订单一进入终态即由 clearPendingOrder 清空。 */
const TERMINAL_STATUSES = new Set(['paid', 'fulfilled', 'failed', 'expired', 'refunded']);

let pollTimer: number | undefined;
let pollTicks = 0;
let generation = 0;
let mounted = false;
let pendingJump: number | undefined;
// 订单状态查询的递增序号：每次 getOrder（轮询回调 / 手动刷新）发出前 +1，返回后比对。
// 慢的旧响应即便在终态/停止轮询之后才回来，也因序号过期而被丢弃，不会覆盖更新的状态。
let pollReqSeq = 0;

function stopPolling(): void {
  pollReqSeq += 1;
  if (pollTimer !== undefined) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

function clearPendingJump(): void {
  if (pendingJump !== undefined) {
    clearTimeout(pendingJump);
    pendingJump = undefined;
  }
}

function scheduleJump(delay: number): void {
  clearPendingJump();
  pendingJump = window.setTimeout(() => {
    pendingJump = undefined;
    window.location.assign('/console/account');
  }, delay);
}

function statusLabel(s: string | null): string {
  return s ? (POLL_MSG[s] ?? s) : '';
}

onUnmounted(() => {
  mounted = false;
  stopPolling();
  clearPendingJump();
});

const alreadyPro = props.subscription?.planCode === 'pro';

async function submit(mode?: 'qr' | 'redirect'): Promise<void> {
  if (submitting.value) return;
  // 微信仅扫码；支付宝支持扫码/跳转（未指定时默认跳转）。
  // 只接受显式枚举值：避免 DOM 事件等非字符串实参被当成 mode 透传（服务端 enum 会 422）。
  const requested: 'qr' | 'redirect' = mode === 'qr' || mode === 'redirect' ? mode : 'redirect';
  const payMode: 'qr' | 'redirect' = channel.value === 'wechat' ? 'qr' : requested;
  submitting.value = true;
  error.value = '';
  stopPolling();
  clearPendingJump();
  payParams.value = null;
  qrDataUrl.value = null;
  orderNo.value = null;
  pollStatus.value = null;
  pollTimedOut.value = false;
  // 提交即失效上一代（含仍挂起的 getOrder 请求），而不是等 createOrder 成功后才失效：
  // 否则旧订单的迟到响应会在新提交尚未落地前，把新一代的 pendingOrder/跳转状态覆盖掉。
  generation += 1;
  const gen = generation;
  try {
    const csrf = await ensureCsrf();
    const r = await createOrder('pro', channel.value, csrf, payMode);
    if (!mounted || gen !== generation) return;
    if (r.kind !== 'ok') {
      if (r.kind === 'unauthorized') {
        window.location.assign('/login');
        return;
      }
      error.value = r.kind === 'failure' ? (r.message || r.code || '下单失败，请重试。') : '下单失败，请重试。';
      return;
    }
    const newOrderNo = r.value.order.orderNo;
    payParams.value = r.value.payParams;
    orderNo.value = newOrderNo;
    orderExpires.value = new Date(r.value.order.expiresTime).getTime();
    writePendingOrder(newOrderNo);
    if (r.value.payParams.redirectUrl) {
      // 支付宝电脑网站支付：跳到支付宝收银台（页面内含二维码，可扫码或登录账户付）。
      window.location.href = r.value.payParams.redirectUrl;
      startPolling(newOrderNo, gen);
    } else if (r.value.payParams.codeUrl) {
      // 微信 native：code_url 渲染为扫码二维码，就地扫码支付。
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

/** 轮询订单直到 paid/fulfilled，成功后回跳账户页（订阅已生效）。 */
function startPolling(no: string, gen: number): void {
  stopPolling();
  pollStatus.value = 'pending';
  pollTimedOut.value = false;
  pollTicks = 0;
  // 串行 single-flight：一次 getOrder 完成后再按 3s 间隔排下一轮，避免网络慢于轮询间隔时
  // 并发堆积请求、且每个慢响应都被下一轮递增的 pollReqSeq 判为过期而被全部丢弃（空转死循环）。
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
    if (status === 'paid' || status === 'fulfilled') {
      stopPolling();
      clearPendingOrder();
      scheduleJump(1500);
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

/** 用户从支付渠道返回后手动确认（兜底：跳走/断网后轮询可能丢失）。 */
async function manualCheck(): Promise<void> {
  if (!orderNo.value || manualBusy.value) return;
  manualBusy.value = true;
  const no = orderNo.value;
  const gen = generation;
  const req = ++pollReqSeq;
  try {
    const r = await getOrder(no);
    if (!mounted || gen !== generation || req !== pollReqSeq) return;
    if (r.kind === 'ok') {
      pollStatus.value = r.value.status;
      const status = r.value.status;
      if (status === 'paid' || status === 'fulfilled') {
        stopPolling();
        clearPendingOrder();
        scheduleJump(800);
      } else if (TERMINAL_STATUSES.has(status)) {
        stopPolling();
        clearPendingOrder();
      } else {
        pollTimedOut.value = false;
        startPolling(no, gen);
      }
    }
  } finally {
    manualBusy.value = false;
  }
}

/** 从支付渠道返回 / 刷新页面后，恢复未完成订单的支付状态。 */
onMounted(async () => {
  mounted = true;
  const no = readPendingOrder();
  if (!no) return;
  orderNo.value = no;
  pollStatus.value = 'pending';
  generation += 1;
  const gen = generation;
  const r = await getOrder(no);
  if (!mounted || gen !== generation) return;
  if (r.kind !== 'ok') {
    // 查询失败不宜清空订单号（可能是网络波动），保留待支付状态供手动重查。
    return;
  }
  pollStatus.value = r.value.status;
  orderExpires.value = new Date(r.value.expiresTime).getTime();
  if (r.value.status === 'paid' || r.value.status === 'fulfilled') {
    clearPendingOrder();
    scheduleJump(1500);
    return;
  }
  if (TERMINAL_STATUSES.has(r.value.status)) {
    clearPendingOrder();
    return;
  }
  startPolling(no, gen);
});
</script>

<template>
  <section class="page">
    <h2>升级订阅</h2>

    <div class="card">
      <h3>当前套餐</h3>
      <p class="row">
        当前：<strong>{{ alreadyPro ? 'Pro' : (subscription?.planCode || 'Free') }}</strong>
        <span class="muted" v-if="subscription">（{{ subscription.status === 'active' ? '生效中' : subscription.status }}）</span>
      </p>
      <p class="row" v-if="subscription?.periodEndTime">到期时间：{{ formatDateTime(subscription.periodEndTime) }}</p>
    </div>

    <div class="card" v-if="!alreadyPro">
      <h3>Pro 套餐 <span class="muted">¥99 / 月</span></h3>
      <p class="muted">解锁全部数据库类型、更多设备位与更大同步空间。</p>

      <label>支付方式</label>
      <div class="channels">
        <label class="radio"><input type="radio" value="alipay" v-model="channel" /> 支付宝</label>
        <label class="radio"><input type="radio" value="wechat" v-model="channel" /> 微信支付</label>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <template v-if="channel === 'alipay'">
        <button class="btn" :disabled="submitting" @click="submit('qr')">{{ submitting ? '下单中…' : '扫码支付' }}</button>
        <button class="btn secondary" :disabled="submitting" @click="submit('redirect')">{{ submitting ? '下单中…' : '跳转到支付宝' }}</button>
      </template>
      <button v-else class="btn" :disabled="submitting" @click="submit('qr')">{{ submitting ? '下单中…' : '下单支付' }}</button>
    </div>

    <div class="card" v-if="alreadyPro">
      <p class="ok">你已是 Pro 用户。</p>
      <a class="btn link" href="/console/orders">查看订单</a>
    </div>

    <div class="card" v-if="qrDataUrl && !orderExpired">
      <h3>{{ channel === 'alipay' ? '支付宝扫码支付' : '微信扫码支付' }}</h3>
      <p class="muted">请用{{ channel === 'alipay' ? '支付宝' : '微信' }}「扫一扫」扫码完成支付。</p>
      <p class="muted">剩余 <strong>{{ formatRemaining(orderRemaining ?? 0) }}</strong></p>
      <img class="qr" :src="qrDataUrl" alt="支付二维码" />
      <p class="muted">订单号：{{ orderNo }}</p>
    </div>

    <div class="card" v-if="payParams?.redirectUrl && !qrDataUrl && !orderExpired">
      <h3>支付宝支付</h3>
      <p class="muted">已打开支付宝收银台。若未跳转，<a :href="payParams.redirectUrl">点此前往</a>。</p>
      <p class="muted">剩余 <strong>{{ formatRemaining(orderRemaining ?? 0) }}</strong></p>
      <p class="muted">订单号：{{ orderNo }}</p>
    </div>

    <div class="card" v-if="orderNo && orderExpired">
      <h3>订单已过期</h3>
      <p class="warn">该订单超过 30 分钟未支付已失效，请重新下单。</p>
      <button class="btn" :disabled="submitting" @click="submit()">{{ submitting ? '下单中…' : '重新下单' }}</button>
      <a class="btn link" href="/console/orders">查看订单</a>
    </div>

    <div class="card" v-if="orderNo && !orderExpired">
      <h3>支付状态</h3>
      <p class="muted">当前状态：{{ statusLabel(pollStatus) || '待支付' }}</p>
      <p class="muted">剩余 <strong>{{ formatRemaining(orderRemaining ?? 0) }}</strong></p>
      <p v-if="pollTimedOut" class="warn">长时间未检测到支付，请确认是否已完成支付，或重新下单。</p>
      <button class="btn secondary" :disabled="manualBusy" @click="manualCheck">{{ manualBusy ? '查询中…' : '我已付款，刷新状态' }}</button>
      <a class="link" href="/console/orders">查看订单</a>
    </div>
  </section>
</template>

<style scoped>
.page { max-width: 620px; margin: 0 auto; }
.card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; }
h3 { font-size: 15px; font-weight: 600; color: #0f172a; margin: 0 0 12px; }
.row { margin: 8px 0; color: #24292f; }
label { display: block; font-size: 13px; color: #57606a; margin: 12px 0 4px; }
.channels { display: flex; gap: 16px; margin: 4px 0 8px; }
.radio { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; color: #24292f; }
.btn { margin-top: 16px; background: #0969da; color: #fff; border: none; padding: 9px 16px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.link { display: inline-block; text-decoration: none; }
.btn.secondary { background: #f6f8fa; color: #24292f; border: 1px solid #d0d7de; font-weight: 500; }
.qr { width: 220px; height: 220px; border: 1px solid #d0d7de; border-radius: 8px; }
.link { display: inline-block; margin-left: 12px; color: #0969da; font-size: 13px; }
.error { color: #cf222e; font-size: 13px; }
.ok { color: #1a7f37; font-size: 13px; }
.warn { color: #9a6700; font-size: 13px; }
.muted { color: #57606a; font-size: 13px; }
</style>