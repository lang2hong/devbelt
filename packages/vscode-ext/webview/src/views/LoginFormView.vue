<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

/**
 * 登录/注册表单（Vue 版，替代原 loginForm.ts 的原生 HTML）。
 * 消息协议（与 src/sync/loginFormView.ts 对齐）：
 *   webview → ext: ready | login{email,password} | register{email,password,confirm}
 *   ext → webview: init{mode:'loginForm'} | error{message} | success{message}
 */
const { post, onMessage } = useVsCode();
const { t } = useI18n();

const mode = ref<'login' | 'register'>('login');
const email = ref('');
const password = ref('');
const confirm = ref('');
const errorMsg = ref('');
const successMsg = ref('');
const submitting = ref(false);

function setMode(m: 'login' | 'register') {
  mode.value = m;
  errorMsg.value = '';
  successMsg.value = '';
}

function submit() {
  errorMsg.value = '';
  successMsg.value = '';
  submitting.value = true;
  post({ type: mode.value, email: email.value.trim(), password: password.value, confirm: confirm.value });
}

onMounted(() => {
  post({ type: 'ready' });
  onMessage((msg: any) => {
    submitting.value = false;
    if (msg.type === 'error') errorMsg.value = msg.message;
    else if (msg.type === 'success') successMsg.value = msg.message;
  });
});
</script>

<template>
  <div class="login-wrap">
    <div class="card">
      <div class="tabs">
        <div class="tab" :class="{ active: mode === 'login' }" @click="setMode('login')">{{ t('login.tabLogin') }}</div>
        <div class="tab" :class="{ active: mode === 'register' }" @click="setMode('register')">{{ t('login.tabRegister') }}</div>
      </div>
      <form @submit.prevent="submit">
        <div class="field">
          <label for="email">{{ t('login.email') }}</label>
          <input id="email" v-model="email" type="email" autocomplete="off" />
        </div>
        <div class="field">
          <label for="password">{{ t('login.password') }}</label>
          <input id="password" v-model="password" type="password" autocomplete="off" />
        </div>
        <div class="field" v-if="mode === 'register'">
          <label for="confirm">{{ t('login.confirm') }}</label>
          <input id="confirm" v-model="confirm" type="password" autocomplete="off" />
        </div>
        <button class="btn" type="submit" :disabled="submitting">
          {{ mode === 'register' ? t('login.submitRegister') : t('login.submitLogin') }}
        </button>
        <div class="msg error" v-if="errorMsg">{{ errorMsg }}</div>
        <div class="msg success" v-if="successMsg">{{ successMsg }}</div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-wrap { display: flex; justify-content: center; padding: 48px 20px; box-sizing: border-box; height: 100%; }
.card { width: 320px; }
.tabs { display: flex; margin-bottom: 18px; border-bottom: 1px solid var(--vscode-panel-border); }
.tab { flex: 1; padding: 8px; text-align: center; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 13px; user-select: none; }
.tab.active { color: var(--vscode-foreground); border-bottom: 2px solid var(--vscode-focusBorder); }
.field { margin-bottom: 12px; }
label { display: block; font-size: 12px; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
input { width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; outline: none; }
input:focus { border-color: var(--vscode-focusBorder); }
.btn { width: 100%; padding: 7px; font-size: 13px; border: none; border-radius: 3px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn:disabled { opacity: .5; cursor: default; }
.msg { font-size: 12px; margin-top: 10px; min-height: 16px; }
.error { color: var(--vscode-errorForeground); }
.success { color: var(--vscode-testing-iconPassed-color, #4ec9b0); }
</style>
