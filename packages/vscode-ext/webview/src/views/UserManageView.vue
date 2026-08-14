<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

const { post, onMessage } = useVsCode();
const { t } = useI18n();

interface UserRow { name: string; host?: string }

const connLabel = ref('');
const privileges = ref<string[]>([]);
const databases = ref<string[]>([]);
/** MySQL 的用户是 name@host；PG 角色没有 host 概念，相关输入一并隐藏。 */
const supportsHost = ref(false);
const users = ref<UserRow[]>([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');

/** 当前选中的用户展示名（`name@host` 或 `name`）。 */
const selected = ref('');

/** 列表过滤词；空串表示不过滤。大小写不敏感，匹配 name 与 name@host。 */
const search = ref('');
const filteredUsers = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return users.value;
  return users.value.filter((u) => userLabel(u).toLowerCase().includes(q));
});

const newName = ref('');
const newPassword = ref('');
const newConfirm = ref('');
const newHost = ref('%');
const showCreate = ref(false);

const pwValue = ref('');
const showPassword = ref(false);

const checkedPrivs = ref<string[]>([]);
const grantDatabase = ref('');

/** 删除确认：记住待删对象，避免误点即执行。 */
const pendingDrop = ref('');

const userLabel = (u: UserRow): string => (u.host ? `${u.name}@${u.host}` : u.name);
const hasSelection = computed(() => !!selected.value);

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'init') {
      connLabel.value = msg.connLabel || '';
      privileges.value = Array.isArray(msg.privileges) ? msg.privileges : [];
      supportsHost.value = !!msg.supportsHost;
      return;
    }
    if (msg.type === 'users') {
      users.value = Array.isArray(msg.users) ? msg.users : [];
      databases.value = Array.isArray(msg.databases) ? msg.databases : [];
      if (!grantDatabase.value && databases.value.length) grantDatabase.value = databases.value[0];
      if (selected.value && !users.value.some((u) => userLabel(u) === selected.value)) selected.value = '';
      loading.value = false;
      error.value = '';
      return;
    }
    if (msg.type === 'done') {
      notice.value = msg.message || '';
      error.value = '';
      resetForms();
      return;
    }
    if (msg.type === 'error') {
      error.value = msg.message || '';
      loading.value = false;
    }
  });
  post({ type: 'ready' });
});

onUnmounted(() => cleanup?.());

function resetForms(): void {
  newName.value = '';
  newPassword.value = '';
  newConfirm.value = '';
  newHost.value = '%';
  showCreate.value = false;
  pwValue.value = '';
  showPassword.value = false;
  pendingDrop.value = '';
}

function refresh(): void {
  loading.value = true;
  notice.value = '';
  post({ type: 'refresh' });
}

function select(u: UserRow): void {
  selected.value = userLabel(u);
  notice.value = '';
  checkedPrivs.value = [];
  showPassword.value = false;
  pendingDrop.value = '';
}

function submitCreate(): void {
  error.value = '';
  if (!newName.value.trim()) { error.value = t('wv.userManage.errNameRequired'); return; }
  if (newPassword.value !== newConfirm.value) { error.value = t('wv.userManage.errPwMismatch'); return; }
  post({
    type: 'createUser',
    name: newName.value.trim(),
    password: newPassword.value,
    host: supportsHost.value ? (newHost.value || '%') : '%',
  });
}

function submitPassword(): void {
  error.value = '';
  if (!pwValue.value) { error.value = t('wv.userManage.errPwRequired'); return; }
  post({ type: 'changePassword', user: selected.value, password: pwValue.value });
}

function submitPrivileges(kind: 'grant' | 'revoke'): void {
  error.value = '';
  if (!checkedPrivs.value.length) { error.value = t('wv.userManage.errNoPriv'); return; }
  post({
    type: kind,
    user: selected.value,
    privileges: checkedPrivs.value,
    database: grantDatabase.value || undefined,
  });
}

function confirmDrop(): void {
  post({ type: 'dropUser', user: pendingDrop.value });
}
</script>

