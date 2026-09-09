<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import {
  getOrganization,
  updateOrganization,
  closeOrganization,
  leaveOrganization,
  listMembers,
  assignRole,
  removeMember,
  listInvitations,
  inviteMember,
  revokeInvitation,
  type OrgSummary,
  type Member,
  type Invitation,
} from '../api/organizations';
import { ensureCsrf, setAccessToken } from '../api/consoleAuth';
import { navigate } from '../lib/router';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';

const props = defineProps<{ organizationId: string }>();

const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const org = ref<OrgSummary | null>(null);
const members = ref<Member[]>([]);
const invitations = ref<Invitation[]>([]);

const renameMode = ref(false);
const renameValue = ref('');
const busy = ref(false);

const inviteEmail = ref('');
const inviteRole = ref<'admin' | 'member'>('member');
const memberConfirm = ref<string | null>(null);
const closeConfirm = ref(false);
const leaveConfirm = ref(false);

const renameWrite = useIdempotencyKey();
const closeWrite = useIdempotencyKey();
const leaveWrite = useIdempotencyKey();
const memberWrite = useIdempotencyKey();
const inviteWrite = useIdempotencyKey();

const isAdmin = (): boolean => org.value?.role === 'admin';

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

function invalidContext(): void {
  navigate('/console/organizations');
}

async function load(): Promise<void> {
  state.value = 'loading';
  const o = await getOrganization(props.organizationId);
  if (o.kind !== 'ok') {
    if (o.kind === 'unauthorized') return relogin();
    if (o.kind === 'forbidden' || o.kind === 'not-found') return invalidContext();
    state.value = 'error';
    return;
  }
  org.value = o.value;
  const m = await listMembers(props.organizationId);
  if (m.kind !== 'ok') {
    if (m.kind === 'unauthorized') return relogin();
    if (m.kind === 'forbidden' || m.kind === 'not-found') return invalidContext();
    state.value = 'error';
    return;
  }
  members.value = m.value;
  if (isAdmin()) {
    const inv = await listInvitations(props.organizationId);
    if (inv.kind === 'ok') invitations.value = inv.value;
  }
  state.value = 'ready';
}

onMounted(load);

watch(() => props.organizationId, () => {
  void load();
});

async function saveRename(): Promise<void> {
  if (busy.value || !renameValue.value.trim()) return;
  const value = renameValue.value.trim();
  const tag = `rename:${value}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await updateOrganization(props.organizationId, value, renameWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      renameWrite.reset(tag);
      renameMode.value = false;
      await load();
    } else if (r.kind === 'unauthorized') {
      renameWrite.reset(tag);
      relogin();
    } else if (r.kind === 'forbidden' || r.kind === 'not-found') {
      renameWrite.reset(tag);
      invalidContext();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '保存失败，请重试。';
    } else {
      renameWrite.reset(tag);
      error.value = '保存失败，请重试。';
    }
  } finally {
    busy.value = false;
  }
}

async function closeOrg(): Promise<void> {
  if (busy.value) return;
  const tag = 'close';
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await closeOrganization(props.organizationId, closeWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      closeWrite.reset(tag);
      navigate('/console/organizations');
    } else if (r.kind === 'unauthorized') {
      closeWrite.reset(tag);
      relogin();
    } else if (r.kind === 'forbidden' || r.kind === 'not-found') {
      closeWrite.reset(tag);
      invalidContext();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '关闭失败，请重试。';
    } else {
      closeWrite.reset(tag);
      error.value = '关闭失败，请重试。';
    }
  } finally {
    busy.value = false;
  }
}

async function leaveOrg(): Promise<void> {
  if (busy.value) return;
  const tag = 'leave';
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await leaveOrganization(props.organizationId, leaveWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      leaveWrite.reset(tag);
      navigate('/console/organizations');
    } else if (r.kind === 'unauthorized') {
      leaveWrite.reset(tag);
      relogin();
    } else if (r.kind === 'forbidden' || r.kind === 'not-found') {
      leaveWrite.reset(tag);
      invalidContext();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '退出失败，请重试。';
    } else {
      leaveWrite.reset(tag);
      error.value = '退出失败，请重试。';
    }
  } finally {
    busy.value = false;
  }
}

async function changeRole(m: Member, role: 'admin' | 'member'): Promise<void> {
  if (busy.value) return;
  const tag = `role:${m.membershipId}:${role}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await assignRole(props.organizationId, m.membershipId, role, memberWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      memberWrite.reset(tag);
      await load();
    } else if (r.kind === 'unauthorized') {
      memberWrite.reset(tag);
      relogin();
    } else if (r.kind === 'forbidden' || r.kind === 'not-found') {
      memberWrite.reset(tag);
      invalidContext();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '操作失败，请重试。';
    } else {
      memberWrite.reset(tag);
      error.value = '操作失败，请重试。';
    }
  } finally {
    busy.value = false;
  }
}

async function doRemove(m: Member): Promise<void> {
  if (busy.value) return;
  const tag = `remove:${m.membershipId}`;
  busy.value = true;
  memberConfirm.value = null;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await removeMember(props.organizationId, m.membershipId, memberWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      memberWrite.reset(tag);
      await load();
    } else if (r.kind === 'unauthorized') {
      memberWrite.reset(tag);
      relogin();
    } else if (r.kind === 'forbidden' || r.kind === 'not-found') {
      memberWrite.reset(tag);
      invalidContext();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '移除失败，请重试。';
    } else {
      memberWrite.reset(tag);
      error.value = '移除失败，请重试。';
    }
  } finally {
    busy.value = false;
  }
}

