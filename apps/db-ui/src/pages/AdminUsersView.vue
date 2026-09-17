<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase } from '../lib/router';
import { listUsers, setUserStatus, adjustUserSubscription, type AdminUser } from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devkit/auth-client';
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
const reason = ref('');
const subForm = ref<AdminUser | null>(null);
const subPlan = ref('free');
const subReason = ref('');
const busy = ref(false);

let loadSeq = 0;
let paging = false;

function relogin(): void {
  setAccessToken(null);
  window.location.assign(withBase('/login'));
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
          <td>{{ u.status }}</td>
          <td>{{ u.role }}</td>
          <td>{{ u.planCode ?? '—' }} <span v-if="u.subscriptionVersion != null" class="muted">v{{ u.subscriptionVersion }}</span></td>
          <td>{{ u.deviceCount }}</td>
          <td class="actions">
            <button v-if="u.status === 'active'" class="btn small danger" :disabled="busy" @click="openStatus(u, 'disabled')">禁用</button>
            <button v-else class="btn small" :disabled="busy" @click="openStatus(u, 'active')">启用</button>
            <button class="btn small secondary" :disabled="busy" @click="openSub(u)">订阅</button>
          </td>
        </tr>
        <tr v-if="users.length === 0"><td colspan="6" class="muted">无匹配用户。</td></tr>
      </tbody>
    </table>

    <p v-if="nextCursor" class="load-more"><button class="btn secondary" @click="load(false)">加载更多</button></p>

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
  </section>
</template>

<style scoped>
.page { max-width: 960px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: var(--c-text); }
.bar { display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
input, select { box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--c-border-strong); border-radius: 6px; font-size: 14px; }
.table { width: 100%; border-collapse: collapse; background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eaeef2; font-size: 14px; }
.btn { background: var(--c-accent); color: var(--c-surface); border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.small { padding: 5px 10px; font-size: 13px; }
.btn.secondary { background: var(--c-surface-muted); color: var(--c-text); border: 1px solid var(--c-border-strong); }
.btn.danger { background: var(--c-danger); }
.actions { display: flex; gap: 6px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
.load-more { margin: 16px 0; }
.head { margin-bottom: 16px; }
.head h2 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--c-text-muted); }
</style>