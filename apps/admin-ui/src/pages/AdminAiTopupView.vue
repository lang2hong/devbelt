<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  createAdminAiTopupOrder,
  fulfillAdminAiTopupOrder,
  listAdminAiSkus,
  listAdminOrders,
  listUsers,
  refundAdminAiTopupOrder,
  updateAdminAiSku,
  type AdminAiTopupSku,
  type AdminOrder,
} from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { formatDateTime } from '../lib/formatTime';
import Modal from '../components/Modal.vue';
import Pager from '../components/Pager.vue';
import { useCursorPages } from '../lib/useCursorPages';
import Tabs from '../components/Tabs.vue';
import { fmtCredits } from '../lib/credits';
import { toFromIso, toInclusiveEndIso } from '../lib/dateRange';

/** AI 积分运营：充值档位管理、手工建单、充值订单入账与退款。用户余额请到用户详情页查看。 */

type TopupTab = 'skus' | 'orders';
const tab = ref<TopupTab>('skus');

const skus = ref<AdminAiTopupSku[]>([]);
const skuState = ref<'loading' | 'ready' | 'error'>('loading');
const skuError = ref('');

const busy = ref(false);
const error = ref('');
const notice = ref('');
const skuWrite = useIdempotencyKey();
const orderWrite = useIdempotencyKey();

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

function fmtCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n.toLocaleString();
}

async function loadSkus(): Promise<void> {
  skuState.value = 'loading';
  skuError.value = '';
  const r = await listAdminAiSkus();
  if (r.kind === 'ok') {
    skus.value = r.value.items;
    skuState.value = 'ready';
  } else if (r.kind === 'unauthorized') relogin();
  else {
    skuState.value = 'error';
    skuError.value = '加载失败。';
  }
}

onMounted(() => {
  void loadSkus();
  void loadOrders();
});

// ── SKU 编辑 ──

const skuForm = ref<AdminAiTopupSku | null>(null);
const skuPrice = ref('');
const skuValidDays = ref('');
const skuLabelZh = ref('');
const skuLabelEn = ref('');
const skuSort = ref('');
const skuReason = ref('');

function openSkuEdit(s: AdminAiTopupSku): void {
  skuForm.value = s;
  skuPrice.value = String(s.priceCents);
  skuValidDays.value = String(s.validDays);
  skuLabelZh.value = s.label.zh;
  skuLabelEn.value = s.label.en;
  skuSort.value = String(s.sortOrder);
  skuReason.value = '';
  error.value = '';
}

function closeSkuEdit(): void {
  if (busy.value) return;
  skuForm.value = null;
}