<template>
  <div class="wrap">
    <div class="head">
      <h3>{{ t('wv.userManage.title', { conn: connLabel }) }}</h3>
      <div class="head-actions">
        <button class="btn sec" @click="refresh">{{ t('wv.common.refresh') }}</button>
        <button class="btn" @click="showCreate = !showCreate">{{ t('wv.userManage.newUser') }}</button>
      </div>
    </div>

    <div v-if="error" class="banner error">{{ error }}</div>
    <div v-if="notice" class="banner notice">{{ notice }}</div>

    <div v-if="showCreate" class="card">
      <div class="card-title">{{ t('wv.userManage.newUser') }}</div>
      <div class="grid">
        <div class="field">
          <label>{{ t('wv.userManage.username') }}</label>
          <input v-model="newName" :placeholder="t('wv.userManage.usernamePlaceholder')">
        </div>
        <div v-if="supportsHost" class="field">
          <label>{{ t('wv.userManage.host') }}</label>
          <input v-model="newHost">
        </div>
        <div class="field">
          <label>{{ t('wv.userManage.password') }}</label>
          <input v-model="newPassword" type="password">
        </div>
        <div class="field">
          <label>{{ t('wv.userManage.confirmPw') }}</label>
          <input v-model="newConfirm" type="password">
        </div>
      </div>
      <div class="card-actions">
        <button class="btn" @click="submitCreate">{{ t('wv.common.create') }}</button>
        <button class="btn sec" @click="showCreate = false">{{ t('wv.common.cancel') }}</button>
      </div>
    </div>

    <div class="cols">
      <div class="list">
        <div class="list-title">{{ t('wv.userManage.users') }}</div>
        <input v-model="search" class="search" :placeholder="t('wv.userManage.searchPlaceholder')">
        <div v-if="loading" class="empty">{{ t('wv.common.loading') }}</div>
        <div v-else-if="!filteredUsers.length" class="empty">{{ search ? t('wv.userManage.noMatches') : t('wv.userManage.noUsers') }}</div>
        <div
          v-for="u in filteredUsers"
          v-else
          :key="userLabel(u)"
          class="row"
          :class="{ active: selected === userLabel(u) }"
          @click="select(u)"
        >
          {{ userLabel(u) }}
        </div>
      </div>

      <div class="detail">
        <div v-if="!hasSelection" class="empty">{{ t('wv.userManage.selectHint') }}</div>
        <template v-else>
          <div class="card">
            <div class="card-title">{{ t('wv.userManage.changePassword') }}</div>
            <div class="field">
              <label>{{ t('wv.userManage.newPassword') }}</label>
              <input v-model="pwValue" type="password">
            </div>
            <div class="card-actions">
              <button class="btn" @click="submitPassword">{{ t('wv.common.apply') }}</button>
            </div>
          </div>

          <div class="card">
            <div class="card-title">{{ t('wv.userManage.privileges') }}</div>
            <div v-if="databases.length" class="field">
              <label>{{ t('wv.userManage.database') }}</label>
              <select v-model="grantDatabase">
                <option value="">{{ t('wv.userManage.allDatabases') }}</option>
                <option v-for="db in databases" :key="db" :value="db">{{ db }}</option>
              </select>
            </div>
            <div class="privs">
              <label v-for="p in privileges" :key="p" class="priv">
                <input v-model="checkedPrivs" type="checkbox" :value="p"> {{ p }}
              </label>
            </div>
            <div class="card-actions">
              <button class="btn" @click="submitPrivileges('grant')">{{ t('wv.userManage.grant') }}</button>
              <button class="btn sec" @click="submitPrivileges('revoke')">{{ t('wv.userManage.revoke') }}</button>
            </div>
          </div>

          <div class="card danger-card">
            <div class="card-title">{{ t('wv.userManage.dangerZone') }}</div>
            <div v-if="pendingDrop !== selected" class="card-actions">
              <button class="btn danger" @click="pendingDrop = selected">{{ t('wv.userManage.dropUser') }}</button>
            </div>
            <template v-else>
              <div class="confirm-text">{{ t('wv.userManage.dropConfirm', { name: selected }) }}</div>
              <div class="card-actions">
                <button class="btn danger" @click="confirmDrop">{{ t('wv.common.delete') }}</button>
                <button class="btn sec" @click="pendingDrop = ''">{{ t('wv.common.cancel') }}</button>
              </div>
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { padding: 16px; font-size: 13px; }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
h3 { margin: 0; }
.head-actions { display: flex; gap: 8px; }
.banner { padding: 6px 10px; border-radius: 3px; margin-bottom: 12px; font-size: 12px; }
.banner.error { color: var(--vscode-errorForeground, #f48771); background: rgba(244, 135, 113, 0.12); }
.banner.notice { color: var(--vscode-foreground, #d4d4d4); background: rgba(255, 255, 255, 0.06); }
.cols { display: grid; grid-template-columns: 240px 1fr; gap: 16px; align-items: start; }
.list { border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 3px; overflow: hidden; }
.list-title, .card-title { padding: 6px 10px; font-weight: 600; background: rgba(255, 255, 255, 0.04); }
.row { padding: 6px 10px; cursor: pointer; }
.row:hover { background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08)); }
.row.active { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #ffffff); }
.search {
  width: calc(100% - 20px); margin: 6px 10px 8px; padding: 5px 6px; box-sizing: border-box;
  background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4);
  border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px;
}
.empty { padding: 10px; opacity: 0.7; }
.card { border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 3px; margin-bottom: 12px; }
.card .field, .card .grid, .card .privs, .card-actions, .confirm-text { padding: 0 10px; }
.card .field { margin: 10px 0; }
.card-actions { padding: 10px; display: flex; gap: 8px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding-top: 10px; }
.grid .field { margin: 0; }
.field label { display: block; margin-bottom: 4px; }
input, select {
  width: 100%; box-sizing: border-box; padding: 6px;
  background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4);
  border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px;
}
.privs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding-top: 10px; }
.priv { display: flex; gap: 6px; align-items: center; }
.priv input { width: auto; }
.confirm-text { padding-top: 10px; font-size: 12px; }
.danger-card { border-color: rgba(244, 135, 113, 0.4); }
.btn {
  padding: 6px 16px; cursor: pointer;
  background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff);
  border: none; border-radius: 3px;
}
.btn.sec { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
.btn.danger { background: var(--vscode-inputValidation-errorBorder, #be1100); }
</style>
