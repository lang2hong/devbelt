<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { listUsers, setUserStatus, adjustUserSubscription, type AdminUser } from '../api/admin';
import { ensureCsrf, setAccessToken } from '../api/consoleAuth';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import AdminNav from './AdminNav.vue';

const users = ref<AdminUser[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const emailExact = ref('');
const nextCursor = ref<string | null>(null);

const statusWrite = useIdempotencyKey();
const subWrite = useIdempotencyKey();

// 禁/启用内联表单
const statusForm = ref<{ userId: string; status: 'active' | 'disabled' } | null>(null);
const reason = ref('');
// 订阅调整内联表单
const subForm = ref<AdminUser | null>(null);
const subPlan = ref('free');
const subReason = ref('');
const busy = ref(false);

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

async function load(reset = true): Promise<void> {
  state.value = 'loading';
  const r = await listUsers({ emailExact: emailExact.value || undefined, cursor: reset ? undefined : (nextCursor.value ?? undefined) });
  if (r.kind === 'ok') {
    users.value = reset ? r.value.items : [...users.value, ...r.value.items];
    nextCursor.value = r.value.nextCursor;
    state.value = 'ready';
  } else if (r.kind === 'unauthorized') relogin();
  else state.value = 'error';
}

onMounted(() => load());

async function search(): Promise<void> {
  users.value = [];
  nextCursor.value = null;
  await load(true);
}

function openStatus(u: AdminUser, status: 'active' | 'disabled'): void {
  statusForm.value = { userId: u.userId, status };
  reason.value = '';
}

async function confirmStatus(): Promise<void> {
  if (!statusForm.value || busy.value) return;
  const form = statusForm.value;
  const reasonValue = reason.value.trim();
  // tag 纳入可编辑字段：改原因即新意图 → 新 key；未改则复用旧 key。
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
      error.value = '操作失败，请重试。';
    } else {
      statusWrite.reset(tag);
      error.value = '操作失败，请重试。';
    }
  } finally {
    busy.value = false;
  }
}

function openSub(u: AdminUser): void {
  subForm.value = u;
  subPlan.value = u.planCode ?? 'free';
  subReason.value = '';
}

async function confirmSub(): Promise<void> {
  if (!subForm.value || busy.value) return;
  const u = subForm.value;
  const reasonValue = subReason.value.trim();
  // tag 纳入套餐/原因/到期/版本：改任一输入即新意图 → 新 key。
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
      error.value = '操作失败，请重试。';
    } else {
      subWrite.reset(tag);
      error.value = '操作失败，请重试。';
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="page">
    <AdminNav />
    <h2>用户</h2>

    <div class="bar">
      <input v-model="emailExact" type="email" placeholder="按邮箱精确搜索" @keyup.enter="search" />
      <button class="btn" @click="search">搜索</button>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败。</p>
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
            <button v-if="u.status === 'active'" class="btn small danger" @click="openStatus(u, 'disabled')">禁用</button>
            <button v-else class="btn small" @click="openStatus(u, 'active')">启用</button>
            <button class="btn small secondary" @click="openSub(u)">订阅</button>
          </td>
        </tr>
        <tr v-if="users.length === 0"><td colspan="6" class="muted">无匹配用户。</td></tr>
      </tbody>
    </table>

    <div v-if="statusForm" class="form">
      <strong>{{ statusForm.status === 'disabled' ? '禁用' : '启用' }}用户</strong>
      <input v-model="reason" type="text" maxlength="500" placeholder="原因（必填）" />
      <button class="btn" :disabled="busy" @click="confirmStatus">确认</button>
      <button class="btn secondary" @click="statusForm = null">取消</button>
    </div>

    <div v-if="subForm" class="form">
      <strong>调整订阅：{{ subForm.email }}</strong>
      <input v-model="subPlan" type="text" maxlength="32" placeholder="planCode" />
      <input v-model="subReason" type="text" maxlength="500" placeholder="原因（必填）" />
      <button class="btn" :disabled="busy" @click="confirmSub">确认</button>
      <button class="btn secondary" @click="subForm = null">取消</button>
    </div>

    <p v-if="nextCursor" class="load-more"><button class="btn secondary" @click="load(false)">加载更多</button></p>
  </section>
</template>

<style scoped>
.page { max-width: 900px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; }
.bar { display: flex; gap: 8px; margin: 16px 0; }
input { box-sizing: border-box; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
.table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eaeef2; font-size: 14px; }
.btn { background: #0969da; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.small { padding: 5px 10px; font-size: 13px; }
.btn.secondary { background: #f6f8fa; color: #24292f; border: 1px solid #d0d7de; }
.btn.danger { background: #cf222e; }
.actions { display: flex; gap: 6px; }
.form { margin: 16px 0; padding: 16px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.muted { color: #57606a; font-size: 13px; }
.error { color: #cf222e; font-size: 13px; }
.load-more { margin: 16px 0; }
</style>