async function confirmSkuEdit(): Promise<void> {
  if (!skuForm.value || busy.value) return;
  const s = skuForm.value;
  const price = Math.round(Number(skuPrice.value) * 100);
  if (!Number.isSafeInteger(price) || price < 0) {
    error.value = '价格必须是非负数字（元）。';
    return;
  }
  const days = Number(skuValidDays.value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    error.value = '有效期必须是 1–3650 天。';
    return;
  }
  const labelZh = skuLabelZh.value.trim();
  const labelEn = skuLabelEn.value.trim();
  if (!labelZh || !labelEn) {
    error.value = '中英文名称均必填。';
    return;
  }
  const sortOrder = Number(skuSort.value);
  if (!Number.isSafeInteger(sortOrder)) {
    error.value = '排序必须是整数。';
    return;
  }
  const reasonValue = skuReason.value.trim();
  if (!reasonValue) {
    error.value = '请填写变更原因。';
    return;
  }
  const tag = `sku:${s.code}:${price}:${days}:${labelZh}:${labelEn}:${sortOrder}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const patch: { priceCents?: number; validDays?: number; label?: { en: string; zh: string }; sortOrder?: number } = {};
    if (price !== s.priceCents) patch.priceCents = price;
    if (days !== s.validDays) patch.validDays = days;
    if (labelZh !== s.label.zh || labelEn !== s.label.en) patch.label = { zh: labelZh, en: labelEn };
    if (sortOrder !== s.sortOrder) patch.sortOrder = sortOrder;
    const r = await updateAdminAiSku(s.code, patch, reasonValue, skuWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      skuWrite.reset(tag);
      skuForm.value = null;
      notice.value = `SKU ${s.code} 已更新。`;
      await loadSkus();
    } else if (r.kind === 'unauthorized') {
      skuWrite.reset(tag);
      relogin();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '操作失败，请重试。';
    } else {
      skuWrite.reset(tag);
      error.value = '操作失败：SKU 不存在或参数非法。';
    }
  } finally {
    busy.value = false;
  }
}

async function toggleSkuStatus(s: AdminAiTopupSku): Promise<void> {
  if (busy.value) return;
  const to = s.status === 'active' ? 'disabled' : 'active';
  const reason = to === 'disabled' ? '运营停用' : '运营启用';
  const tag = `sku-toggle:${s.code}:${to}`;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await updateAdminAiSku(s.code, { status: to }, reason, skuWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      skuWrite.reset(tag);
      notice.value = `SKU ${s.code} 已${to === 'disabled' ? '停用' : '启用'}。`;
      await loadSkus();
    } else if (r.kind === 'unauthorized') {
      skuWrite.reset(tag);
      relogin();
    } else {
      skuWrite.reset(tag);
      error.value = '操作失败，请重试。';
    }
  } finally {
    busy.value = false;
  }
}

// ── 手工建单（金额二次确认）──

/** 手工建单：输入用户邮箱或数字 ID（邮箱需先「查找」解析成 userId 才可提交）。 */
const manualForm = ref<{ userInput: string; skuCode: string; amount: string; reason: string } | null>(null);
const resolvedUser = ref<{ userId: number; email: string | null } | null>(null);
const resolving = ref(false);

function openManual(): void {
  manualForm.value = { userInput: '', skuCode: skus.value.find((s) => s.status === 'active')?.code ?? '', amount: '', reason: '' };
  resolvedUser.value = null;
  error.value = '';
}

function onUserInput(): void {
  // 输入变化即失效已解析用户，防「改了邮箱仍按旧 userId 下单」。
  resolvedUser.value = null;
}

async function resolveUser(): Promise<void> {
  if (!manualForm.value || resolving.value) return;
  const raw = manualForm.value.userInput.trim();
  resolvedUser.value = null;
  error.value = '';
  if (/^[0-9]+$/.test(raw)) {
    const uid = Number(raw);
    if (Number.isSafeInteger(uid) && uid > 0) resolvedUser.value = { userId: uid, email: null };
    else error.value = '用户 ID 必须为正整数。';
    return;
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(raw)) {
    error.value = '请输入用户邮箱或数字用户 ID。';
    return;
  }
  resolving.value = true;
  try {
    const r = await listUsers({ emailExact: raw });
    if (r.kind === 'ok') {
      if (r.value.items.length === 1) {
        resolvedUser.value = { userId: Number(r.value.items[0].userId), email: r.value.items[0].email };
      } else {
        error.value = '未找到该邮箱对应的用户，请核对后重试。';
      }
    } else if (r.kind === 'unauthorized') {
      relogin();
    } else {
      error.value = '用户查找失败，请重试。';
    }
  } finally {
    resolving.value = false;
  }
}

function closeManual(): void {
  if (busy.value) return;
  manualForm.value = null;
}

const manualSku = computed(() => skus.value.find((s) => s.code === manualForm.value?.skuCode));

async function confirmManual(): Promise<void> {
  if (!manualForm.value || busy.value) return;
  if (!resolvedUser.value) {
    error.value = '请先「查找」确认目标用户。';
    return;
  }
  const uid = resolvedUser.value.userId;
  if (!manualForm.value.skuCode) {
    error.value = '请选择档位。';
    return;
  }
  const expectedCents = Math.round(Number(manualForm.value.amount) * 100);
  if (!Number.isSafeInteger(expectedCents) || expectedCents <= 0) {
    error.value = '确认金额（元）必须是正数。';
    return;
  }
  const reasonValue = manualForm.value.reason.trim();
  if (!reasonValue) {
    error.value = '请填写建单原因。';
    return;
  }
  const tag = `manual:${uid}:${manualForm.value.skuCode}:${expectedCents}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await createAdminAiTopupOrder(
      { userId: uid, skuCode: manualForm.value.skuCode, expectedAmountCents: expectedCents, reason: reasonValue },
      orderWrite.ensure(tag),
      csrf,
    );
    if (r.kind === 'ok') {
      orderWrite.reset(tag);
      manualForm.value = null;
      notice.value = `建单成功：${r.value.order.orderNo}（已到账 ${fmtCredits(r.value.order.tokens)} 积分）。`;
      await loadOrders();
    } else if (r.kind === 'unauthorized') {
      orderWrite.reset(tag);
      relogin();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '操作失败，请重试。';
    } else {
      orderWrite.reset(tag);
      error.value = '操作失败：金额与当前价不一致（请刷新档位后重填确认金额）或档位不可用。';
    }
  } finally {
    busy.value = false;
  }
}

