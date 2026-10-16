<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase } from '../lib/router';
import { listUsers, setUserRole, setUserStatus, adjustUserSubscription, getSyncOverview, getAdminAiQuota, type AdminAiQuota, type AdminUser, type AdminSyncKindOverview } from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { toFromIso, toInclusiveEndIso } from '../lib/dateRange';
import Modal from '../components/Modal.vue';

const users = ref<AdminUser[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const loadError = ref('');
const emailExact = ref('');
const userIdFilter = ref('');
const statusFilter = ref('');
const planCodeFilter = ref('');
const createdFrom = ref('');
const createdTo = ref('');
const nextCursor = ref<string | null>(null);

const statusWrite = useIdempotencyKey();
const subWrite = useIdempotencyKey();

const statusForm = ref<{ userId: string; status: 'active' | 'disabled' } | null>(null);
const syncFor = ref<AdminUser | null>(null);
const syncRows = ref<AdminSyncKindOverview[]>([]);
const aiFor = ref<AdminUser | null>(null);
const aiQuota = ref<AdminAiQuota | null>(null);
const aiBusy = ref(false);

async function openAi(u: AdminUser): Promise<void> {
  aiFor.value = u;
  aiQuota.value = null;
  const r = await getAdminAiQuota(Number(u.userId));
  if (r.kind === 'ok') aiQuota.value = r.value;
  else if (r.kind === 'unauthorized') relogin();
  else aiBusy.value = false;
}

/** 点击菜单项后收起原生 details 下拉。 */
function closeMenu(e: Event): void {
  (e.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n.toLocaleString();
}

function fmtCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}
const syncBusy = ref(false);
const syncError = ref('');
const reason = ref('');
const subForm = ref<AdminUser | null>(null);
const subPlan = ref('free');
const subReason = ref('');
const busy = ref(false);

let loadSeq = 0;
let paging = false;

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

function serverMsg(r: { message?: string; code?: string }): string {
  return r.message || r.code || '操作失败，请重试。';
}

async function load(reset = true): Promise<void> {
if (!reset && paging) return;
    const seq = ++loadSeq;
    if (reset) paging = false;
    else paging = true;
  try {
    state.value = 'loading';
    loadError.value = '';
    const rawUserId = userIdFilter.value.trim();
    if (rawUserId) {
      const uidNum = Number(rawUserId);
      if (!/^[0-9]+$/.test(rawUserId) || !Number.isSafeInteger(uidNum) || uidNum <= 0) {
        state.value = 'error';
        loadError.value = '用户 ID 必须为正整数。';
        return;
      }
    }
    const r = await listUsers({
      emailExact: emailExact.value || undefined,
      userId: rawUserId || undefined,
      status: (statusFilter.value || undefined) as 'active' | 'disabled' | undefined,
      planCode: planCodeFilter.value || undefined,
      createdFrom: toFromIso(createdFrom.value),
      createdTo: toInclusiveEndIso(createdTo.value),
      cursor: reset ? undefined : (nextCursor.value ?? undefined),
    });
    if (seq !== loadSeq) return;
    if (r.kind === 'ok') {
      users.value = reset ? r.value.items : [...users.value, ...r.value.items];
      nextCursor.value = r.value.nextCursor;
      state.value = 'ready';
    } else if (r.kind === 'unauthorized') relogin();
    else {
      state.value = 'error';
      loadError.value = r.kind === 'failure' ? serverMsg(r) : '加载失败。';
    }
  } finally {
    if (!reset) paging = false;
  }
}

onMounted(() => load());

function search(): void {
  users.value = [];
  nextCursor.value = null;
  void load(true);
}

const roleForm = ref<{ user: AdminUser; role: 'user' | 'platform_admin' } | null>(null);
const roleReason = ref('');

function openRole(u: AdminUser, role: 'user' | 'platform_admin'): void {
  roleForm.value = { user: u, role };
  roleReason.value = '';
  error.value = '';
}

async function confirmRole(): Promise<void> {
  const form = roleForm.value;
  if (!form || busy.value) return;
  const reasonValue = roleReason.value.trim();
  if (!reasonValue) {
    error.value = '请填写操作原因。';
    return;
  }
  const tag = `role:${form.user.userId}:${form.role}:${reasonValue}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await setUserRole(form.user.userId, form.role, reasonValue, statusWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      statusWrite.reset(tag);
      roleForm.value = null;
      await load(true);
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

function openStatus(u: AdminUser, status: 'active' | 'disabled'): void {
  statusForm.value = { userId: u.userId, status };
  reason.value = '';
  error.value = '';
}

async function confirmStatus(): Promise<void> {
  if (!statusForm.value || busy.value) return;
  const form = statusForm.value;
  const reasonValue = reason.value.trim();
  if (!reasonValue) {
    error.value = '请填写操作原因。';
    return;
  }
  const tag = `status:${form.userId}:${form.status}:${reasonValue}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await setUserStatus(form.userId, form.status, reasonValue, statusWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      statusWrite.reset(tag);
      statusForm.value = null;
      await load(true);
    } else if (r.kind === 'unauthorized') {
      statusWrite.reset(tag);
      relogin();
    } else if (isRetryableFailure(r.kind)) {
      error.value = serverMsg(r);
    } else {
      statusWrite.reset(tag);
      error.value = serverMsg(r);
    }
  } finally {
    busy.value = false;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function openSync(u: AdminUser): Promise<void> {
  syncFor.value = u;
  syncRows.value = [];
  syncError.value = '';
  syncBusy.value = true;
  try {
    const r = await getSyncOverview(u.userId);
    if (r.kind === 'ok') syncRows.value = r.value;
    else if (r.kind === 'unauthorized') relogin();
    else syncError.value = r.kind === 'failure' ? serverMsg(r) : '加载失败。';
  } finally {
    syncBusy.value = false;
  }
}

function openSub(u: AdminUser): void {
  subForm.value = u;
  subPlan.value = u.planCode ?? 'free';
  subReason.value = '';
  error.value = '';
}

async function confirmSub(): Promise<void> {
  if (!subForm.value || busy.value) return;
  const u = subForm.value;
  const reasonValue = subReason.value.trim();
  if (!reasonValue) {
    error.value = '请填写操作原因。';
    return;
  }
  const tag = `sub:${u.userId}:${subPlan.value}:${reasonValue}:${u.subscriptionVersion ?? 0}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await adjustUserSubscription(u.userId, {
      planCode: subPlan.value,
      periodEndTime: null,
      reason: reasonValue,
      expectedVersion: u.subscriptionVersion ?? 0,
    }, subWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      subWrite.reset(tag);
      subForm.value = null;
      await load(true);
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
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>用户</h2>
      <p class="sub">平台用户与订阅管理。</p>
    </header>

    <div class="bar">
      <input v-model="emailExact" type="email" placeholder="邮箱精确" @keyup.enter="search" />
      <input v-model="userIdFilter" type="text" placeholder="用户ID" @keyup.enter="search" />
      <select v-model="statusFilter">
        <option value="">全部状态</option>
        <option value="active">启用</option>
        <option value="disabled">禁用</option>
      </select>
      <select v-model="planCodeFilter">
        <option value="">全部套餐</option>
        <option value="free">Free</option>
        <option value="pro">Pro</option>
      </select>
      <input v-model="createdFrom" type="datetime-local" />
      <input v-model="createdTo" type="datetime-local" />
      <button class="btn" @click="search">搜索</button>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">{{ loadError || '加载失败。' }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <table v-if="state === 'ready'" class="table">
      <thead>
        <tr><th>邮箱</th><th>状态</th><th>角色</th><th>套餐</th><th>设备</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.userId">
          <td>{{ u.email }}</td>
          <td><span class="badge" :class="u.status === 'active' ? 'ok' : 'danger'">{{ u.status === 'active' ? '启用' : '禁用' }}</span></td>
          <td><span class="badge" :class="u.role === 'platform_admin' ? 'warn' : ''">{{ u.role === 'platform_admin' ? '管理员' : '用户' }}</span></td>
          <td>{{ u.planCode ?? '—' }} <span v-if="u.subscriptionVersion != null" class="muted">v{{ u.subscriptionVersion }}</span></td>
          <td>{{ u.deviceCount }}</td>
          <td class="actions">
            <button v-if="u.status === 'active'" class="btn small danger" :disabled="busy" @click="openStatus(u, 'disabled')">禁用</button>
            <button v-else class="btn small" :disabled="busy" @click="openStatus(u, 'active')">启用</button>
            <details class="menu">
              <summary class="btn small secondary">更多 ▾</summary>
              <div class="menu-list" @click="closeMenu">
                <button :disabled="busy" @click="openSub(u)">订阅</button>
                <button :disabled="busy" @click="openSync(u)">同步</button>
                <button :disabled="busy" @click="openAi(u)">AI 用量</button>
                <button v-if="u.role !== 'platform_admin'" :disabled="busy" @click="openRole(u, 'platform_admin')">设为管理员</button>
                <button v-else class="danger" :disabled="busy" @click="openRole(u, 'user')">撤销管理员</button>
              </div>
            </details>
          </td>
        </tr>
        <tr v-if="users.length === 0"><td colspan="6" class="muted">无匹配用户。</td></tr>
      </tbody>
    </table>

    <p v-if="nextCursor" class="load-more"><button class="btn secondary" @click="load(false)">加载更多</button></p>

    <Modal v-if="aiFor" :title="`AI 用量 · ${aiFor.email ?? aiFor.userId}`" :closable="!busy" @close="aiFor = null">
      <p v-if="!aiQuota" class="muted">加载中…</p>
      <template v-else>
        <h4>本月配额</h4>
        <p class="quota-summary">
          已用 {{ fmtTokens(aiQuota.snapshot.used) }} · 预占 {{ fmtTokens(aiQuota.snapshot.reserved) }} ·
          月剩余 {{ fmtTokens(aiQuota.snapshot.monthlyRemaining) }} · 加油包 {{ fmtTokens(aiQuota.snapshot.topupRemaining) }}
          <template v-if="aiQuota.snapshot.resetAt"> · 重置 {{ new Date(aiQuota.snapshot.resetAt).toLocaleDateString() }}</template>
        </p>
        <h4>加油包购买</h4>
        <p class="quota-summary">
          {{ aiQuota.topupOrders?.totalCount ?? 0 }} 笔 · 已支付 {{ aiQuota.topupOrders?.paidCount ?? 0 }} 笔（{{ fmtCents(aiQuota.topupOrders?.paidCents ?? 0) }}）<template v-if="aiQuota.topupOrders?.refundedCount"> · 退款 {{ aiQuota.topupOrders.refundedCount }} 笔</template><template v-if="aiQuota.topupOrders?.lastPaidTime"> · 最近 {{ new Date(aiQuota.topupOrders.lastPaidTime).toLocaleString() }}</template>
        </p>
        <h4>近月用量（计费 token）</h4>
        <table class="table">
          <thead><tr><th>月份</th><th>输入</th><th>输出</th><th>请求</th></tr></thead>
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
        <h4 v-if="(aiQuota.grants ?? []).length">加油包余额</h4>
        <table v-if="(aiQuota.grants ?? []).length" class="table">
          <thead><tr><th>档位</th><th>总量</th><th>已用</th><th>状态</th><th>过期</th></tr></thead>
          <tbody>
            <tr v-for="g in aiQuota.grants" :key="g.grantId">
              <td class="mono">{{ g.skuCode }}</td>
              <td>{{ fmtTokens(g.tokensTotal) }}</td>
              <td>{{ fmtTokens(g.tokensUsed) }}</td>
              <td>{{ g.status }}</td>
              <td>{{ new Date(g.expiresTime).toLocaleDateString() }}</td>
            </tr>
          </tbody>
        </table>
      </template>
      <div class="modal-actions">
        <button class="btn secondary" :disabled="busy" @click="aiFor = null">关闭</button>
      </div>
    </Modal>

    <Modal v-if="roleForm" :title="roleForm.role === 'platform_admin' ? '授予管理员' : '撤销管理员'" :closable="!busy" @close="roleForm = null">
      <p class="muted">{{ roleForm.user.email ?? roleForm.user.userId }} · 当前角色 {{ roleForm.user.role }}</p>
      <input v-model="roleReason" type="text" maxlength="500" placeholder="原因（必填，进审计）" />
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :disabled="busy" @click="confirmRole">确认</button>
        <button class="btn secondary" :disabled="busy" @click="roleForm = null">取消</button>
      </div>
    </Modal>

    <Modal v-if="statusForm" :title="statusForm.status === 'disabled' ? '禁用用户' : '启用用户'" :closable="!busy" @close="statusForm = null">
      <input v-model="reason" type="text" maxlength="500" placeholder="原因（必填）" />
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :disabled="busy" @click="confirmStatus">确认</button>
        <button class="btn secondary" :disabled="busy" @click="statusForm = null">取消</button>
      </div>
    </Modal>

    <Modal v-if="subForm" title="调整订阅" :closable="!busy" @close="subForm = null">
      <p class="muted">{{ subForm.email }}</p>
      <select v-model="subPlan">
        <option value="free">Free（免费）</option>
        <option value="pro">Pro（¥99/月）</option>
      </select>
      <input v-model="subReason" type="text" maxlength="500" placeholder="原因（必填）" />
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :disabled="busy" @click="confirmSub">确认</button>
        <button class="btn secondary" :disabled="busy" @click="subForm = null">取消</button>
      </div>
    </Modal>

    <Modal v-if="syncFor" title="同步密文元数据（只读）" :closable="!syncBusy" @close="syncFor = null">
      <p class="muted">{{ syncFor.email }}</p>
      <p class="muted">内容端到端加密，后台不可见；以下仅为按类型的密文条数/字节。</p>
      <p v-if="syncBusy" class="muted">加载中…</p>
      <p v-else-if="syncError" class="error">{{ syncError }}</p>
      <table v-else class="table">
        <thead><tr><th>类型</th><th>条数</th><th>密文字节</th><th>最近更新</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in syncRows" :key="i">
            <td>{{ r.entityKind ?? '（无类型）' }}</td>
            <td>{{ r.count }}</td>
            <td>{{ fmtBytes(r.bytes) }}</td>
            <td>{{ r.lastActivityTime ? new Date(r.lastActivityTime).toLocaleString() : '—' }}</td>
          </tr>
          <tr v-if="syncRows.length === 0"><td colspan="4" class="muted">无同步记录。</td></tr>
        </tbody>
      </table>
    </Modal>
  </section>
</template>

<style scoped>
</style>