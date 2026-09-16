<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { listOrganizations, adjustOrganizationSubscription, type AdminOrganization } from '../api/admin';
import { ensureCsrf, setAccessToken } from '../api/consoleAuth';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import AdminNav from './AdminNav.vue';
import Modal from '../components/Modal.vue';

const orgs = ref<AdminOrganization[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const loadError = ref('');
const namePrefix = ref('');
const statusFilter = ref('');
const planCodeFilter = ref('');
const nextCursor = ref<string | null>(null);

const subWrite = useIdempotencyKey();
const subForm = ref<AdminOrganization | null>(null);
const subPlan = ref('organization_free');
const seatLimit = ref(3);
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
    const r = await listOrganizations({
      namePrefix: namePrefix.value || undefined,
      status: (statusFilter.value || undefined) as 'active' | 'closed' | undefined,
      planCode: planCodeFilter.value || undefined,
      cursor: reset ? undefined : (nextCursor.value ?? undefined),
    });
    if (seq !== loadSeq) return;
    if (r.kind === 'ok') {
      orgs.value = reset ? r.value.items : [...orgs.value, ...r.value.items];
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
  orgs.value = [];
  nextCursor.value = null;
  void load(true);
}

function openSub(o: AdminOrganization): void {
  subForm.value = o;
  subPlan.value = o.planCode ?? 'organization_free';
  seatLimit.value = o.seatLimit ?? 3;
  subReason.value = '';
  error.value = '';
}

async function confirmSub(): Promise<void> {
  if (!subForm.value || busy.value) return;
  const o = subForm.value;
  const reasonValue = subReason.value.trim();
  if (!reasonValue) {
    error.value = '请填写操作原因。';
    return;
  }
  const seats = seatLimit.value;
  if (!Number.isInteger(seats) || seats < 1) {
    error.value = '席位必须为正整数。';
    return;
  }
  const tag = `sub:${o.organizationId}:${subPlan.value}:${seats}:${reasonValue}:${o.subscriptionVersion ?? 0}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await adjustOrganizationSubscription(o.organizationId, {
      planCode: subPlan.value,
      seatLimit: seats,
      periodEndTime: null,
      reason: reasonValue,
      expectedVersion: o.subscriptionVersion ?? 0,
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
    <AdminNav />
    <h2>组织</h2>

    <div class="bar">
      <input v-model="namePrefix" type="text" placeholder="名称前缀" @keyup.enter="search" />
      <select v-model="statusFilter">
        <option value="">全部状态</option>
        <option value="active">运行中</option>
        <option value="closed">已关闭</option>
      </select>
      <select v-model="planCodeFilter">
        <option value="">全部套餐</option>
        <option value="organization_free">Organization Free</option>
        <option value="organization_team">Organization Team</option>
      </select>
      <button class="btn" @click="search">搜索</button>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">{{ loadError || '加载失败。' }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <table v-if="state === 'ready'" class="table">
      <thead>
        <tr><th>名称</th><th>状态</th><th>套餐</th><th>席位</th><th>成员/邀请</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="o in orgs" :key="o.organizationId">
          <td>{{ o.name }}</td>
          <td>{{ o.status }}</td>
          <td>{{ o.planCode ?? '—' }} <span v-if="o.subscriptionVersion != null" class="muted">v{{ o.subscriptionVersion }}</span></td>
          <td>{{ o.seatLimit ?? '不限' }}</td>
          <td>{{ o.activeMemberCount }} / {{ o.invitedCount }}</td>
          <td><button class="btn small secondary" :disabled="busy" @click="openSub(o)">订阅</button></td>
        </tr>
        <tr v-if="orgs.length === 0"><td colspan="6" class="muted">无匹配组织。</td></tr>
      </tbody>
    </table>

    <p v-if="nextCursor" class="load-more"><button class="btn secondary" @click="load(false)">加载更多</button></p>

    <Modal v-if="subForm" title="调整订阅" :closable="!busy" @close="subForm = null">
      <p class="muted">{{ subForm.name }}</p>
      <select v-model="subPlan">
        <option value="organization_free">Organization Free（免费）</option>
        <option value="organization_team">Organization Team（团队版）</option>
      </select>
      <input v-model.number="seatLimit" type="number" min="1" placeholder="席位" />
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
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
.load-more { margin: 16px 0; }
</style>