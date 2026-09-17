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
import { navigate, withBase } from '../lib/router';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { formatDateTime } from '../lib/formatTime';
import Modal from '../components/Modal.vue';

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
const memberConfirm = ref<Member | null>(null);
const closeConfirm = ref(false);
const leaveConfirm = ref(false);

const renameWrite = useIdempotencyKey();
const closeWrite = useIdempotencyKey();
const leaveWrite = useIdempotencyKey();
const memberWrite = useIdempotencyKey();
const inviteWrite = useIdempotencyKey();

const isAdmin = (): boolean => org.value?.role === 'admin';

let loadSeq = 0;

function relogin(): void {
  setAccessToken(null);
  window.location.assign(withBase('/login'));
}

function invalidContext(): void {
  navigate('/console/organizations');
}

async function load(): Promise<void> {
  const seq = ++loadSeq;
  const id = props.organizationId;
  state.value = 'loading';
  error.value = '';
  // 切组织/重载时先清空旧组织数据，避免前一个组织的成员/邀请串到新组织页面。
  org.value = null;
  members.value = [];
  invitations.value = [];
  const o = await getOrganization(id);
  if (seq !== loadSeq || props.organizationId !== id) return;
  if (o.kind !== 'ok') {
    if (o.kind === 'unauthorized') return relogin();
    if (o.kind === 'forbidden' || o.kind === 'not-found') return invalidContext();
    state.value = 'error';
    return;
  }
  org.value = o.value;
  const m = await listMembers(id);
  if (seq !== loadSeq || props.organizationId !== id) return;
  if (m.kind !== 'ok') {
    if (m.kind === 'unauthorized') return relogin();
    if (m.kind === 'forbidden' || m.kind === 'not-found') return invalidContext();
    state.value = 'error';
    return;
  }
  members.value = m.value;
  if (isAdmin()) {
    const inv = await listInvitations(id);
    if (seq !== loadSeq || props.organizationId !== id) return;
    if (inv.kind !== 'ok') {
      if (inv.kind === 'unauthorized') return relogin();
      if (inv.kind === 'forbidden' || inv.kind === 'not-found') return invalidContext();
      error.value = '邀请列表加载失败，请刷新重试。';
    } else {
      invitations.value = inv.value;
    }
  }
  state.value = 'ready';
}

onMounted(load);

watch(() => props.organizationId, () => {
  // 组织切换时立刻关闭一切待确认的对话框/表单：这些控件绑定的操作函数在触发时
  // 才读取 props.organizationId，若路由切换发生在「打开确认框」与「点击确认」
  // 之间，用户看着 A 组织的确认文案，点下去却会作用于此刻已成为当前路由的 B 组织。
  renameMode.value = false;
  closeConfirm.value = false;
  leaveConfirm.value = false;
  memberConfirm.value = null;
  inviteEmail.value = '';
  error.value = '';
  void load();
});

