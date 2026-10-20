<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { withBase, router, navigate } from '../lib/router';
import {
  listUsers, setUserRole, setUserStatus, adjustUserSubscription,
  getAdminAiQuota, getSyncOverview, listSyncRecords,
  listAdminOrders, listAdminInvoices, queryAudit, listAdminUserAiRequests, listPlans,
  type AdminAiQuota, type AdminUser, type AdminSyncKindOverview, type AdminSyncRecord,
  type AdminOrder, type AdminInvoice, type AdminAuditEvent, type AdminAiRequestLog,
} from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { formatDateTime } from '../lib/formatTime';
import { fmtCredits } from '../lib/credits';
import { auditEventLabel } from '../lib/auditLabels';
import Modal from '../components/Modal.vue';
import Tabs from '../components/Tabs.vue';
import FormField from '../components/FormField.vue';

const props = defineProps<{ userId: string }>();

type TabKey = 'overview' | 'ai' | 'orders' | 'invoices' | 'sync' | 'audit';
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'ai', label: 'AI 积分' },
  { key: 'orders', label: '订单' },
  { key: 'invoices', label: '发票' },
  { key: 'sync', label: '同步数据' },
  { key: 'audit', label: '操作记录' },
];
const tab = ref<TabKey>('overview');

const user = ref<AdminUser | null>(null);
const userState = ref<'loading' | 'ready' | 'error'>('loading');
const userError = ref('');
const error = ref('');
const busy = ref(false);

const statusWrite = useIdempotencyKey();
const subWrite = useIdempotencyKey();

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

function serverMsg(r: { message?: string; code?: string }): string {
  return r.message || r.code || '操作失败，请重试。';
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n.toLocaleString();
}

function fmtCents(cents: number | null): string {
  return cents === null ? '—' : `¥${(cents / 100).toFixed(2)}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const ORDER_STATUS: Record<string, string> = {
  pending: '待支付', paid: '已支付', fulfilled: '已生效', failed: '支付失败', refunded: '已退款', expired: '已过期',
};
const INVOICE_STATUS: Record<string, string> = {
  requested: '待处理', issued: '已开票', rejected: '已拒绝', failed: '开票失败',
};
const GRANT_STATUS: Record<string, string> = {
  active: '生效中', exhausted: '已用尽', expired: '已过期', refunded: '已退款',
};

/** ISO → `<input type="datetime-local">` 的本地时间值（YYYY-MM-DDTHH:mm）。 */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadUser(): Promise<void> {
  userState.value = 'loading';
  userError.value = '';
  const r = await listUsers({ userId: props.userId });
  if (r.kind === 'ok') {
    user.value = r.value.items[0] ?? null;
    userState.value = 'ready';
  } else if (r.kind === 'unauthorized') {
    relogin();
  } else {
    userState.value = 'error';
    userError.value = r.kind === 'failure' ? serverMsg(r) : '加载失败。';
  }
}

onMounted(() => {
  void loadUser();
  void loadPlanOptions();
});

watch(() => props.userId, () => {
  resetUserData();
  void loadUser();
});

// ── 套餐选项（筛选用全量；调整订阅只允许启用中的套餐）──
type PlanOption = { code: string; name: string; status: string };
const planOptions = ref<PlanOption[]>([
  { code: 'free', name: 'Free', status: 'active' },
  { code: 'pro', name: 'Pro', status: 'active' },
]);
const activePlanOptions = computed(() => planOptions.value.filter((p) => p.status === 'active'));

async function loadPlanOptions(): Promise<void> {
  const r = await listPlans();
  if (r.kind === 'ok' && r.value.items.length > 0) {
    planOptions.value = r.value.items.map((p) => ({ code: p.code, name: p.name, status: p.status }));
  }
}

// ── 操作弹窗（状态 / 订阅 / 角色）──
const statusForm = ref<{ status: 'active' | 'disabled' } | null>(null);
const statusReason = ref('');
const subForm = ref(false);
const subPlan = ref('free');
const subPeriodEnd = ref('');
const subReason = ref('');
const roleForm = ref<{ role: 'user' | 'platform_admin' } | null>(null);
const roleReason = ref('');

function openStatus(status: 'active' | 'disabled'): void {
  statusForm.value = { status };
  statusReason.value = '';
  error.value = '';
}

async function confirmStatus(): Promise<void> {
  const form = statusForm.value;
  const u = user.value;
  if (!form || !u || busy.value) return;
  const reasonValue = statusReason.value.trim();
  if (!reasonValue) {
    error.value = '请填写操作原因。';
    return;
  }
  const tag = `status:${u.userId}:${form.status}:${reasonValue}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await setUserStatus(u.userId, form.status, reasonValue, statusWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      statusWrite.reset(tag);
      statusForm.value = null;
      await loadUser();
    } else if (r.kind === 'unauthorized') {
      statusWrite.reset(tag);
      relogin();
    } else {
      statusWrite.reset(tag);
      error.value = serverMsg(r);
    }
  } finally {
    busy.value = false;
  }
}

