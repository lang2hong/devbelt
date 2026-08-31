<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

/**
 * 登录/注册/验证表单（Vue 版）。
 * 消息协议（与 src/sync/loginFormView.ts 对齐）：
 *   webview → ext: ready | login{email,password} | register{email,password,confirm}
 *                  | verify{token} | resend{email}
 *   ext → webview: init{mode:'loginForm'} | error{message} | success{message}
 *                  | verifySent{email,message} | verified{message}
 *
 * V3 注册不返回 token：注册成功后进入 verify 步骤，输入邮件中的验证 token，
 * 验证通过后再用同一邮箱密码登录。
 */
const { post, onMessage } = useVsCode();
const { t } = useI18n();

const mode = ref<'login' | 'register' | 'verify'>('login');
const email = ref('');
const password = ref('');
const confirm = ref('');
const token = ref('');
const pendingEmail = ref('');
const errorMsg = ref('');
const successMsg = ref('');
const noticeMsg = ref('');
const submitting = ref(false);

function setMode(m: 'login' | 'register') {
  mode.value = m;
  errorMsg.value = '';
  successMsg.value = '';
  noticeMsg.value = '';
}

function submit() {
  errorMsg.value = '';
  successMsg.value = '';
  submitting.value = true;
  if (mode.value === 'verify') {
    post({ type: 'verify', token: token.value.trim() });
    return;
  }
  post({ type: mode.value, email: email.value.trim(), password: password.value, confirm: confirm.value });
}

function resend() {
  errorMsg.value = '';
  submitting.value = true;
  post({ type: 'resend', email: pendingEmail.value || email.value.trim() });
}

onMounted(() => {
  post({ type: 'ready' });
  onMessage((msg: any) => {
    submitting.value = false;
    if (msg.type === 'error') errorMsg.value = msg.message;
    else if (msg.type === 'success') successMsg.value = msg.message;
    else if (msg.type === 'verifySent') {
      mode.value = 'verify';
      pendingEmail.value = msg.email || pendingEmail.value;
      noticeMsg.value = msg.message || '';
      errorMsg.value = '';
      successMsg.value = '';
    } else if (msg.type === 'verified') {
      successMsg.value = msg.message || '';
      mode.value = 'login';
      token.value = '';
    }
  });
});
</script>

<template>
  <div class="login-wrap">
    <div class="card">
      <div class="tabs" v-if="mode !== 'verify'">
        <div class="tab" :class="{ active: mode === 'login' }" @click="setMode('login')">{{ t('login.tabLogin') }}</div>
        <div class="tab" :class="{ active: mode === 'register' }" @click="setMode('register')">{{ t('login.tabRegister') }}</div>
      </div>

      <form v-if="mode !== 'verify'" @submit.prevent="submit">
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

      <form v-else @submit.prevent="submit">
        <div class="notice">{{ noticeMsg }}</div>
        <div class="field">
          <label for="token">{{ t('login.verifyToken') }}</label>
          <input id="token" v-model="token" type="text" autocomplete="off" placeholder="token from email" />
        </div>
        <button class="btn" type="submit" :disabled="submitting || !token.trim()">{{ t('login.submitVerify') }}</button>
        <button class="btn link" type="button" :disabled="submitting" @click="resend">{{ t('login.resend') }}</button>
        <button class="btn link" type="button" @click="setMode('login')">{{ t('login.backToLogin') }}</button>
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
.notice { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 14px; line-height: 1.5; }
.field { margin-bottom: 12px; }
label { display: block; font-size: 12px; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
input { width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; outline: none; }
input:focus { border-color: var(--vscode-focusBorder); }
.btn { width: 100%; padding: 7px; font-size: 13px; border: none; border-radius: 3px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); margin-bottom: 8px; }
.btn:disabled { opacity: .5; cursor: default; }
.btn.link { background: transparent; color: var(--vscode-textLink-foreground); margin-bottom: 0; }
.msg { font-size: 12px; margin-top: 10px; min-height: 16px; }
.error { color: var(--vscode-errorForeground); }
.success { color: var(--vscode-testing-iconPassed-color, #4ec9b0); }
</style>