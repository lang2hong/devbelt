<script setup lang="ts">
import { ref } from 'vue';
import { ensureCsrf, setAccessToken } from '../api/consoleAuth';
import { updateDisplayName, changePassword, type ConsoleMeUser } from '../api/me';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';

const props = defineProps<{ user: ConsoleMeUser | null }>();

const displayName = ref(props.user?.displayName ?? '');
const nameSaving = ref(false);
const nameError = ref('');
const nameSaved = ref(false);

const current = ref('');
const next = ref('');
const confirm = ref('');
const pwError = ref('');
const pwSubmitting = ref(false);

const nameWrite = useIdempotencyKey();

function forceRelogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

async function saveName(): Promise<void> {
  if (!props.user || nameSaving.value) return;
  nameSaving.value = true;
  nameError.value = '';
  nameSaved.value = false;
  try {
    const value = displayName.value.trim();
    const tag = `displayName:${value}`;
    const csrf = await ensureCsrf();
    const r = await updateDisplayName(value, nameWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      nameWrite.reset(tag);
      nameSaved.value = true;
    } else if (r.kind === 'unauthorized') {
      nameWrite.reset(tag);
      forceRelogin();
    } else if (isRetryableFailure(r.kind)) {
      nameError.value = '保存失败，请重试。';
    } else {
      nameWrite.reset(tag);
      nameError.value = '保存失败，请重试。';
    }
  } finally {
    nameSaving.value = false;
  }
}

async function submitPassword(): Promise<void> {
  if (pwSubmitting.value) return;
  pwError.value = '';
  if (next.value !== confirm.value) {
    pwError.value = '两次输入的新密码不一致。';
    return;
  }
  pwSubmitting.value = true;
  try {
    const csrf = await ensureCsrf();
    const r = await changePassword(current.value, next.value, csrf);
    if (r.kind === 'ok') forceRelogin();
    else if (r.kind === 'invalid-current-password') pwError.value = '当前密码错误。';
    else pwError.value = '改密失败，请重试。';
  } finally {
    pwSubmitting.value = false;
  }
}
</script>

<template>
  <section class="page">
    <h2>账户</h2>

    <div class="card">
      <h3>基本信息</h3>
      <p class="row">邮箱：{{ user?.email ?? '' }}</p>
      <p class="row" v-if="user">
        验证状态：
        <span v-if="user.emailVerified" class="ok">已验证</span>
        <span v-else class="warn">未验证</span>
      </p>
      <label>显示名</label>
      <input v-model="displayName" type="text" maxlength="100" />
      <p v-if="nameError" class="error">{{ nameError }}</p>
      <p v-if="nameSaved" class="ok">已保存。</p>
      <button class="btn" :disabled="nameSaving" @click="saveName">{{ nameSaving ? '保存中…' : '保存' }}</button>
    </div>

    <div class="card">
      <h3>修改密码</h3>
      <label>当前密码</label>
      <input v-model="current" type="password" autocomplete="current-password" required />
      <label>新密码（12–128 字符）</label>
      <input v-model="next" type="password" autocomplete="new-password" required />
      <label>确认新密码</label>
      <input v-model="confirm" type="password" autocomplete="new-password" required />
      <p v-if="pwError" class="error">{{ pwError }}</p>
      <p class="muted">修改密码后将退出全部设备，需重新登录。</p>
      <button class="btn danger" :disabled="pwSubmitting" @click="submitPassword">{{ pwSubmitting ? '提交中…' : '修改密码' }}</button>
    </div>
  </section>
</template>

<style scoped>
.page { max-width: 620px; margin: 0 auto; }
.card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; }
h3 { font-size: 15px; font-weight: 600; color: #0f172a; margin: 0 0 12px; }
.row { margin: 8px 0; color: #24292f; }
label { display: block; font-size: 13px; color: #57606a; margin: 12px 0 4px; }
input { width: 100%; box-sizing: border-box; padding: 9px 12px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
.btn { margin-top: 16px; background: #0969da; color: #fff; border: none; padding: 9px 16px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.danger { background: #cf222e; }
.error { color: #cf222e; font-size: 13px; }
.ok { color: #1a7f37; font-size: 13px; }
.warn { color: #9a6700; font-size: 13px; }
.muted { color: #57606a; font-size: 13px; }
</style>