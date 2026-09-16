<script setup lang="ts">
import { ref } from 'vue';
import { ensureCsrf, setAccessToken } from '../api/consoleAuth';
import { updateDisplayName, changePassword, type ConsoleMeUser } from '../api/me';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { navigate } from '../lib/router';
import { formatDateTime } from '../lib/formatTime';

const props = defineProps<{ user: ConsoleMeUser | null; subscription: { planCode: string | null; status: string; periodEndTime: string | null } | null }>();

const displayName = ref(props.user?.displayName ?? '');
const nameSaving = ref(false);
const nameError = ref('');
const nameSaved = ref(false);

const current = ref('');
const next = ref('');
const confirm = ref('');
const pwError = ref('');
const pwSubmitting = ref(false);
const showPassword = ref(false);

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
    <header class="head">
      <h2>账户</h2>
      <p class="sub">管理你的登录信息与订阅。</p>
    </header>

    <div class="card">
      <h3>基本信息</h3>
      <div class="kv"><span class="k">邮箱</span><span class="v">{{ user?.email ?? '' }}</span></div>
      <div class="kv" v-if="user">
        <span class="k">验证状态</span>
        <span class="v"><span class="badge" :class="user.emailVerified ? 'ok' : 'warn'">{{ user.emailVerified ? '已验证' : '未验证' }}</span></span>
      </div>
      <div class="field">
        <label>显示名</label>
        <input v-model="displayName" type="text" maxlength="100" />
      </div>
      <p v-if="nameError" class="error">{{ nameError }}</p>
      <p v-if="nameSaved" class="ok">已保存。</p>
      <div class="actions"><button class="btn" :disabled="nameSaving" @click="saveName">{{ nameSaving ? '保存中…' : '保存' }}</button></div>
    </div>

    <div class="card">
      <h3>订阅</h3>
      <template v-if="subscription">
        <div class="kv"><span class="k">当前套餐</span><span class="v"><strong>{{ subscription.planCode === 'pro' ? 'Pro' : (subscription.planCode ?? '—') }}</strong> <span class="badge" :class="subscription.status === 'active' ? 'ok' : ''">{{ subscription.status === 'active' ? '生效中' : subscription.status }}</span></span></div>
        <div class="kv" v-if="subscription.periodEndTime"><span class="k">到期时间</span><span class="v">{{ formatDateTime(subscription.periodEndTime) }}</span></div>
      </template>
      <p class="muted" v-else>暂无订阅。</p>
      <div class="actions" v-if="subscription?.planCode !== 'pro'"><button class="btn accent" @click="navigate('/console/checkout')">升级 Pro</button></div>
    </div>

    <div class="card">
      <h3>修改密码</h3>
      <div class="field"><label>当前密码</label><input v-model="current" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" required /></div>
      <div class="field">
        <label>新密码（9–128 字符）</label>
        <div class="pw">
          <input v-model="next" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" required />
          <button type="button" class="toggle" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">{{ showPassword ? '🙈' : '' }}</button>
        </div>
      </div>
      <div class="field"><label>确认新密码</label><input v-model="confirm" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" required /></div>
      <p v-if="pwError" class="error">{{ pwError }}</p>
      <p class="muted small">修改密码后将退出全部设备，需重新登录。</p>
      <div class="actions"><button class="btn danger" :disabled="pwSubmitting" @click="submitPassword">{{ pwSubmitting ? '提交中…' : '修改密码' }}</button></div>
    </div>
  </section>
</template>

<style scoped>
.page { max-width: 640px; margin: 0 auto; }
.head { margin-bottom: 20px; }
.head h2 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--c-text-muted); }
.card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 20px 22px; margin-bottom: 16px; }
h3 { font-size: 14px; font-weight: 600; margin: 0 0 14px; }
.kv { display: grid; grid-template-columns: 96px 1fr; gap: 12px; align-items: center; padding: 6px 0; }
.kv .k { color: var(--c-text-muted); font-size: 13px; }
.kv .v { font-size: 13.5px; }
.field { display: flex; flex-direction: column; gap: 5px; margin-top: 12px; }
label { font-size: 12px; color: var(--c-text-muted); }
input { width: 100%; box-sizing: border-box; }
.pw { position: relative; }
.pw input { padding-right: 38px; }
.toggle { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); border: none; background: none; cursor: pointer; font-size: 15px; line-height: 1; padding: 2px; opacity: .55; }
.toggle:hover { opacity: 1; }
.actions { margin-top: 16px; }
.btn { height: 34px; padding: 0 16px; border: none; border-radius: var(--r-md); font-size: 13px; font-weight: 600; cursor: pointer; background: var(--c-success); color: #fff; }
.btn.accent { background: var(--c-accent); }
.btn.danger { background: var(--c-danger); }
.btn:disabled { opacity: .6; cursor: default; }
.badge { display: inline-flex; padding: 1px 8px; border-radius: var(--r-pill); font-size: 12px; background: #eaeef2; color: var(--c-text-muted); }
.badge.ok { background: var(--c-success-bg); color: var(--c-success-text); }
.badge.warn { background: var(--c-warn-bg); color: var(--c-warn-text); }
.error { color: var(--c-danger); font-size: 13px; }
.ok { color: var(--c-success-text); font-size: 13px; }
.muted { color: var(--c-text-muted); font-size: 13px; }
.small { font-size: 12px; }
</style>