function openSub(): void {
  subForm.value = true;
  subPlan.value = user.value?.planCode ?? 'free';
  subPeriodEnd.value = toLocalInput(user.value?.periodEndTime ?? null);
  subReason.value = '';
  error.value = '';
}

async function confirmSub(): Promise<void> {
  const u = user.value;
  if (!subForm.value || !u || busy.value) return;
  const reasonValue = subReason.value.trim();
  if (!reasonValue) {
    error.value = '请填写操作原因。';
    return;
  }
  const end = subPeriodEnd.value ? new Date(subPeriodEnd.value) : null;
  if (end && Number.isNaN(end.getTime())) {
    error.value = '到期时间格式不正确。';
    return;
  }
  const tag = `sub:${u.userId}:${subPlan.value}:${reasonValue}:${u.subscriptionVersion ?? 0}:${subPeriodEnd.value}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await adjustUserSubscription(u.userId, {
      planCode: subPlan.value,
      periodEndTime: end ? end.toISOString() : null,
      reason: reasonValue,
      expectedVersion: u.subscriptionVersion ?? 0,
    }, subWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      subWrite.reset(tag);
      subForm.value = false;
      await loadUser();
    } else if (r.kind === 'unauthorized') {
      subWrite.reset(tag);
      relogin();
    } else if (r.kind === 'conflict') {
      subWrite.reset(tag);
      error.value = '订阅版本已变化，请刷新后重试。';
    } else if (isRetryableFailure(r.kind)) {
      error.value = serverMsg(r);
    } else {
      subWrite.reset(tag);
      error.value = serverMsg(r);
    }
  } finally {
    busy.value = false;
  }
}

function openRole(role: 'user' | 'platform_admin'): void {
  roleForm.value = { role };
  roleReason.value = '';
  error.value = '';
}

async function confirmRole(): Promise<void> {
  const form = roleForm.value;
  const u = user.value;
  if (!form || !u || busy.value) return;
  const reasonValue = roleReason.value.trim();
  if (!reasonValue) {
    error.value = '请填写操作原因。';
    return;
  }
  const tag = `role:${u.userId}:${form.role}:${reasonValue}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await setUserRole(u.userId, form.role, reasonValue, statusWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      statusWrite.reset(tag);
      roleForm.value = null;
      await loadUser();
    } else if (r.kind === 'unauthorized') {
      statusWrite.reset(tag);
      relogin();
    } else {
      statusWrite.reset(tag);
      error.value = serverMsg(r);
    }
  } finally {
    busy.value = false;
  }
}

// ── 页签懒加载 ──
const loaded = ref(new Set<TabKey>(['overview']));

watch(tab, (t) => {
  if (!loaded.value.has(t)) {
    loaded.value.add(t);
    if (t === 'ai') { void loadAi(); void loadAiRequests(true); }
    if (t === 'orders') void loadOrders(true);
    if (t === 'invoices') void loadInvoices(true);
    if (t === 'sync') void loadSync();
    if (t === 'audit') void loadAudit(true);
  }
});

// ── AI 用量（积分口径：额度/余额经 fmtCredits；近月用量为原始 token 对账口径）──
const aiQuota = ref<AdminAiQuota | null>(null);
const aiError = ref('');
const aiRequests = ref<AdminAiRequestLog[]>([]);
const aiRequestsCursor = ref<string | null>(null);
const aiRequestsLoaded = ref(false);

async function loadAi(): Promise<void> {
  aiError.value = '';
  const r = await getAdminAiQuota(Number(props.userId));
  if (r.kind === 'ok') aiQuota.value = r.value;
  else if (r.kind === 'unauthorized') relogin();
  else aiError.value = r.kind === 'failure' ? serverMsg(r) : '加载失败。';
}

