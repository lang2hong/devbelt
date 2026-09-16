<script setup lang="ts">
import { ref } from 'vue';
import { login, ensureCsrf, getOrCreateDeviceKey } from '../api/consoleAuth';
import { safeReturnTo } from '../lib/returnTo';

const email = ref('');
const password = ref('');
const error = ref('');
const submitting = ref(false);
const showPassword = ref(false);

const search = new URLSearchParams(window.location.search);
const flow = search.get('flow');
const returnTo = safeReturnTo(search.get('returnTo'));

async function submit() {
  if (submitting.value) return;
  submitting.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const deviceKey = getOrCreateDeviceKey();
    const result = await login(email.value.trim(), password.value, deviceKey, csrf);
    if (result.kind === 'ok') {
      // accept-invitation / sync-reset 邮件流：登录成功后回到干净落地页（不含 token）
      // 继续认领交接；服务端已在登录时绑定 held mail-flow。
      if (flow === 'accept-invitation') {
        window.location.assign('/accept-invitation');
        return;
      }
      if (flow === 'sync-reset') {
        window.location.assign('/sync-reset');
        return;
      }
      window.location.assign(returnTo);
      return;
    }
    if (result.kind === 'invalid-credentials') error.value = '邮箱或密码错误，或邮箱尚未验证。';
    else if (result.kind === 'rate-limited') error.value = '尝试过于频繁，请稍后再试。';
    else error.value = '登录失败，请检查网络后重试。';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="card">
    <h1>登录 DB Client</h1>
    <form @submit.prevent="submit">
      <label>邮箱</label>
      <input v-model="email" type="email" autocomplete="username" required />
      <label>密码</label>
      <div class="pw">
        <input v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" required />
        <button type="button" class="toggle" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">{{ showPassword ? '🙈' : '👁' }}</button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <button type="submit" :disabled="submitting">{{ submitting ? '登录中…' : '登录' }}</button>
    </form>
    <p class="muted">还没有账号？<a href="/register">注册</a></p>
  </div>
</template>

<style scoped>
.card { max-width: 420px; margin: 80px auto; padding: 28px 32px; background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; }
h1 { font-size: 20px; font-weight: 700; color: var(--c-text); margin: 0 0 16px; }
label { display: block; font-size: 13px; color: var(--c-text-muted); margin: 12px 0 4px; }
input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--c-border-strong); border-radius: 6px; font-size: 14px; }
button { margin-top: 20px; width: 100%; background: var(--c-accent); color: var(--c-surface); border: none; padding: 12px; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; }
.pw { position: relative; }
.pw input { width: 100%; padding-right: 38px; }
.toggle { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); border: none; background: none; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px; opacity: 0.55; }
.toggle:hover { opacity: 1; }
button:disabled { opacity: 0.6; cursor: default; }
.error { color: var(--c-danger); font-size: 13px; }
.muted { color: var(--c-text-muted); font-size: 13px; }
a { color: var(--c-accent); }
</style>