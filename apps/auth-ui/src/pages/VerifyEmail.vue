<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { claimLinkFlow, verifyEmail, resendVerification } from '@devbelt/auth-client';
import { readCsrfToken } from '@devbelt/auth-client';

// 文案常量，与验证邮件正文语言一致（本片不做双语切换）。
const TEXT = {
  title: '验证你的邮箱',
  processing: '正在处理…',
  success: '邮箱验证成功。',
  alreadyConfirmed: '该链接已使用，邮箱已验证。',
  invalid: '验证链接无效或已过期。',
  failure: '验证失败，请检查网络后重试。',
  retry: '重试',
  resendPrompt: '填写注册邮箱，重新发送验证邮件。',
  resendEmailPlaceholder: '你的邮箱',
  resend: '重新发送',
  resending: '发送中…',
  resent: '如果该邮箱曾注册，我们已发送验证邮件，请查收。',
  rateLimited: '请求过于频繁，请稍后再试。',
} as const;

type State = 'processing' | 'success' | 'already-confirmed' | 'invalid' | 'failure';

const token = readToken();
const state = ref<State>('processing');
const canRetry = ref(false);

// 重发子状态
const resendEmail = ref('');
const resendState = ref<'idle' | 'sending' | 'done' | 'rate-limited'>('idle');

let csrfToken = '';

onMounted(async () => {
  if (token) {
    // 读后立即从地址栏清除 query，减少一次性 token 落入历史/Referrer/截图的暴露面；
    // 内存中的 token 仅用于认领阶段的失败重试。
    history.replaceState(null, '', window.location.pathname);
  }
  csrfToken = await ensureCsrf();
  if (token) await claim();
  else await consume();
});

async function ensureCsrf(): Promise<string> {
  try {
    await fetch('/api/console/auth/csrf', { credentials: 'same-origin' });
  } catch {
    // 网络失败时 token 为空；后续提交会被服务端 CSRF 校验拒绝（403），前端按失败重试处理。
  }
  return readCsrfToken(document.cookie) ?? '';
}

async function claim() {
  state.value = 'processing';
  canRetry.value = false;
  const result = await claimLinkFlow('verify-email', token!);
  if (result.kind === 'ok') {
    await consume();
    return;
  }
  if (result.kind === 'invalid') {
    state.value = 'invalid';
    return;
  }
  state.value = 'failure';
  canRetry.value = true;
}

async function consume() {
  state.value = 'processing';
  canRetry.value = false;
  const result = await verifyEmail(csrfToken || (csrfToken = await ensureCsrf()));
  if (result.kind === 'success') state.value = 'success';
  else if (result.kind === 'already-confirmed') state.value = 'already-confirmed';
  else if (result.kind === 'invalid') state.value = 'invalid';
  else {
    state.value = 'failure';
    canRetry.value = true;
  }
}

function retry() {
  if (token) void claim();
  else void consume();
}

async function resend() {
  const email = resendEmail.value.trim();
  if (!email || resendState.value === 'sending') return;
  resendState.value = 'sending';
  csrfToken = await ensureCsrf();
  const result = await resendVerification(email, csrfToken);
  if (result.kind === 'ok') {
    resendState.value = 'done';
  } else if (result.kind === 'rate-limited') {
    resendState.value = 'rate-limited';
  } else {
    resendState.value = 'idle';
  }
}

function readToken(): string | null {
  const raw = new URLSearchParams(window.location.search).get('token');
  return raw && raw.trim() !== '' ? raw.trim() : null;
}
</script>

<template>
  <div class="card">
    <h1>{{ TEXT.title }}</h1>

    <template v-if="state === 'processing'">
      <p class="muted">{{ TEXT.processing }}</p>
    </template>

    <template v-else-if="state === 'success'">
      <p class="success">{{ TEXT.success }}</p>
    </template>

    <template v-else-if="state === 'already-confirmed'">
      <p class="success">{{ TEXT.alreadyConfirmed }}</p>
    </template>

    <template v-else-if="state === 'failure'">
      <p class="error">{{ TEXT.failure }}</p>
      <button v-if="canRetry" class="primary" @click="retry">{{ TEXT.retry }}</button>
    </template>

    <template v-else-if="state === 'invalid'">
      <p class="error">{{ TEXT.invalid }}</p>
      <div class="resend">
        <p class="muted">{{ TEXT.resendPrompt }}</p>
        <input v-model="resendEmail" type="email" :placeholder="TEXT.resendEmailPlaceholder" :disabled="resendState === 'sending'" />
        <button class="secondary" :disabled="resendState === 'sending'" @click="resend">
          {{ resendState === 'sending' ? TEXT.resending : TEXT.resend }}
        </button>
        <p v-if="resendState === 'done'" class="success">{{ TEXT.resent }}</p>
        <p v-else-if="resendState === 'rate-limited'" class="error">{{ TEXT.rateLimited }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.card {
  max-width: 480px;
  margin: 80px auto;
  padding: 28px 32px;
  background: var(--c-surface);
  border: 1px solid var(--c-border-strong);
  border-radius: 8px;
}

h1 {
  font-size: 20px;
  font-weight: 700;
  color: var(--c-text);
  margin: 0 0 4px;
}

.muted {
  color: var(--c-text-muted);
  font-size: 14px;
  line-height: 1.7;
  margin: 12px 0 0;
}

.success {
  color: var(--c-success-text);
  font-size: 15px;
  margin: 12px 0 0;
}

.error {
  color: var(--c-danger);
  font-size: 15px;
  margin: 12px 0 0;
}

button.primary {
  display: block;
  margin: 22px 0;
  background: var(--c-accent);
  color: var(--c-surface);
  border: none;
  padding: 12px 32px;
  border-radius: 6px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.resend {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--c-divider);
}

.resend input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--c-border-strong);
  border-radius: 6px;
  font-size: 14px;
  margin: 8px 0;
}

button.secondary {
  background: var(--c-accent);
  color: var(--c-surface);
  border: none;
  padding: 10px 24px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

button.secondary:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>