// ── 充值订单（purpose=topup；履行/退款）──

const orders = ref<AdminOrder[]>([]);
const orderState = ref<'loading' | 'ready' | 'error'>('loading');
const orderStatus = ref('');
const orderUserId = ref('');
const orderCreatedFrom = ref('');
const orderCreatedTo = ref('');
const orderDetail = ref<AdminOrder | null>(null);
let orderSeq = 0;
const {
  page: orderPage, pageSize: orderPageSize, total: orderTotal, hasNext: orderHasNext,
  cursor: orderCursor, reset: resetOrderPager, apply: applyOrderPage,
  next: orderNextPage, prev: orderPrevPage, setPageSize: setOrderPageSize,
} = useCursorPages();

async function loadOrders(): Promise<void> {
  const seq = ++orderSeq;
  orderState.value = 'loading';
  const r = await listAdminOrders({
    purpose: 'topup',
    userId: orderUserId.value.trim() || undefined,
    status: orderStatus.value || undefined,
    createdFrom: toFromIso(orderCreatedFrom.value),
    createdTo: toInclusiveEndIso(orderCreatedTo.value),
    cursor: orderCursor.value,
    limit: orderPageSize.value,
  });
  if (seq !== orderSeq) return;
  if (r.kind === 'ok') {
    orders.value = r.value.items;
    applyOrderPage({ nextCursor: r.value.nextCursor, total: r.value.total });
    orderState.value = 'ready';
  } else if (r.kind === 'unauthorized') relogin();
  else {
    orderState.value = 'error';
  }
}

function orderGoPrev(): void {
  if (orderPrevPage()) void loadOrders();
}

function orderGoNext(): void {
  if (orderNextPage()) void loadOrders();
}

function orderChangePageSize(size: number): void {
  setOrderPageSize(size);
  void loadOrders();
}

function resetOrderFilters(): void {
  orderStatus.value = '';
  orderUserId.value = '';
  orderCreatedFrom.value = '';
  orderCreatedTo.value = '';
  resetOrderPager();
  void loadOrders();
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  fulfilled: '已生效',
  failed: '支付失败',
  refunded: '已退款',
  expired: '已过期',
};

function channelLabel(ch: string): string {
  return ch === 'wechat' ? '微信' : ch === 'alipay' ? '支付宝' : '手工';
}

const actionForm = ref<{ order: AdminOrder; action: 'fulfill' | 'refund' } | null>(null);
const actionReason = ref('');

function openAction(o: AdminOrder, action: 'fulfill' | 'refund'): void {
  actionForm.value = { order: o, action };
  actionReason.value = '';
  error.value = '';
}

function closeAction(): void {
  if (busy.value) return;
  actionForm.value = null;
}

