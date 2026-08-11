<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';

const { post, onMessage } = useVsCode();

const isZh = ref(false);
const userMode = ref<'create' | 'grant'>('create');
const nodeLabel = ref('');
const database = ref('');
const privileges = ref<string[]>([]);

const name = ref('');
const password = ref('');
const confirmPw = ref('');
const host = ref('%');
const checkedPrivs = ref(new Set<string>());
const error = ref('');

const I18N: Record<string, Record<'en' | 'zh', string>> = {
  createTitle: { en: 'Create User', zh: '创建用户' },
  grantTitle: { en: 'Grant Privilege to {label}', zh: '授予 {label} 权限' },
  username: { en: 'Username', zh: '用户名' },
  password: { en: 'Password', zh: '密码' },
  confirmPw: { en: 'Confirm Password', zh: '确认密码' },
  host: { en: 'Host', zh: '主机' },
  privileges: { en: 'Privileges', zh: '权限' },
  database: { en: 'Database', zh: '数据库' },
  submit: { en: 'Submit', zh: '提交' },
  cancel: { en: 'Cancel', zh: '取消' },
  errNameRequired: { en: 'Username required', zh: '请输入用户名' },
  errPwMismatch: { en: 'Passwords do not match', zh: '两次密码不一致' },
  errNoPriv: { en: 'Select at least one privilege', zh: '请至少选择一个权限' },
};
const t = (key: string, vars?: Record<string, string>): string => {
  let text = I18N[key]?.[isZh.value ? 'zh' : 'en'] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, v);
  return text;
};

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type !== 'init') return;
    isZh.value = !!msg.isZh;
    userMode.value = msg.userMode === 'grant' ? 'grant' : 'create';
    nodeLabel.value = msg.nodeLabel || '';
    database.value = msg.database || '';
    privileges.value = Array.isArray(msg.privileges) ? msg.privileges : [];
    checkedPrivs.value = new Set();
    error.value = '';
  });
  post({ type: 'ready' });
});

onUnmounted(() => cleanup?.());

function submit(): void {
  error.value = '';
  if (userMode.value === 'create') {
    if (!name.value) { error.value = t('errNameRequired'); return; }
    if (password.value !== confirmPw.value) { error.value = t('errPwMismatch'); return; }
    post({ type: 'submit', name: name.value, password: password.value, host: host.value || '%' });
    return;
  }
  const privs = privileges.value.filter((p) => checkedPrivs.value.has(p));
  if (!privs.length) { error.value = t('errNoPriv'); return; }
  post({ type: 'submit', priv: privs, database: database.value });
}

function cancel(): void {
  post({ type: 'cancel' });
}
</script>

<template>
  <div class="wrap">
    <h3>{{ userMode === 'create' ? t('createTitle') : t('grantTitle', { label: nodeLabel }) }}</h3>

    <template v-if="userMode === 'create'">
      <div class="field"><label>{{ t('username') }}</label><input v-model="name" autofocus></div>
      <div class="field"><label>{{ t('password') }}</label><input v-model="password" type="password"></div>
      <div class="field"><label>{{ t('confirmPw') }}</label><input v-model="confirmPw" type="password"></div>
      <div class="field"><label>{{ t('host') }}</label><input v-model="host"></div>
    </template>

    <template v-else>
      <div class="field"><label>{{ t('privileges') }}</label>
        <div class="privs">
          <label v-for="p in privileges" :key="p" class="priv">
            <input v-model="checkedPrivs" type="checkbox" :value="p"> {{ p }}
          </label>
        </div>
      </div>
      <div class="field"><label>{{ t('database') }}</label><input v-model="database"></div>
    </template>

    <div v-if="error" class="error">{{ error }}</div>
    <div class="actions">
      <button class="btn" @click="submit">{{ t('submit') }}</button>
      <button class="btn sec" @click="cancel">{{ t('cancel') }}</button>
    </div>
  </div>
</template>

<style scoped>
.wrap { padding: 16px; font-size: 13px; }
h3 { margin: 0 0 12px; }
.field { margin-bottom: 12px; }
.field label { display: block; margin-bottom: 4px; }
input {
  width: 100%; box-sizing: border-box; padding: 6px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); border-radius: 3px;
}
.privs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.priv { display: flex; gap: 6px; align-items: center; }
.error { color: var(--vscode-errorForeground); margin-bottom: 12px; font-size: 12px; }
.actions { margin-top: 12px; }
.btn {
  padding: 6px 16px; cursor: pointer; margin-right: 8px;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; border-radius: 3px;
}
.btn.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
