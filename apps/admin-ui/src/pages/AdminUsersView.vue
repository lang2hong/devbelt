<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase, navigate } from '../lib/router';
import { listUsers, listPlans, setUserStatus, type AdminUser } from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { toFromIso, toInclusiveEndIso } from '../lib/dateRange';
import Modal from '../components/Modal.vue';
import FormField from '../components/FormField.vue';

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
type PlanOption = { code: string; name: string };
const planOptions = ref<PlanOption[]>([
  { code: 'free', name: 'Free' },
  { code: 'pro', name: 'Pro' },
]);

const statusWrite = useIdempotencyKey();
const statusForm = ref<{ userId: string; status: 'active' | 'disabled' } | null>(null);
const reason = ref('');
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

onMounted(() => {
  void load();
  void loadPlanOptions();
});

async function loadPlanOptions(): Promise<void> {
  const r = await listPlans();
  if (r.kind === 'ok' && r.value.items.length > 0) {
    planOptions.value = r.value.items.map((p) => ({ code: p.code, name: p.name }));
  }
}

function search(): void {
  users.value = [];
  nextCursor.value = null;
  void load(true);
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

function openDetail(u: AdminUser): void {
  navigate(`/users/${u.userId}`);
}
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>用户</h2>
      <p class="sub">平台用户列表。点邮箱查看单个用户的完整档案（订阅、订单、AI 用量、同步数据）。</p>
    </header>

    <div class="bar">
      <input v-model="emailExact" type="email" placeholder="邮箱（精确匹配）" @keyup.enter="search" />
      <input v-model="userIdFilter" type="text" placeholder="用户ID" @keyup.enter="search" />
      <select v-model="statusFilter">
        <option value="">全部状态</option>
        <option value="active">启用</option>
        <option value="disabled">禁用</option>
      </select>
      <select v-model="planCodeFilter">
        <option value="">全部套餐</option>
        <option v-for="p in planOptions" :key="p.code" :value="p.code">{{ p.name }}（{{ p.code }}）</option>
      </select>
      <label class="range">注册时间
        <input v-model="createdFrom" type="datetime-local" />
        至
        <input v-model="createdTo" type="datetime-local" />
      </label>
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
          <td><a class="email-link" :href="withBase(`/users/${u.userId}`)" @click.prevent="openDetail(u)">{{ u.email }}</a></td>
          <td><span class="badge" :class="u.status === 'active' ? 'ok' : 'danger'">{{ u.status === 'active' ? '启用' : '禁用' }}</span></td>
          <td><span class="badge" :class="u.role === 'platform_admin' ? 'warn' : ''">{{ u.role === 'platform_admin' ? '管理员' : '用户' }}</span></td>
          <td>{{ u.planCode ?? '—' }} <span v-if="u.subscriptionVersion != null" class="muted">v{{ u.subscriptionVersion }}</span></td>
          <td>{{ u.deviceCount }}</td>
          <td class="actions">
            <button class="btn small secondary" :disabled="busy" @click="openDetail(u)">详情</button>
            <button v-if="u.status === 'active'" class="btn small danger" :disabled="busy" @click="openStatus(u, 'disabled')">禁用</button>
            <button v-else class="btn small" :disabled="busy" @click="openStatus(u, 'active')">启用</button>
          </td>
        </tr>
        <tr v-if="users.length === 0"><td colspan="6" class="muted">无匹配用户。</td></tr>
      </tbody>
    </table>

    <p v-if="nextCursor" class="load-more"><button class="btn secondary" @click="load(false)">加载更多</button></p>

    <Modal v-if="statusForm" :title="statusForm.status === 'disabled' ? '禁用账号' : '启用账号'" :closable="!busy" @close="statusForm = null">
      <FormField label="操作原因" required hint="必填，会记录到审计日志。">
        <input v-model="reason" type="text" maxlength="500" placeholder="例如：客服工单 #123" />
      </FormField>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :class="{ danger: statusForm.status === 'disabled' }" :disabled="busy" @click="confirmStatus">确认</button>
        <button class="btn secondary" :disabled="busy" @click="statusForm = null">取消</button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.email-link { color: var(--c-accent); text-decoration: none; }
.email-link:hover { text-decoration: underline; }
.range { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text-muted); }
</style>
