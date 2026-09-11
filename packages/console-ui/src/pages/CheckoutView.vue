<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { ensureCsrf } from '../api/consoleAuth';
import { createOrder, getOrder, type PayParams } from '../api/orders';
import QRCode from 'qrcode';

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

let pollTimer: number | undefined;

function stopPolling(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

onUnmounted(stopPolling);

const alreadyPro = props.subscription?.planCode === 'pro';

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  error.value = '';
  payParams.value = null;
  qrDataUrl.value = null;
  orderNo.value = null;
  pollStatus.value = null;
  try {
    const csrf = await ensureCsrf();
    const r = await createOrder('pro', channel.value, csrf);
    if (r.kind !== 'ok') {
      if (r.kind === 'unauthorized') {
        window.location.assign('/login');
        return;
      }
      error.value = '下单失败，请重试。';
      return;
    }
    payParams.value = r.value.payParams;
    orderNo.value = r.value.order.orderNo;
    if (r.value.payParams.redirectUrl) {
      // 支付宝电脑网站支付：跳到支付宝收银台（页面内含二维码，可扫码或登录账户付）。
      window.location.href = r.value.payParams.redirectUrl;
      startPolling(r.value.order.orderNo);
    } else if (r.value.payParams.codeUrl) {
      // 微信 native：code_url 渲染为扫码二维码，就地扫码支付。
      qrDataUrl.value = await QRCode.toDataURL(r.value.payParams.codeUrl);
      startPolling(r.value.order.orderNo);
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
function startPolling(no: string): void {
  pollStatus.value = 'pending';
  pollTimer = window.setInterval(async () => {
    const r = await getOrder(no);
    if (r.kind !== 'ok') return;
    const status = r.value.status;
    pollStatus.value = status;
    if (status === 'paid' || status === 'fulfilled') {
      stopPolling();
      window.setTimeout(() => window.location.assign('/console/account'), 1500);
    }
  }, 3000);
}
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
      <p class="row" v-if="subscription?.periodEndTime">到期时间：{{ new Date(subscription.periodEndTime).toLocaleString() }}</p>
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
      <button class="btn" :disabled="submitting" @click="submit">{{ submitting ? '下单中…' : '下单支付' }}</button>
    </div>

    <div class="card" v-if="alreadyPro">
      <p class="ok">你已是 Pro 用户。</p>
      <a class="btn link" href="/console/orders">查看订单</a>
    </div>

    <div class="card" v-if="qrDataUrl">
      <h3>微信扫码支付</h3>
      <p class="muted">请用微信「扫一扫」扫码完成支付。下单后 30 分钟内有效。</p>
      <img class="qr" :src="qrDataUrl" alt="支付二维码" />
      <p class="muted">订单号：{{ orderNo }}</p>
      <p v-if="pollStatus" class="muted">状态：{{ pollStatus }}</p>
    </div>

    <div class="card" v-if="payParams?.redirectUrl && !qrDataUrl">
      <h3>支付宝支付</h3>
      <p class="muted">已打开支付宝收银台。若未跳转，<a :href="payParams.redirectUrl">点此前往</a>。</p>
      <p class="muted">订单号：{{ orderNo }} · 状态：{{ pollStatus }}</p>
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
.qr { width: 220px; height: 220px; border: 1px solid #d0d7de; border-radius: 8px; }
.error { color: #cf222e; font-size: 13px; }
.ok { color: #1a7f37; font-size: 13px; }
.muted { color: #57606a; font-size: 13px; }
</style>