async function saveRename(): Promise<void> {
  if (busy.value || !renameValue.value.trim()) return;
  const value = renameValue.value.trim();
  const id = props.organizationId;
  const tag = `rename:${value}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await updateOrganization(id, value, renameWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      renameWrite.reset(tag);
      renameMode.value = false;
      if (props.organizationId === id) await load();
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
  const id = props.organizationId;
  const tag = 'close';
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await closeOrganization(id, closeWrite.ensure(tag), csrf);
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
  const id = props.organizationId;
  const tag = 'leave';
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await leaveOrganization(id, leaveWrite.ensure(tag), csrf);
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
  const id = props.organizationId;
  const tag = `role:${m.membershipId}:${role}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await assignRole(id, m.membershipId, role, memberWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      memberWrite.reset(tag);
      if (props.organizationId === id) await load();
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

async function doRemove(m: Member | null): Promise<void> {
  if (!m || busy.value) return;
  const id = props.organizationId;
  const tag = `remove:${m.membershipId}`;
  busy.value = true;
  memberConfirm.value = null;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await removeMember(id, m.membershipId, memberWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      memberWrite.reset(tag);
      if (props.organizationId === id) await load();
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
  const id = props.organizationId;
  const tag = `invite:${email}:${inviteRole.value}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await inviteMember(id, email, inviteRole.value, inviteWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      inviteWrite.reset(tag);
      inviteEmail.value = '';
      if (props.organizationId === id) await load();
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
  const id = props.organizationId;
  const tag = `revoke:${inv.invitationId}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await revokeInvitation(id, inv.invitationId, memberWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      memberWrite.reset(tag);
      if (props.organizationId === id) await load();
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
          <button class="btn danger" @click="closeConfirm = true; error = ''">关闭组织</button>
        </div>
        <div v-else>
          <button class="btn secondary" @click="leaveConfirm = true; error = ''">退出组织</button>
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
              <button v-if="m.role === 'member'" class="btn secondary" :disabled="busy" @click="changeRole(m, 'admin')">设为管理员</button>
              <button v-else class="btn secondary" :disabled="busy" @click="changeRole(m, 'member')">降为成员</button>
              <button class="btn secondary" @click="memberConfirm = m; error = ''">移除</button>
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
              <span class="muted">{{ inv.role }} · 过期 {{ formatDateTime(inv.expiresTime) }}</span>
            </div>
            <button class="btn secondary" :disabled="busy" @click="revoke(inv)">撤销</button>
          </li>
        </ul>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
    </template>

    <Modal v-if="closeConfirm" title="关闭组织" :closable="!busy" @close="closeConfirm = false">
      <p class="muted">确认关闭「{{ org?.name }}」？关闭后成员将无法访问。</p>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn danger" :disabled="busy" @click="closeOrg">确认关闭</button>
        <button class="btn secondary" :disabled="busy" @click="closeConfirm = false">取消</button>
      </div>
    </Modal>

    <Modal v-if="leaveConfirm" title="退出组织" :closable="!busy" @close="leaveConfirm = false">
      <p class="muted">确认退出「{{ org?.name }}」？退出后将失去组织资源的访问权限。</p>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn danger" :disabled="busy" @click="leaveOrg">确认退出</button>
        <button class="btn secondary" :disabled="busy" @click="leaveConfirm = false">取消</button>
      </div>
    </Modal>

    <Modal v-if="memberConfirm" title="移除成员" :closable="!busy" @close="memberConfirm = null">
      <p class="muted">确认移除「{{ memberConfirm.displayName || memberConfirm.email || '该成员' }}」？</p>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn danger" :disabled="busy" @click="doRemove(memberConfirm)">移除</button>
        <button class="btn secondary" :disabled="busy" @click="memberConfirm = null">取消</button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.page { max-width: 680px; margin: 0 auto; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
h2 { font-size: 20px; font-weight: 700; color: var(--c-text); margin: 0 0 4px; }
h3 { font-size: 15px; font-weight: 600; color: var(--c-text); margin: 0 0 12px; }
.card { background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.list { list-style: none; padding: 0; margin: 0; }
.item { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eaeef2; }
.item:last-child { border-bottom: none; }
.meta { display: flex; flex-direction: column; gap: 2px; }
.mem-actions { display: flex; gap: 8px; }
.invite { display: flex; gap: 8px; margin-bottom: 12px; }
.gap { margin: 0 8px; }
.back { color: var(--c-accent); font-size: 13px; cursor: pointer; }
input, select { box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--c-border-strong); border-radius: 6px; font-size: 14px; }
input { flex: 1; }
.btn { background: var(--c-accent); color: var(--c-surface); border: none; padding: 7px 14px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.danger { background: var(--c-danger); }
.btn.secondary { background: var(--c-surface-muted); color: var(--c-text); border: 1px solid var(--c-border-strong); }
.link { background: none; border: none; color: var(--c-accent); cursor: pointer; padding: 0; }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
</style>