async function invite(): Promise<void> {
  if (busy.value || !inviteEmail.value.trim()) return;
  const email = inviteEmail.value.trim();
  const tag = `invite:${email}:${inviteRole.value}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await inviteMember(props.organizationId, email, inviteRole.value, inviteWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      inviteWrite.reset(tag);
      inviteEmail.value = '';
      await load();
    } else if (r.kind === 'unauthorized') {
      inviteWrite.reset(tag);
      relogin();
    } else if (r.kind === 'forbidden' || r.kind === 'not-found') {
      inviteWrite.reset(tag);
      invalidContext();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '邀请失败，请重试。';
    } else {
      inviteWrite.reset(tag);
      error.value = '邀请失败，请重试。';
    }
  } finally {
    busy.value = false;
  }
}

async function revoke(inv: Invitation): Promise<void> {
  if (busy.value) return;
  const tag = `revoke:${inv.invitationId}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await revokeInvitation(props.organizationId, inv.invitationId, memberWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      memberWrite.reset(tag);
      await load();
    } else if (r.kind === 'unauthorized') {
      memberWrite.reset(tag);
      relogin();
    } else if (r.kind === 'forbidden' || r.kind === 'not-found') {
      memberWrite.reset(tag);
      invalidContext();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '撤销失败，请重试。';
    } else {
      memberWrite.reset(tag);
      error.value = '撤销失败，请重试。';
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="page">
    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败。<button class="link" @click="load">重试</button></p>

    <template v-if="state === 'ready' && org">
      <header class="head">
        <div>
          <h2>{{ org.name }}</h2>
          <span class="muted">角色：{{ org.role }}</span>
          <span class="gap"></span>
          <a class="back" @click.prevent="navigate('/console/organizations/' + props.organizationId + '/resources')">资源</a>
        </div>
        <div v-if="isAdmin()" class="actions">
          <button v-if="!renameMode" class="btn secondary" @click="renameMode = true; renameValue = org.name">重命名</button>
          <template v-else>
            <input v-model="renameValue" type="text" maxlength="100" />
            <button class="btn" :disabled="busy" @click="saveRename">保存</button>
            <button class="btn secondary" @click="renameMode = false">取消</button>
          </template>
          <button v-if="!closeConfirm" class="btn danger" @click="closeConfirm = true">关闭组织</button>
          <template v-else>
            <span class="muted">确认关闭？</span>
            <button class="btn danger" :disabled="busy" @click="closeOrg">确认</button>
            <button class="btn secondary" @click="closeConfirm = false">取消</button>
          </template>
        </div>
        <div v-else>
          <button v-if="!leaveConfirm" class="btn secondary" @click="leaveConfirm = true">退出组织</button>
          <template v-else>
            <button class="btn danger" :disabled="busy" @click="leaveOrg">确认退出</button>
            <button class="btn secondary" @click="leaveConfirm = false">取消</button>
          </template>
        </div>
      </header>

      <div class="card">
        <h3>成员</h3>
        <ul class="list">
          <li v-for="m in members" :key="m.membershipId" class="item">
            <div class="meta">
              <strong>{{ m.displayName || '（未命名）' }}</strong>
              <span class="muted">{{ m.role }}<template v-if="m.email"> · {{ m.email }}</template></span>
            </div>
            <div v-if="isAdmin()" class="mem-actions">
              <template v-if="memberConfirm === m.membershipId">
                <button class="btn danger" :disabled="busy" @click="doRemove(m)">移除</button>
                <button class="btn secondary" @click="memberConfirm = null">取消</button>
              </template>
              <template v-else>
                <button v-if="m.role === 'member'" class="btn secondary" :disabled="busy" @click="changeRole(m, 'admin')">设为管理员</button>
                <button v-else class="btn secondary" :disabled="busy" @click="changeRole(m, 'member')">降为成员</button>
                <button class="btn secondary" @click="memberConfirm = m.membershipId">移除</button>
              </template>
            </div>
          </li>
        </ul>
      </div>

      <div v-if="isAdmin()" class="card">
        <h3>邀请</h3>
        <div class="invite">
          <input v-model="inviteEmail" type="email" placeholder="member@example.com" />
          <select v-model="inviteRole">
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
          <button class="btn" :disabled="busy" @click="invite">邀请</button>
        </div>
        <ul class="list">
          <li v-for="inv in invitations" :key="inv.invitationId" class="item">
            <div class="meta">
              <strong>{{ inv.email }}</strong>
              <span class="muted">{{ inv.role }} · 过期 {{ new Date(inv.expiresTime).toLocaleString() }}</span>
            </div>
            <button class="btn secondary" :disabled="busy" @click="revoke(inv)">撤销</button>
          </li>
        </ul>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
    </template>
  </section>
</template>

<style scoped>
.page { max-width: 680px; margin: 0 auto; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; margin: 0 0 4px; }
h3 { font-size: 15px; font-weight: 600; color: #0f172a; margin: 0 0 12px; }
.card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.list { list-style: none; padding: 0; margin: 0; }
.item { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eaeef2; }
.item:last-child { border-bottom: none; }
.meta { display: flex; flex-direction: column; gap: 2px; }
.mem-actions { display: flex; gap: 8px; }
.invite { display: flex; gap: 8px; margin-bottom: 12px; }
.gap { margin: 0 8px; }
.back { color: #0969da; font-size: 13px; cursor: pointer; }
input, select { box-sizing: border-box; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
input { flex: 1; }
.btn { background: #0969da; color: #fff; border: none; padding: 7px 14px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.danger { background: #cf222e; }
.btn.secondary { background: #f6f8fa; color: #24292f; border: 1px solid #d0d7de; }
.link { background: none; border: none; color: #0969da; cursor: pointer; padding: 0; }
.muted { color: #57606a; font-size: 13px; }
.error { color: #cf222e; font-size: 13px; }
</style>