async function loadAiRequests(reset: boolean): Promise<void> {
  const r = await listAdminUserAiRequests(props.userId, { cursor: reset ? undefined : aiRequestsCursor.value ?? undefined });
  if (r.kind === 'ok') {
    aiRequests.value = reset ? r.value.items : [...aiRequests.value, ...r.value.items];
    aiRequestsCursor.value = r.value.nextCursor;
    aiRequestsLoaded.value = true;
  } else if (r.kind === 'unauthorized') relogin();
  else aiError.value = r.kind === 'failure' ? serverMsg(r) : '请求记录加载失败。';
}

// ── 订单 ──
const orders = ref<AdminOrder[]>([]);
const ordersState = ref<'loading' | 'ready' | 'error'>('loading');
const ordersError = ref('');
const ordersCursor = ref<string | null>(null);

async function loadOrders(reset: boolean): Promise<void> {
  ordersState.value = 'loading';
  ordersError.value = '';
  const r = await listAdminOrders({ userId: props.userId, cursor: reset ? undefined : ordersCursor.value ?? undefined });
  if (r.kind === 'ok') {
    orders.value = reset ? r.value.items : [...orders.value, ...r.value.items];
    ordersCursor.value = r.value.nextCursor;
    ordersState.value = 'ready';
  } else if (r.kind === 'unauthorized') {
    relogin();
  } else {
    ordersState.value = 'error';
    ordersError.value = r.kind === 'failure' ? serverMsg(r) : '加载失败。';
  }
}

// ── 发票 ──
const invoices = ref<AdminInvoice[]>([]);
const invoicesState = ref<'loading' | 'ready' | 'error'>('loading');
const invoicesError = ref('');
const invoicesCursor = ref<string | null>(null);

async function loadInvoices(reset: boolean): Promise<void> {
  invoicesState.value = 'loading';
  invoicesError.value = '';
  const r = await listAdminInvoices({ userId: props.userId, cursor: reset ? undefined : invoicesCursor.value ?? undefined });
  if (r.kind === 'ok') {
    invoices.value = reset ? r.value.items : [...invoices.value, ...r.value.items];
    invoicesCursor.value = r.value.nextCursor;
    invoicesState.value = 'ready';
  } else if (r.kind === 'unauthorized') {
    relogin();
  } else {
    invoicesState.value = 'error';
    invoicesError.value = r.kind === 'failure' ? serverMsg(r) : '加载失败。';
  }
}

// ── 同步数据 ──
const syncKinds = ref<AdminSyncKindOverview[]>([]);
const syncState = ref<AdminSyncRecordsPageState | null>(null);
const syncRecords = ref<AdminSyncRecord[]>([]);
const syncRecordsCursor = ref<string | null>(null);
const syncKindFilter = ref('');
const syncStateError = ref('');
const syncLoading = ref(false);
type AdminSyncRecordsPageState = { keyEpoch: string; stateVersion: string; changeSequence: string; protocolVersion: number; cipherSuite: string; formatVersion: number };

async function loadSync(): Promise<void> {
  syncLoading.value = true;
  syncStateError.value = '';
  try {
    const [ov, rec] = await Promise.all([
      getSyncOverview(props.userId),
      listSyncRecords(props.userId, { kind: syncKindFilter.value || undefined }),
    ]);
    if (ov.kind === 'ok') syncKinds.value = ov.value;
    else if (ov.kind === 'unauthorized') { relogin(); return; }
    else syncStateError.value = ov.kind === 'failure' ? serverMsg(ov) : '加载失败。';
    if (rec.kind === 'ok') {
      syncState.value = rec.value.state;
      syncRecords.value = rec.value.items;
      syncRecordsCursor.value = rec.value.nextCursor;
    } else if (rec.kind === 'unauthorized') {
      relogin();
    } else {
      syncStateError.value = rec.kind === 'failure' ? serverMsg(rec) : '加载失败。';
    }
  } finally {
    syncLoading.value = false;
  }
}

async function loadMoreSyncRecords(): Promise<void> {
  const r = await listSyncRecords(props.userId, { kind: syncKindFilter.value || undefined, cursor: syncRecordsCursor.value ?? undefined });
  if (r.kind === 'ok') {
    syncRecords.value = [...syncRecords.value, ...r.value.items];
    syncRecordsCursor.value = r.value.nextCursor;
  } else if (r.kind === 'unauthorized') relogin();
  else syncStateError.value = r.kind === 'failure' ? serverMsg(r) : '加载失败。';
}