async function confirmAction(): Promise<void> {
  if (!actionForm.value || busy.value) return;
  const { order, action } = actionForm.value;
  const reasonValue = actionReason.value.trim();
  if (!reasonValue) {
    error.value = '请填写操作原因。';
    return;
  }
  const tag = `order:${action}:${order.orderNo}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = action === 'fulfill'
      ? await fulfillAdminAiTopupOrder(order.orderNo, reasonValue, orderWrite.ensure(tag), csrf)
      : await refundAdminAiTopupOrder(order.orderNo, reasonValue, orderWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      orderWrite.reset(tag);
      actionForm.value = null;
      notice.value = action === 'fulfill' ? `订单 ${order.orderNo} 已入账。` : `订单 ${order.orderNo} 已退款（额度已撤销）。`;
      await loadOrders();
    } else if (r.kind === 'unauthorized') {
      orderWrite.reset(tag);
      relogin();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '操作失败，请重试。';
    } else {
      orderWrite.reset(tag);
      error.value = action === 'fulfill' ? '操作失败：仅已支付订单可入账。' : '操作失败：仅已生效订单可退款。';
    }
  } finally {
    busy.value = false;
  }
}

const GRANT_STATUS_LABEL: Record<string, string> = {
  active: '生效中',
  exhausted: '已用尽',
  expired: '已过期',
  refunded: '已退款',
};
</script>

<template>
  <section class="page">
    <header class="head">
      <div>
        <h2>AI 积分</h2>
        <p class="sub">充值档位、手工建单与充值订单管理。查看单个用户的积分余额与请求明细，请到 用户列表 → 详情 → AI 积分。</p>
      </div>
      <div class="head-actions"><button class="btn" :disabled="busy" @click="openManual">手工建单</button></div>
    </header>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="error" class="error">{{ error }}</p>
    <Tabs v-model="tab" :tabs="[{ key: 'skus', label: '充值档位' }, { key: 'orders', label: '充值订单' }]" />

    <!-- ── SKU 目录 ── -->
    <template v-if="tab === 'skus'">
    <p class="muted" v-if="skuState === 'loading'">加载中…</p>
    <p class="error" v-if="skuState === 'error'">{{ skuError || '加载失败。' }}</p>
    <table v-if="skuState === 'ready'" class="table">
      <thead>
        <tr><th>档位</th><th>名称</th><th>积分</th><th>价格</th><th>有效期</th><th>状态</th><th>排序</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="s in skus" :key="s.code">
          <td class="mono">{{ s.code }}</td>
          <td>{{ s.label.zh }}</td>
          <td>{{ fmtCredits(s.tokens) }}</td>
          <td>¥{{ fmtCents(s.priceCents) }}</td>
          <td>{{ s.validDays }} 天</td>
          <td><span class="badge" :class="s.status">{{ s.status === 'active' ? '上架' : '停用' }}</span></td>
          <td>{{ s.sortOrder }}</td>
          <td class="actions">
            <button class="btn small" :disabled="busy" @click="openSkuEdit(s)">编辑</button>
            <button class="btn small secondary" :disabled="busy" @click="toggleSkuStatus(s)">{{ s.status === 'active' ? '停用' : '启用' }}</button>
          </td>
        </tr>
        <tr v-if="skus.length === 0"><td colspan="8" class="muted">无档位。</td></tr>
      </tbody>
    </table>
    </template>
    <!-- ── 充值订单 ── -->
    <template v-else>
    <div class="bar">
      <input v-model="orderUserId" type="text" placeholder="用户ID" @keyup.enter="loadOrders()" />
      <select v-model="orderStatus" @change="resetOrderPager(); loadOrders()">
        <option value="">全部状态</option>
        <option v-for="(label, st) in STATUS_LABEL" :key="st" :value="st">{{ label }}</option>
      </select>
      <label class="range">创建时间
        <input v-model="orderCreatedFrom" type="datetime-local" />
        至
        <input v-model="orderCreatedTo" type="datetime-local" />
      </label>
      <button class="btn" @click="resetOrderPager(); loadOrders()">查询</button>
      <button class="btn secondary" @click="resetOrderFilters">重置</button>
    </div>
    <p class="muted" v-if="orderState === 'loading'">加载中…</p>
    <p class="error" v-if="orderState === 'error'">加载失败。</p>
    <table v-if="orderState === 'ready'" class="table">
      <thead>
        <tr><th>订单号</th><th>用户</th><th>档位</th><th>金额</th><th>渠道</th><th>状态</th><th>支付时间</th><th>创建时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="o in orders" :key="o.orderNo">
          <td class="mono">{{ o.orderNo }}</td>
          <td :title="`用户 ID ${o.userId}`">{{ o.userEmail ?? o.userId }}</td>
          <td class="mono">{{ o.skuCode }}</td>
          <td>¥{{ fmtCents(o.amountCents) }}</td>
          <td>{{ channelLabel(o.channel) }}</td>
          <td><span class="badge" :class="o.status">{{ STATUS_LABEL[o.status] ?? o.status }}</span></td>
          <td>{{ formatDateTime(o.paidTime) }}</td>
          <td>{{ formatDateTime(o.createTime) }}</td>
          <td class="actions">
            <button class="btn small secondary" :disabled="busy" @click="orderDetail = o">详情</button>
            <button v-if="o.status === 'paid'" class="btn small" :disabled="busy" @click="openAction(o, 'fulfill')">入账</button>
            <button v-if="o.status === 'fulfilled'" class="btn small danger" :disabled="busy" @click="openAction(o, 'refund')">退款</button>
          </td>
        </tr>
        <tr v-if="orders.length === 0"><td colspan="9" class="muted">无充值订单。</td></tr>
      </tbody>
    </table>
    <Pager
      v-if="orderState === 'ready'"
      :page="orderPage"
      :page-size="orderPageSize"
      :total="orderTotal"
      :count="orders.length"
      :has-next="orderHasNext"
      :loading="orderState === 'loading'"
      @prev="orderGoPrev"
      @next="orderGoNext"
      @update:page-size="orderChangePageSize"
    />

    </template>

    <!-- SKU 编辑 Modal -->
    <Modal v-if="skuForm" title="编辑档位" :closable="!busy" @close="closeSkuEdit">
      <p class="muted">{{ skuForm.code }} · 当前 ¥{{ fmtCents(skuForm.priceCents) }} / {{ skuForm.validDays }} 天</p>
      <input v-model="skuLabelZh" type="text" maxlength="64" placeholder="中文名称" />
      <input v-model="skuLabelEn" type="text" maxlength="64" placeholder="英文名称" />
      <input v-model="skuPrice" type="text" placeholder="价格（元）" />
      <input v-model="skuValidDays" type="text" placeholder="有效期（天，1–3650）" />
      <input v-model="skuSort" type="text" placeholder="排序（整数）" />
      <input v-model="skuReason" type="text" maxlength="500" placeholder="变更原因（必填）" />
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :disabled="busy" @click="confirmSkuEdit">保存</button>
        <button class="btn secondary" :disabled="busy" @click="closeSkuEdit">取消</button>
      </div>
    </Modal>

    <!-- 手工建单 Modal -->
    <Modal v-if="manualForm" title="手工建单（立即生效）" :closable="!busy" @close="closeManual">
      <div class="user-row">
        <input v-model="manualForm.userInput" type="text" placeholder="用户邮箱或用户ID" @input="onUserInput" @keyup.enter="resolveUser" />
        <button class="btn secondary" :disabled="resolving || busy" @click="resolveUser">{{ resolving ? '查找中…' : '查找' }}</button>
      </div>
      <p class="resolved" v-if="resolvedUser">
        目标用户：<strong>{{ resolvedUser.email ?? '（仅 ID）' }}</strong> · 用户ID <span class="mono">{{ resolvedUser.userId }}</span>
      </p>
      <select v-model="manualForm.skuCode">
        <option v-for="s in skus.filter((x) => x.status === 'active')" :key="s.code" :value="s.code">
          {{ s.code }} · {{ s.label.zh }} · {{ fmtCredits(s.tokens) }} 积分 · ¥{{ fmtCents(s.priceCents) }}
        </option>
      </select>
      <p class="muted" v-if="manualSku">当前价：<strong>¥{{ fmtCents(manualSku.priceCents) }}</strong> —— 请在下方回填同一金额作二次确认。</p>
      <input v-model="manualForm.amount" type="text" placeholder="确认金额（元，须与当前价一致）" />
      <input v-model="manualForm.reason" type="text" maxlength="500" placeholder="建单原因（必填，进审计）" />
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn danger" :disabled="busy || !resolvedUser" @click="confirmManual">确认建单</button>
        <button class="btn secondary" :disabled="busy" @click="closeManual">取消</button>
      </div>
    </Modal>

    <!-- 订单详情 Modal -->
    <Modal v-if="orderDetail" title="充值订单详情" :closable="!busy" @close="orderDetail = null">
      <table class="kv">
        <tbody>
          <tr><th>订单号</th><td class="mono">{{ orderDetail.orderNo }}</td></tr>
          <tr><th>用户</th><td>{{ orderDetail.userEmail ?? '—' }}<span class="muted">（ID {{ orderDetail.userId }}，{{ orderDetail.userDisplayName ?? '未设置昵称' }}）</span></td></tr>
          <tr><th>档位</th><td class="mono">{{ orderDetail.skuCode ?? '—' }}</td></tr>
          <tr><th>金额</th><td>¥{{ fmtCents(orderDetail.amountCents) }}</td></tr>
          <tr><th>渠道</th><td>{{ channelLabel(orderDetail.channel) }}<span v-if="orderDetail.channelTradeNo" class="muted"> · {{ orderDetail.channelTradeNo }}</span></td></tr>
          <tr><th>状态</th><td><span class="badge" :class="orderDetail.status">{{ STATUS_LABEL[orderDetail.status] ?? orderDetail.status }}</span></td></tr>
          <tr><th>创建时间</th><td>{{ formatDateTime(orderDetail.createTime) }}</td></tr>
          <tr><th>支付时间</th><td>{{ formatDateTime(orderDetail.paidTime) }}</td></tr>
          <tr><th>过期时间</th><td>{{ formatDateTime(orderDetail.expiresTime) }}</td></tr>
        </tbody>
      </table>
      <div class="modal-actions">
        <button class="btn secondary" @click="orderDetail = null">关闭</button>
      </div>
    </Modal>

    <!-- 订单操作 Modal -->
    <Modal v-if="actionForm" :title="actionForm.action === 'fulfill' ? '入账' : '退款（撤销积分）'" :closable="!busy" @close="closeAction">
      <p class="muted">{{ actionForm.order.orderNo }} · {{ actionForm.order.skuCode }} · ¥{{ fmtCents(actionForm.order.amountCents) }} · {{ actionForm.order.status }}</p>
      <p class="muted" v-if="actionForm.action === 'refund'">退款只撤销该充值的剩余积分（已消耗部分保留审计），不发起支付渠道退款。</p>
      <input v-model="actionReason" type="text" maxlength="500" placeholder="操作原因（必填，进审计）" />
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :class="{ danger: actionForm.action === 'refund' }" :disabled="busy" @click="confirmAction">确认{{ actionForm.action === 'fulfill' ? '入账' : '退款' }}</button>
        <button class="btn secondary" :disabled="busy" @click="closeAction">取消</button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
h3 { font-size: 15px; font-weight: 700; color: var(--c-text); margin: 28px 0 8px; }
input, select, .modal-actions { margin-bottom: 4px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
.badge.active { background: var(--c-success-bg); color: var(--c-success-text); }
.badge.disabled, .badge.refunded, .badge.expired, .badge.failed { background: var(--c-danger-bg); color: var(--c-danger); }
.badge.pending { background: var(--c-warn-bg); color: var(--c-warn-text); }
.badge.paid, .badge.fulfilled { background: var(--c-accent-bg); color: var(--c-accent); }
.badge.exhausted { background: var(--c-surface-muted); color: var(--c-text-muted); }
.notice { color: var(--c-success-text); font-size: 13px; }
.quota-summary p { margin: 8px 0; font-size: 13px; }
.range { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text-muted); }
.kv { border-collapse: collapse; width: 100%; }
.kv th { width: 92px; text-align: left; padding: 6px 10px 6px 0; color: var(--c-text-muted); font-weight: 500; font-size: 13px; vertical-align: top; white-space: nowrap; }
.kv td { padding: 6px 0; font-size: 13.5px; word-break: break-all; }
.user-row { display: flex; gap: 8px; }
.user-row input { flex: 1; }
.resolved { color: var(--c-success-text); font-size: 13px; margin: 6px 0; }
</style>