<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { listOrganizations, adjustOrganizationSubscription, type AdminOrganization } from '../api/admin';
import { ensureCsrf, setAccessToken } from '../api/consoleAuth';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import AdminNav from './AdminNav.vue';

const orgs = ref<AdminOrganization[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const namePrefix = ref('');
const nextCursor = ref<string | null>(null);

const subWrite = useIdempotencyKey();
const subForm = ref<AdminOrganization | null>(null);
const subPlan = ref('organization_free');
const seatLimit = ref(3);
const subReason = ref('');
const busy = ref(false);

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

async function load(reset = true): Promise<void> {
  state.value = 'loading';
  const r = await listOrganizations({ namePrefix: namePrefix.value || undefined, cursor: reset ? undefined : (nextCursor.value ?? undefined) });
  if (r.kind === 'ok') {
    orgs.value = reset ? r.value.items : [...orgs.value, ...r.value.items];
    nextCursor.value = r.value.nextCursor;
    state.value = 'ready';
  } else if (r.kind === 'unauthorized') relogin();
  else state.value = 'error';
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
}

async function confirmSub(): Promise<void> {
  if (!subForm.value || busy.value) return;
  const o = subForm.value;
  const reasonValue = subReason.value.trim();
  // tag 纳入套餐/席位/原因/到期/版本：改任一输入即新意图 → 新 key。
  const tag = `sub:${o.organizationId}:${subPlan.value}:${seatLimit.value}:${reasonValue}:${o.subscriptionVersion ?? 0}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await adjustOrganizationSubscription(o.organizationId, {
      planCode: subPlan.value,
      seatLimit: seatLimit.value,
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
    <h2>组织</h2>

    <div class="bar">
      <input v-model="namePrefix" type="text" placeholder="按名称前缀过滤" @keyup.enter="search" />
      <button class="btn" @click="search">搜索</button>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败。</p>
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
          <td><button class="btn small secondary" @click="openSub(o)">订阅</button></td>
        </tr>
        <tr v-if="orgs.length === 0"><td colspan="6" class="muted">无匹配组织。</td></tr>
      </tbody>
    </table>

    <div v-if="subForm" class="form">
      <strong>调整订阅：{{ subForm.name }}</strong>
      <select v-model="subPlan">
        <option value="organization_free">Organization Free（免费）</option>
        <option value="organization_team">Organization Team（团队版）</option>
      </select>
      <input v-model.number="seatLimit" type="number" min="1" placeholder="席位" />
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
input, select { box-sizing: border-box; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
.table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eaeef2; font-size: 14px; }
.btn { background: #0969da; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.small { padding: 5px 10px; font-size: 13px; }
.btn.secondary { background: #f6f8fa; color: #24292f; border: 1px solid #d0d7de; }
.form { margin: 16px 0; padding: 16px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.muted { color: #57606a; font-size: 13px; }
.error { color: #cf222e; font-size: 13px; }
.load-more { margin: 16px 0; }
</style>