async function onSyncKindChange(): Promise<void> {
  syncRecordsCursor.value = null;
  const r = await listSyncRecords(props.userId, { kind: syncKindFilter.value || undefined });
  if (r.kind === 'ok') {
    syncRecords.value = r.value.items;
    syncRecordsCursor.value = r.value.nextCursor;
  } else if (r.kind === 'unauthorized') relogin();
  else syncStateError.value = r.kind === 'failure' ? serverMsg(r) : '加载失败。';
}

const kindOptions = computed(() => syncKinds.value.map((k) => k.entityKind).filter((k): k is string => !!k));

// ── 操作记录（该用户作为操作者）──
const auditEvents = ref<AdminAuditEvent[]>([]);
const auditState = ref<'loading' | 'ready' | 'error'>('loading');
const auditError = ref('');
const auditCursor = ref<string | null>(null);

async function loadAudit(reset: boolean): Promise<void> {
  auditState.value = 'loading';
  auditError.value = '';
  const r = await queryAudit({ actorUserId: props.userId, cursor: reset ? undefined : auditCursor.value ?? undefined });
  if (r.kind === 'ok') {
    auditEvents.value = reset ? r.value.items : [...auditEvents.value, ...r.value.items];
    auditCursor.value = r.value.nextCursor;
    auditState.value = 'ready';
  } else if (r.kind === 'unauthorized') {
    relogin();
  } else {
    auditState.value = 'error';
    auditError.value = r.kind === 'failure' ? serverMsg(r) : '加载失败。';
  }
}

/** 切换到另一个用户时清空所有按用户缓存的数据，避免复用组件显示旧用户内容。 */
function resetUserData(): void {
  user.value = null;
  userState.value = 'loading';
  userError.value = '';
  error.value = '';
  statusForm.value = null;
  subForm.value = false;
  roleForm.value = null;
  statusWrite.keys.clear();
  subWrite.keys.clear();

  tab.value = 'overview';
  loaded.value = new Set<TabKey>(['overview']);

  aiQuota.value = null;
  aiError.value = '';
  aiRequests.value = [];
  aiRequestsCursor.value = null;
  aiRequestsLoaded.value = false;

  orders.value = [];
  ordersState.value = 'loading';
  ordersError.value = '';
  ordersCursor.value = null;

  invoices.value = [];
  invoicesState.value = 'loading';
  invoicesError.value = '';
  invoicesCursor.value = null;

  syncKinds.value = [];
  syncState.value = null;
  syncRecords.value = [];
  syncRecordsCursor.value = null;
  syncKindFilter.value = '';
  syncStateError.value = '';
  syncLoading.value = false;

  auditEvents.value = [];
  auditState.value = 'loading';
  auditError.value = '';
  auditCursor.value = null;
}

function goBack(): void {
  navigate('/users');
}
</script>

