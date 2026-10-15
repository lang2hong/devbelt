<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  createAdminAiTopupOrder,
  fulfillAdminAiTopupOrder,
  getAdminAiQuota,
  listAdminAiSkus,
  listAdminOrders,
  listUsers,
  refundAdminAiTopupOrder,
  updateAdminAiSku,
  type AdminAiQuota,
  type AdminAiTopupSku,
  type AdminOrder,
} from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { formatDateTime } from '../lib/formatTime';
import Modal from '../components/Modal.vue';

/** AI 加油包运营（P9.1b）：SKU 管理 / 手工建单（金额二次确认）/ 订单履行与退款 / 用户配额查询。 */

const skus = ref<AdminAiTopupSku[]>([]);
const skuState = ref<'loading' | 'ready' | 'error'>('loading');
const skuError = ref('');

const busy = ref(false);
const error = ref('');
const notice = ref('');
const skuWrite = useIdempotencyKey();
const orderWrite = useIdempotencyKey();
const quotaWrite = useIdempotencyKey();

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
const skuReason = ref('');

function openSkuEdit(s: AdminAiTopupSku): void {
  skuForm.value = s;
  skuPrice.value = String(s.priceCents);
  skuValidDays.value = String(s.validDays);
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
  const reasonValue = skuReason.value.trim();
  if (!reasonValue) {
    error.value = '请填写变更原因。';
    return;
  }
  const tag = `sku:${s.code}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const patch: { priceCents?: number; validDays?: number } = {};
    if (price !== s.priceCents) patch.priceCents = price;
    if (days !== s.validDays) patch.validDays = days;
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
      notice.value = `建单成功：${r.value.order.orderNo}（已生效 +${fmtTokens(r.value.order.tokens)} tokens）。`;
      await loadOrders();
      if (quotaUserId.value.trim() === String(uid)) await loadQuota();
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

// ── 加油包订单（purpose=topup；履行/退款）──

const orders = ref<AdminOrder[]>([]);
const orderState = ref<'loading' | 'ready' | 'error'>('loading');
const orderStatus = ref('');
const orderNextCursor = ref<string | null>(null);
let orderSeq = 0;
let orderPaging = false;

async function loadOrders(reset = true): Promise<void> {
  if (!reset && orderPaging) return;
  const seq = ++orderSeq;
  if (reset) orderPaging = false;
  else orderPaging = true;
  try {
    orderState.value = 'loading';
    const r = await listAdminOrders({
      purpose: 'topup',
      status: orderStatus.value || undefined,
      cursor: reset ? undefined : (orderNextCursor.value ?? undefined),
    });
    if (seq !== orderSeq) return;
    if (r.kind === 'ok') {
      orders.value = reset ? r.value.items : [...orders.value, ...r.value.items];
      orderNextCursor.value = r.value.nextCursor;
      orderState.value = 'ready';
    } else if (r.kind === 'unauthorized') relogin();
    else {
      orderState.value = 'error';
    }
  } finally {
    if (!reset) orderPaging = false;
  }
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

// ── 用户配额查询 ──

const quotaUserId = ref('');
const quota = ref<AdminAiQuota | null>(null);
const quotaState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');

async function loadQuota(): Promise<void> {
  const raw = quotaUserId.value.trim();
  const uid = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(uid) || uid <= 0) {
    quotaState.value = 'error';
    return;
  }
  quotaState.value = 'loading';
  const r = await getAdminAiQuota(uid);
  if (r.kind === 'ok') {
    quota.value = r.value;
    quotaState.value = 'ready';
  } else if (r.kind === 'unauthorized') relogin();
  else {
    quotaState.value = 'error';
    quota.value = null;
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
      <h2>AI 加油包</h2>
      <p class="sub">档位管理、手工建单、订单履行/退款与用户配额查询（P9.1）。</p>
    </header>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <!-- ── SKU 目录 ── -->
    <h3>档位目录</h3>
    <p class="muted" v-if="skuState === 'loading'">加载中…</p>
    <p class="error" v-if="skuState === 'error'">{{ skuError || '加载失败。' }}</p>
    <table v-if="skuState === 'ready'" class="table">
      <thead>
        <tr><th>档位</th><th>名称</th><th>Tokens</th><th>价格</th><th>有效期</th><th>状态</th><th>排序</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="s in skus" :key="s.code">
          <td class="mono">{{ s.code }}</td>
          <td>{{ s.label.zh }}</td>
          <td>{{ fmtTokens(s.tokens) }}</td>
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
    <p class="bar">
      <button class="btn" :disabled="busy" @click="openManual">手工建单</button>
    </p>

    <!-- ── 加油包订单 ── -->
    <h3>加油包订单</h3>
    <div class="bar">
      <select v-model="orderStatus" @change="loadOrders(true)">
        <option value="">全部状态</option>
        <option v-for="(label, st) in STATUS_LABEL" :key="st" :value="st">{{ label }}</option>
      </select>
    </div>
    <p class="muted" v-if="orderState === 'loading'">加载中…</p>
    <p class="error" v-if="orderState === 'error'">加载失败。</p>
    <table v-if="orderState === 'ready'" class="table">
      <thead>
        <tr><th>订单号</th><th>用户ID</th><th>档位</th><th>金额</th><th>渠道</th><th>状态</th><th>创建时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="o in orders" :key="o.orderNo">
          <td class="mono">{{ o.orderNo }}</td>
          <td class="mono">{{ o.userId }}</td>
          <td class="mono">{{ o.skuCode }}</td>
          <td>¥{{ fmtCents(o.amountCents) }}</td>
          <td>{{ channelLabel(o.channel) }}</td>
          <td><span class="badge" :class="o.status">{{ STATUS_LABEL[o.status] ?? o.status }}</span></td>
          <td>{{ formatDateTime(o.createTime) }}</td>
          <td class="actions">
            <button v-if="o.status === 'paid'" class="btn small" :disabled="busy" @click="openAction(o, 'fulfill')">入账</button>
            <button v-if="o.status === 'fulfilled'" class="btn small danger" :disabled="busy" @click="openAction(o, 'refund')">退款</button>
          </td>
        </tr>
        <tr v-if="orders.length === 0"><td colspan="8" class="muted">无加油包订单。</td></tr>
      </tbody>
    </table>
    <p v-if="orderNextCursor" class="load-more"><button class="btn secondary" @click="loadOrders(false)">加载更多</button></p>

    <!-- ── 用户配额查询 ── -->
    <h3>用户配额查询</h3>
    <div class="bar">
      <input v-model="quotaUserId" type="text" placeholder="用户ID" @keyup.enter="loadQuota" />
      <button class="btn" @click="loadQuota">查询</button>
    </div>
    <p class="muted" v-if="quotaState === 'loading'">查询中…</p>
    <p class="error" v-if="quotaState === 'error' && !quota">查询失败：用户 ID 必须为正整数。</p>
    <template v-if="quotaState === 'ready' && quota">
      <div class="quota-summary">
        <p>月额度剩余：<strong>{{ fmtTokens(quota.snapshot.monthlyRemaining) }}</strong> tokens ·
           加油包剩余：<strong>{{ fmtTokens(quota.snapshot.topupRemaining) }}</strong> tokens ·
           已用 {{ fmtTokens(quota.snapshot.used) }} / 预占 {{ fmtTokens(quota.snapshot.reserved) }} ·
           月重置 {{ quota.snapshot.resetAt ? formatDateTime(quota.snapshot.resetAt) : '—' }}</p>
      </div>
      <table class="table">
        <thead>
          <tr><th>Grant</th><th>订单ID</th><th>档位</th><th>状态</th><th>总量</th><th>已用</th><th>预占</th><th>过期时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="g in quota.grants" :key="g.grantId">
            <td class="mono">{{ g.grantId }}</td>
            <td class="mono">{{ g.orderId }}</td>
            <td class="mono">{{ g.skuCode }}</td>
            <td><span class="badge" :class="g.status">{{ GRANT_STATUS_LABEL[g.status] ?? g.status }}</span></td>
            <td>{{ fmtTokens(g.tokensTotal) }}</td>
            <td>{{ fmtTokens(g.tokensUsed) }}</td>
            <td>{{ fmtTokens(g.tokensReserved) }}</td>
            <td>{{ formatDateTime(g.expiresTime) }}</td>
          </tr>
          <tr v-if="quota.grants.length === 0"><td colspan="8" class="muted">无加油包记录。</td></tr>
        </tbody>
      </table>
    </template>

    <!-- SKU 编辑 Modal -->
    <Modal v-if="skuForm" title="编辑档位" :closable="!busy" @close="closeSkuEdit">
      <p class="muted">{{ skuForm.code }} · {{ skuForm.label.zh }} · 当前 ¥{{ fmtCents(skuForm.priceCents) }} / {{ skuForm.validDays }} 天</p>
      <input v-model="skuPrice" type="text" placeholder="价格（元）" />
      <input v-model="skuValidDays" type="text" placeholder="有效期（天，1–3650）" />
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
          {{ s.code }} · {{ s.label.zh }} · {{ fmtTokens(s.tokens) }} tokens · ¥{{ fmtCents(s.priceCents) }}
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

    <!-- 订单操作 Modal -->
    <Modal v-if="actionForm" :title="actionForm.action === 'fulfill' ? '入账' : '退款（撤销额度）'" :closable="!busy" @close="closeAction">
      <p class="muted">{{ actionForm.order.orderNo }} · {{ actionForm.order.skuCode }} · ¥{{ fmtCents(actionForm.order.amountCents) }} · {{ actionForm.order.status }}</p>
      <p class="muted" v-if="actionForm.action === 'refund'">退款只撤销加油包剩余额度（已用部分保留审计），不发起支付渠道退款。</p>
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
.page { max-width: 960px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: var(--c-text); }
h3 { font-size: 15px; font-weight: 700; color: var(--c-text); margin: 28px 0 8px; }
.bar { display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
input, select { box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--c-border-strong); border-radius: 6px; font-size: 14px; }
input, select, .modal-actions { margin-bottom: 4px; }
.table { width: 100%; border-collapse: collapse; background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eaeef2; font-size: 13px; }
th { white-space: nowrap; color: var(--c-text-muted); font-weight: 600; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
.badge.active { background: #dafbe1; color: var(--c-success-text); }
.badge.disabled, .badge.refunded, .badge.expired, .badge.failed { background: #ffebe9; color: var(--c-danger); }
.badge.pending { background: var(--c-warn-bg); color: var(--c-warn-text); }
.badge.paid, .badge.fulfilled { background: var(--c-accent-bg); color: var(--c-accent); }
.badge.exhausted { background: var(--c-surface-muted); color: var(--c-text-muted); }
.btn { background: var(--c-accent); color: var(--c-surface); border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.btn.secondary { background: var(--c-surface-muted); color: var(--c-text); border: 1px solid var(--c-border-strong); }
.btn.small { padding: 5px 10px; font-size: 13px; }
.btn.danger { background: var(--c-danger); }
.btn:disabled { opacity: 0.6; cursor: default; }
.actions { display: flex; gap: 6px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
.notice { color: var(--c-success-text); font-size: 13px; }
.load-more { margin: 16px 0; }
.head { margin-bottom: 16px; }
.head h2 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--c-text-muted); }
.quota-summary p { margin: 8px 0; font-size: 13px; }
.user-row { display: flex; gap: 8px; }
.user-row input { flex: 1; }
.resolved { color: var(--c-success-text); font-size: 13px; margin: 6px 0; }
</style>