<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

const { post, onMessage } = useVsCode();
const { t } = useI18n();

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


let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type !== 'init') return;
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
    if (!name.value) { error.value = t('wv.userForm.errNameRequired'); return; }
    if (password.value !== confirmPw.value) { error.value = t('wv.userForm.errPwMismatch'); return; }
    post({ type: 'submit', name: name.value, password: password.value, host: host.value || '%' });
    return;
  }
  const privs = privileges.value.filter((p) => checkedPrivs.value.has(p));
  if (!privs.length) { error.value = t('wv.userForm.errNoPriv'); return; }
  post({ type: 'submit', priv: privs, database: database.value });
}

function cancel(): void {
  post({ type: 'cancel' });
}
</script>

<template>
  <div class="wrap">
    <h3>{{ userMode === 'create' ? t('wv.userForm.createTitle') : t('wv.userForm.grantTitle', { label: nodeLabel }) }}</h3>

    <template v-if="userMode === 'create'">
      <div class="field"><label>{{ t('wv.userForm.username') }}</label><input v-model="name" autofocus></div>
      <div class="field"><label>{{ t('wv.userForm.password') }}</label><input v-model="password" type="password"></div>
      <div class="field"><label>{{ t('wv.userForm.confirmPw') }}</label><input v-model="confirmPw" type="password"></div>
      <div class="field"><label>{{ t('wv.userForm.host') }}</label><input v-model="host"></div>
    </template>

    <template v-else>
      <div class="field"><label>{{ t('wv.userForm.privileges') }}</label>
        <div class="privs">
          <label v-for="p in privileges" :key="p" class="priv">
            <input v-model="checkedPrivs" type="checkbox" :value="p"> {{ p }}
          </label>
        </div>
      </div>
      <div class="field"><label>{{ t('wv.userForm.database') }}</label><input v-model="database"></div>
    </template>

    <div v-if="error" class="error">{{ error }}</div>
    <div class="actions">
      <button class="btn" @click="submit">{{ t('wv.userForm.submit') }}</button>
      <button class="btn sec" @click="cancel">{{ t('wv.userForm.cancel') }}</button>
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
  background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4);
  border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px;
}
.privs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.priv { display: flex; gap: 6px; align-items: center; }
.error { color: var(--vscode-errorForeground, #f48771); margin-bottom: 12px; font-size: 12px; }
.actions { margin-top: 12px; }
.btn {
  padding: 6px 16px; cursor: pointer; margin-right: 8px;
  background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff);
  border: none; border-radius: 3px;
}
.btn.sec { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
</style>
