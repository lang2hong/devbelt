<script setup lang="ts">
import { ref } from 'vue';
import { register, ensureCsrf } from '../api/consoleAuth';

const email = ref('');
const password = ref('');
const displayName = ref('');
const error = ref('');
const done = ref(false);
const submitting = ref(false);

async function submit() {
  if (submitting.value) return;
  submitting.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const result = await register(email.value.trim(), password.value, displayName.value.trim(), csrf);
    if (result.kind === 'ok') {
      done.value = true;
      return;
    }
    if (result.kind === 'rate-limited') error.value = '注册尝试过于频繁，请稍后再试。';
    else error.value = '注册失败，请检查网络后重试。';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="card">
    <h1>注册 DB Client</h1>
    <p v-if="done" class="success">验证邮件已发送（若该邮箱尚未注册），请查收并完成验证后登录。</p>
    <form v-else @submit.prevent="submit">
      <label>邮箱</label>
      <input v-model="email" type="email" autocomplete="username" required />
      <label>密码（12–128 字符）</label>
      <input v-model="password" type="password" autocomplete="new-password" required />
      <label>显示名</label>
      <input v-model="displayName" type="text" />
      <p v-if="error" class="error">{{ error }}</p>
      <button type="submit" :disabled="submitting">{{ submitting ? '注册中…' : '注册' }}</button>
    </form>
    <p class="muted"><a href="/login">返回登录</a></p>
  </div>
</template>

<style scoped>
.card { max-width: 420px; margin: 80px auto; padding: 28px 32px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; }
h1 { font-size: 20px; font-weight: 700; color: #0f172a; margin: 0 0 16px; }
label { display: block; font-size: 13px; color: #57606a; margin: 12px 0 4px; }
input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
button { margin-top: 20px; width: 100%; background: #0969da; color: #fff; border: none; padding: 12px; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
.error { color: #cf222e; font-size: 13px; }
.success { color: #1a7f37; font-size: 14px; }
.muted { color: #57606a; font-size: 13px; }
a { color: #0969da; }
</style>