<template>
  <section class="page">
    <p class="muted" v-if="userState === 'loading'">加载中…</p>
    <p class="error" v-else-if="userState === 'error'">{{ userError || '加载失败。' }} <a :href="withBase('/users')" @click.prevent="goBack">返回列表</a></p>
    <p class="error" v-else-if="userState === 'ready' && !user">用户不存在。<a :href="withBase('/users')" @click.prevent="goBack">返回列表</a></p>

    <template v-else>
      <header class="head">
        <div>
          <a class="back" :href="withBase('/users')" @click.prevent="goBack">← 返回用户列表</a>
          <h2>{{ user.email }}</h2>
          <p class="sub">
            <span class="badge" :class="user.status === 'active' ? 'ok' : 'danger'">{{ user.status === 'active' ? '启用' : '禁用' }}</span>
            <span class="badge" :class="user.role === 'platform_admin' ? 'warn' : ''">{{ user.role === 'platform_admin' ? '管理员' : '普通用户' }}</span>
            套餐 {{ user.planCode ?? '—' }}<span v-if="user.subscriptionVersion != null" class="muted">（v{{ user.subscriptionVersion }}）</span> ·
            设备 {{ user.deviceCount }} 台 · 注册于 {{ formatDateTime(user.createTime) }}<template v-if="user.periodEndTime"> · 订阅到期 {{ formatDateTime(user.periodEndTime) }}</template><template v-if="user.lastLoginTime"> · 最近登录 {{ formatDateTime(user.lastLoginTime) }}</template>
          </p>
        </div>
        <div class="head-actions">
          <button v-if="user.status === 'active'" class="btn small danger" :disabled="busy" @click="openStatus('disabled')">禁用账号</button>
          <button v-else class="btn small" :disabled="busy" @click="openStatus('active')">启用账号</button>
          <button class="btn small secondary" :disabled="busy" @click="openSub">调整订阅</button>
          <button v-if="user.role !== 'platform_admin'" class="btn small secondary" :disabled="busy" @click="openRole('platform_admin')">设为管理员</button>
          <button v-else class="btn small secondary" :disabled="busy" @click="openRole('user')">撤销管理员</button>
        </div>
      </header>

      <p v-if="error" class="error">{{ error }}</p>

      <Tabs v-model="tab" :tabs="TABS" />

      <!-- 概览 -->
      <div v-if="tab === 'overview'" class="card">
        <table class="kv">
          <tbody>
            <tr><th>用户 ID</th><td class="mono">{{ user.userId }}</td></tr>
            <tr><th>邮箱</th><td>{{ user.email }}<span v-if="user.emailVerified" class="badge ok">已验证</span><span v-else class="badge">未验证</span></td></tr>
            <tr><th>昵称</th><td>{{ user.displayName ?? '—' }}</td></tr>
            <tr><th>状态</th><td>{{ user.status === 'active' ? '启用' : '禁用' }}</td></tr>
            <tr><th>角色</th><td>{{ user.role === 'platform_admin' ? '平台管理员' : '普通用户' }}</td></tr>
            <tr><th>套餐</th><td>{{ user.planCode ?? '—' }}<span v-if="user.subscriptionVersion != null" class="muted">（订阅版本 v{{ user.subscriptionVersion }}）</span></td></tr>
            <tr><th>设备数</th><td>{{ user.deviceCount }}</td></tr>
            <tr><th>订阅到期</th><td>{{ formatDateTime(user.periodEndTime) }}</td></tr>
            <tr><th>注册时间</th><td>{{ formatDateTime(user.createTime) }}</td></tr>
            <tr><th>最近登录</th><td>{{ formatDateTime(user.lastLoginTime) }}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- AI 用量 -->
      <div v-if="tab === 'ai'">
        <p class="muted" v-if="!aiQuota && !aiError">加载中…</p>
        <p class="error" v-if="aiError">{{ aiError }}</p>
        <template v-if="aiQuota">
          <div class="stat-grid">
            <div class="stat"><span class="stat-label">本月已用（积分）</span><span class="stat-value">{{ fmtCredits(aiQuota.snapshot.used) }}</span></div>
            <div class="stat"><span class="stat-label">预占中（积分）</span><span class="stat-value">{{ fmtCredits(aiQuota.snapshot.reserved) }}</span></div>
            <div class="stat"><span class="stat-label">本月赠送剩余</span><span class="stat-value">{{ fmtCredits(aiQuota.snapshot.monthlyRemaining) }}</span></div>
            <div class="stat"><span class="stat-label">充值余额</span><span class="stat-value">{{ fmtCredits(aiQuota.snapshot.topupRemaining) }}</span></div>
          </div>
          <p class="muted quota-note" v-if="aiQuota.snapshot.resetAt">本月赠送额度重置：{{ formatDateTime(aiQuota.snapshot.resetAt) }}</p>

          <h4>积分充值</h4>
          <p class="quota-note">
            共 {{ aiQuota.topupOrders?.totalCount ?? 0 }} 笔 · 已支付 {{ aiQuota.topupOrders?.paidCount ?? 0 }} 笔（{{ fmtCents(aiQuota.topupOrders?.paidCents ?? 0) }}）<template v-if="aiQuota.topupOrders?.refundedCount"> · 退款 {{ aiQuota.topupOrders.refundedCount }} 笔</template><template v-if="aiQuota.topupOrders?.lastPaidTime"> · 最近支付 {{ formatDateTime(aiQuota.topupOrders.lastPaidTime) }}</template>
          </p>

          <h4>近月用量</h4>
          <p class="muted small">输入/输出为计费 token（积分 = 计费 token ÷ 1000）；原始 token 见下方请求记录。</p>
          <table class="table">
            <thead><tr><th>月份</th><th>计费输入 token</th><th>计费输出 token</th><th>请求数</th></tr></thead>
            <tbody>
              <tr v-for="m in aiQuota.months ?? []" :key="m.usageMonth">
                <td class="mono">{{ m.usageMonth }}</td>
                <td>{{ fmtTokens(m.promptTokens) }}</td>
                <td>{{ fmtTokens(m.completionTokens) }}</td>
                <td>{{ m.requestCount }}</td>
              </tr>
              <tr v-if="(aiQuota.months ?? []).length === 0"><td colspan="4" class="muted">无用量记录。</td></tr>
            </tbody>
          </table>

          <h4 v-if="(aiQuota.grants ?? []).length">充值积分余额</h4>
          <table v-if="(aiQuota.grants ?? []).length" class="table">
            <thead><tr><th>档位</th><th>总量（积分）</th><th>已用（积分）</th><th>状态</th><th>过期时间</th></tr></thead>
            <tbody>
              <tr v-for="g in aiQuota.grants" :key="g.grantId">
                <td class="mono">{{ g.skuCode }}</td>
                <td>{{ fmtCredits(g.tokensTotal) }}</td>
                <td>{{ fmtCredits(g.tokensUsed) }}</td>
                <td><span class="badge" :class="g.status === 'active' ? 'ok' : ''">{{ GRANT_STATUS[g.status] ?? g.status }}</span></td>
                <td>{{ formatDateTime(g.expiresTime) }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <template v-if="aiRequestsLoaded">
          <h4>请求记录</h4>
          <p class="muted small">每笔 AI 请求的计量与扣减（消耗积分 = 计费 token ÷ 1000）；只存计量，不存对话内容。保留 180 天。</p>
          <table class="table">
            <thead><tr><th>时间</th><th>模型</th><th>状态</th><th>输入 token</th><th>输出 token</th><th>消耗积分</th><th>当时成本</th><th>耗时</th></tr></thead>
            <tbody>
              <tr v-for="r in aiRequests" :key="r.createTime + r.model + r.rawPromptTokens">
                <td>{{ formatDateTime(r.createTime) }}</td>
                <td class="mono">{{ r.model }}</td>
                <td><span class="badge" :class="r.status === 'completed' ? 'ok' : 'danger'">{{ r.status === 'completed' ? '成功' : r.status === 'aborted' ? '中断' : '失败' }}</span></td>
                <td>{{ r.rawPromptTokens.toLocaleString() }}</td>
                <td>{{ r.rawCompletionTokens.toLocaleString() }}</td>
                <td>{{ fmtCredits(r.billingPromptTokens + r.billingCompletionTokens) }}</td>
                <td>{{ fmtCents(r.costCents) }}</td>
                <td class="muted">{{ (r.latencyMs / 1000).toFixed(1) }}s<template v-if="r.usageEstimated"> · 估算</template></td>
              </tr>
              <tr v-if="aiRequests.length === 0"><td colspan="8" class="muted">暂无请求记录（流水自上线起累计，保留 180 天）。</td></tr>
            </tbody>
          </table>
          <p v-if="aiRequestsCursor" class="load-more"><button class="btn secondary" @click="loadAiRequests(false)">加载更多</button></p>
        </template>
      </div>

      <!-- 订单 -->
      <div v-if="tab === 'orders'">
        <p class="muted" v-if="ordersState === 'loading'">加载中…</p>
        <p class="error" v-if="ordersState === 'error'">{{ ordersError }}</p>
        <table v-if="ordersState === 'ready'" class="table">
          <thead><tr><th>订单号</th><th>用途</th><th>商品</th><th>金额</th><th>状态</th><th>创建时间</th></tr></thead>
          <tbody>
            <tr v-for="o in orders" :key="o.orderNo">
              <td class="mono">{{ o.orderNo }}</td>
              <td>{{ o.purpose === 'topup' ? '积分充值' : '套餐订阅' }}</td>
              <td class="mono">{{ o.skuCode ?? o.planCode ?? '—' }}</td>
              <td>{{ fmtCents(o.amountCents) }}</td>
              <td><span class="badge" :class="o.status">{{ ORDER_STATUS[o.status] ?? o.status }}</span></td>
              <td>{{ formatDateTime(o.createTime) }}</td>
            </tr>
            <tr v-if="orders.length === 0"><td colspan="6" class="muted">该用户暂无订单。</td></tr>
          </tbody>
        </table>
        <p v-if="ordersCursor" class="load-more"><button class="btn secondary" @click="loadOrders(false)">加载更多</button></p>
      </div>

      <!-- 发票 -->
      <div v-if="tab === 'invoices'">
        <p class="muted" v-if="invoicesState === 'loading'">加载中…</p>
        <p class="error" v-if="invoicesState === 'error'">{{ invoicesError }}</p>
        <table v-if="invoicesState === 'ready'" class="table">
          <thead><tr><th>抬头</th><th>金额</th><th>接收邮箱</th><th>状态</th><th>申请时间</th></tr></thead>
          <tbody>
            <tr v-for="i in invoices" :key="i.invoiceId">
              <td>{{ i.title }}</td>
              <td>{{ fmtCents(i.amountCents) }}</td>
              <td>{{ i.email }}</td>
              <td><span class="badge" :class="i.status">{{ INVOICE_STATUS[i.status] ?? i.status }}</span></td>
              <td>{{ formatDateTime(i.createTime) }}</td>
            </tr>
            <tr v-if="invoices.length === 0"><td colspan="5" class="muted">该用户暂无发票申请。</td></tr>
          </tbody>
        </table>
        <p v-if="invoicesCursor" class="load-more"><button class="btn secondary" @click="loadInvoices(false)">加载更多</button></p>
      </div>

      <!-- 同步数据 -->
      <div v-if="tab === 'sync'">
        <p class="muted" v-if="syncLoading">加载中…</p>
        <p class="error" v-if="syncStateError">{{ syncStateError }}</p>
        <p class="muted" v-if="!syncLoading && syncState === null && !syncStateError">该用户未启用数据同步。</p>
        <template v-if="syncState">
          <div class="stat-grid">
            <div class="stat"><span class="stat-label">已同步数据</span><span class="stat-value">{{ syncKinds.reduce((s, k) => s + k.count, 0) }} 条</span></div>
            <div class="stat"><span class="stat-label">占用空间</span><span class="stat-value">{{ fmtBytes(syncKinds.reduce((s, k) => s + k.bytes, 0)) }}</span></div>
            <div class="stat"><span class="stat-label">同步版本</span><span class="stat-value">{{ syncState.stateVersion }}</span></div>
            <div class="stat"><span class="stat-label">加密方式</span><span class="stat-value">{{ syncState.cipherSuite }}</span></div>
          </div>
          <p class="privacy-note">同步数据端到端加密，平台只能看到数据类型、大小和时间，看不到内容。</p>

          <h4 v-if="syncKinds.length">数据分类</h4>
          <table v-if="syncKinds.length" class="table">
            <thead><tr><th>数据类型</th><th>条数</th><th>占用</th><th>最近变更</th></tr></thead>
            <tbody>
              <tr v-for="k in syncKinds" :key="k.entityKind ?? 'unknown'">
                <td>{{ k.entityKind ?? '（未标注）' }}</td>
                <td>{{ k.count }}</td>
                <td>{{ fmtBytes(k.bytes) }}</td>
                <td>{{ formatDateTime(k.lastActivityTime) }}</td>
              </tr>
            </tbody>
          </table>

          <h4>记录明细</h4>
          <div class="bar">
            <select v-model="syncKindFilter" @change="onSyncKindChange">
              <option value="">全部类型</option>
              <option v-for="k in kindOptions" :key="k" :value="k">{{ k }}</option>
            </select>
          </div>
          <table class="table">
            <thead><tr><th>数据类型</th><th>记录 ID</th><th>版本</th><th>密文大小</th><th>最近变更</th></tr></thead>
            <tbody>
              <tr v-for="r in syncRecords" :key="r.recordId">
                <td>{{ r.entityKind ?? '（未标注）' }}</td>
                <td class="mono rec-id" :title="r.recordId">{{ r.recordId.slice(0, 16) }}…</td>
                <td>{{ r.version }}</td>
                <td>{{ fmtBytes(r.bytes) }}</td>
                <td>{{ formatDateTime(r.updateTime) }}</td>
              </tr>
              <tr v-if="syncRecords.length === 0"><td colspan="5" class="muted">暂无记录。</td></tr>
            </tbody>
          </table>
          <p v-if="syncRecordsCursor" class="load-more"><button class="btn secondary" @click="loadMoreSyncRecords">加载更多</button></p>
        </template>
      </div>

      <!-- 操作记录 -->
      <div v-if="tab === 'audit'">
        <p class="muted">该用户作为操作者产生的记录（管理员对该用户的操作请在审计页按对象查询）。</p>
        <p class="muted" v-if="auditState === 'loading'">加载中…</p>
        <p class="error" v-if="auditState === 'error'">{{ auditError }}</p>
        <table v-if="auditState === 'ready'" class="table">
          <thead><tr><th>时间</th><th>操作</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="e in auditEvents" :key="e.eventId">
              <td>{{ formatDateTime(e.eventTime) }}</td>
              <td :title="e.eventType">{{ auditEventLabel(e.eventType) }}</td>
              <td><span class="badge" :class="e.result === 'success' ? 'ok' : 'danger'">{{ e.result === 'success' ? '成功' : '失败' }}</span></td>
            </tr>
            <tr v-if="auditEvents.length === 0"><td colspan="3" class="muted">暂无操作记录。</td></tr>
          </tbody>
        </table>
        <p v-if="auditCursor" class="load-more"><button class="btn secondary" @click="loadAudit(false)">加载更多</button></p>
      </div>

      <!-- 状态弹窗 -->
      <Modal v-if="statusForm" :title="statusForm.status === 'disabled' ? '禁用账号' : '启用账号'" :closable="!busy" @close="statusForm = null">
        <FormField label="操作原因" required hint="必填，会记录到审计日志。">
          <input v-model="statusReason" type="text" maxlength="500" placeholder="例如：客服工单 #123" />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="modal-actions">
          <button class="btn" :class="{ danger: statusForm.status === 'disabled' }" :disabled="busy" @click="confirmStatus">确认{{ statusForm.status === 'disabled' ? '禁用' : '启用' }}</button>
          <button class="btn secondary" :disabled="busy" @click="statusForm = null">取消</button>
        </div>
      </Modal>

      <!-- 订阅弹窗 -->
      <Modal v-if="subForm" title="调整订阅" :closable="!busy" @close="subForm = false">
        <FormField label="目标套餐" required>
          <select v-model="subPlan">
            <option v-for="p in activePlanOptions" :key="p.code" :value="p.code">{{ p.name }}（{{ p.code }}）</option>
          </select>
        </FormField>
        <FormField label="订阅到期时间" hint="可选；留空表示不设置到期时间。">
          <input v-model="subPeriodEnd" type="datetime-local" />
        </FormField>
        <FormField label="操作原因" required hint="必填，会记录到审计日志。">
          <input v-model="subReason" type="text" maxlength="500" placeholder="例如：活动赠送一个月" />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="modal-actions">
          <button class="btn" :disabled="busy" @click="confirmSub">保存</button>
          <button class="btn secondary" :disabled="busy" @click="subForm = false">取消</button>
        </div>
      </Modal>

      <!-- 角色弹窗 -->
      <Modal v-if="roleForm" :title="roleForm.role === 'platform_admin' ? '设为管理员' : '撤销管理员'" :closable="!busy" @close="roleForm = null">
        <p class="muted">{{ roleForm.role === 'platform_admin' ? '该用户将获得平台后台的全部权限。' : '该用户将失去平台后台权限。' }}</p>
        <FormField label="操作原因" required hint="必填，会记录到审计日志。">
          <input v-model="roleReason" type="text" maxlength="500" placeholder="例如：内部运营人员" />
        </FormField>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="modal-actions">
          <button class="btn" :class="{ danger: roleForm.role !== 'platform_admin' }" :disabled="busy" @click="confirmRole">确认</button>
          <button class="btn secondary" :disabled="busy" @click="roleForm = null">取消</button>
        </div>
      </Modal>
    </template>
  </section>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: var(--sp-4); flex-wrap: wrap; }
.head h2 { font-size: 20px; font-weight: 700; margin: 2px 0 4px; letter-spacing: -0.01em; word-break: break-all; }
.head .sub { margin: 0; font-size: 13px; color: var(--c-text-muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.back { font-size: 13px; color: var(--c-text-muted); text-decoration: none; }
.back:hover { color: var(--c-accent); }
.head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.kv { border-collapse: collapse; width: 100%; }
.kv th { width: 120px; text-align: left; padding: 8px 12px; color: var(--c-text-muted); font-weight: 500; font-size: 13px; vertical-align: top; }
.kv td { padding: 8px 12px; font-size: 13.5px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 16px 0; }
.stat { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-md); padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
.stat-label { font-size: 12px; color: var(--c-text-muted); }
.stat-value { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
.quota-note { font-size: 13px; color: var(--c-text); margin: 8px 0 16px; }
.privacy-note { font-size: 12.5px; color: var(--c-text-muted); background: var(--c-surface-muted); border-radius: var(--r-sm); padding: 8px 12px; }
.rec-id { font-size: 12px; }
h4 { margin: 20px 0 8px; }
.bar { margin-bottom: 12px; }
</style>
