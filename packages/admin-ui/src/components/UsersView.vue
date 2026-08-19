<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '../lib/api';
import { fmt } from '../lib/format';
import type { UserRow, Plan } from '../types';
import UserDetailModal from './UserDetailModal.vue';

const users = ref<UserRow[]>([]);
const total = ref(0);
const planCodes = ref<string[]>([]);
const query = ref('');
const page = ref(1);
const PAGE_SIZE = 20;

const detailUserId = ref<number | null>(null);
const renewState = ref<{ id: number } | null>(null);
const renewPlan = ref('free');
const renewPeriod = ref('month');

async function load() {
  const [uR, pR] = await Promise.all([
    api<{ total: number; users: UserRow[] }>('/admin/users?limit=500&offset=0'),
    api<{ plans: Plan[] }>('/admin/plans'),
  ]);
  users.value = uR.users || [];
  total.value = uR.total || users.value.length;
  planCodes.value = (pR.plans || []).map((p) => p.code);
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return users.value;
  return users.value.filter(
    (u) => String(u.id).indexOf(q) >= 0 || (u.email || '').toLowerCase().indexOf(q) >= 0,
  );
});

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)));

const slice = computed(() => {
  const p = Math.min(page.value, totalPages.value);
  const start = (p - 1) * PAGE_SIZE;
  return filtered.value.slice(start, start + PAGE_SIZE);
});

function selValue(e: Event): string {
  return (e.target as HTMLSelectElement).value;
}

function onSearch() {
  page.value = 1;
}

function goPage(d: number) {
  page.value = Math.min(totalPages.value, Math.max(1, page.value + d));
}

/**
 * 需要二次确认的改动。
 *
 * 服务端已经拦掉了不可逆的自伤（自我降级 / 禁用自己 / 降级最后一个 admin），
 * 但下面这几种是**合法但影响很大**的操作，服务端不该拦、UI 该拦一下：
 *  - 提权到 admin：一个下拉框的误点就等于交出整个后台
 *  - 降级 admin / 禁用账号：立刻把对方踢出去
 * 每一次都会留痕（admin_audit_log），确认只是把"顺手点错"和"确实要做"分开。
 */
function confirmMessage(u: UserRow, field: string, value: string): string | null {
  if (field === 'role' && value === 'admin' && u.role !== 'admin') {
    return `Grant ADMIN to ${u.email}?\n\nThey will gain full access to this console, including the ability to change plans, revoke sessions and grant admin to others.`;
  }
  if (field === 'role' && value === 'user' && u.role === 'admin') {
    return `Remove admin from ${u.email}?\n\nThey will lose access to this console immediately.`;
  }
  if (field === 'status' && value === 'disabled' && u.status !== 'disabled') {
    return `Disable ${u.email}?\n\nThey will not be able to sign in until re-enabled.`;
  }
  return null;
}

async function updateUser(u: UserRow, field: string, value: string) {
  const ask = confirmMessage(u, field, value);
  // 取消时必须重载：<select> 的显示值已经被浏览器改掉了，不刷新会留下
  // 一个与服务端不一致的界面（看着像已经改了，其实没改）
  if (ask && !confirm(ask)) {
    await load();
    return;
  }
  try {
    const body: Record<string, string> = {};
    body[field] = value;
    await api('/admin/users/' + u.id, { method: 'PATCH', body });
  } catch (ex) {
    alert(ex instanceof Error ? ex.message : String(ex));
  }
  // 成功或失败都重载：失败时同样要把下拉框拨回服务端的真实值
  await load();
}

function planOptions(selected: string): string[] {
  return planCodes.value.length ? planCodes.value : ['free', 'pro', 'team'];
}

function openRenew(u: UserRow) {
  renewState.value = { id: u.id };
  renewPlan.value = u.planCode;
  renewPeriod.value = 'month';
}

async function submitRenew() {
  if (!renewState.value) return;
  try {
    await api('/admin/users/' + renewState.value.id + '/renew', {
      method: 'POST',
      body: { planCode: renewPlan.value, period: renewPeriod.value },
    });
    renewState.value = null;
    await load();
  } catch (ex) {
    alert(ex instanceof Error ? ex.message : String(ex));
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <input v-model="query" placeholder="Search by id / email…" @input="onSearch" />
      <span class="count">Total {{ total }} user(s)</span>
      <button class="btn" @click="load">Refresh</button>
    </div>

    <table>
      <thead>
        <tr>
          <th>ID</th><th>Email</th><th>Role</th><th>Status</th><th>Plan</th>
          <th>Subscription</th><th>Expires</th><th>Last login</th><th>Created</th><th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="slice.length === 0"><td colspan="10" class="muted">No users</td></tr>
        <tr v-for="u in slice" :key="u.id">
          <td>{{ u.id }}</td>
          <td>{{ u.email }}</td>
          <td>
            <select :value="u.role" @change="updateUser(u, 'role', selValue($event))">
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </td>
          <td>
            <select :value="u.status" @change="updateUser(u, 'status', selValue($event))">
              <option value="active">active</option>
              <option value="disabled">disabled</option>
            </select>
          </td>
          <td>
            <select :value="u.planCode" @change="updateUser(u, 'planCode', selValue($event))">
              <option v-for="c in planOptions(u.planCode)" :key="c" :value="c">{{ c }}</option>
            </select>
          </td>
          <td>
            <span v-if="u.subscription" class="badge" :class="u.subscription.status">{{ u.subscription.status }}</span>
            <span v-else class="muted">—</span>
          </td>
          <td>{{ fmt(u.subscription ? u.subscription.periodEndTime : null) }}</td>
          <td>{{ fmt(u.lastLoginTime) }}</td>
          <td>{{ fmt(u.createTime) }}</td>
          <td>
            <button class="btn" @click="detailUserId = u.id">Detail</button>
            <button class="btn primary" @click="openRenew(u)">Renew</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div class="pager">
      <span class="info">Page {{ Math.min(page, totalPages) }} / {{ totalPages }}</span>
      <button class="btn" :disabled="page <= 1" @click="goPage(-1)">Prev</button>
      <button class="btn" :disabled="page >= totalPages" @click="goPage(1)">Next</button>
    </div>

    <UserDetailModal v-if="detailUserId" :user-id="detailUserId" @close="detailUserId = null" />

    <div v-if="renewState" class="modal" @click.self="renewState = null">
      <div class="modal-body">
        <div class="modal-head">
          <h2>Renew</h2>
          <button class="modal-close" @click="renewState = null">&times;</button>
        </div>
        <p class="muted">Renew subscription for user #{{ renewState.id }}.</p>
        <div class="kv" style="margin: 12px 0">
          <span class="k">Plan</span>
          <select v-model="renewPlan">
            <option v-for="c in planCodes" :key="c" :value="c">{{ c }}</option>
          </select>
          <span class="k">Period</span>
          <select v-model="renewPeriod">
            <option value="month">month</option>
            <option value="year">year</option>
          </select>
        </div>
        <button class="btn primary" @click="submitRenew">Renew</button>
      </div>
    </div>
  </div>
</template>