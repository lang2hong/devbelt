<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from '../lib/router';
import { claimLinkFlow, bindMailFlow, createSyncResetHandoff } from '@devkit/auth-client';
import { ensureCsrf, refresh, getAccessToken } from '@devkit/auth-client';

const TEXT = {
  title: '同步重置',
  processing: '正在处理…',
  ready: '准备好通过 VS Code 扩展完成同步重置。',
  sameAccountHint: '请确保 VS Code 扩展登录的是同一账号。',
  openVsCode: '在 VS Code 中继续',
  launched: '已尝试打开 VS Code。如果扩展未响应，请确认已安装并登录。',
  retryOpen: '我已打开 VS Code，重试',
  expiresIn: '连接凭证有效期剩余：',
  expired: '连接凭证已过期。请重新打开邮件中的重置链接，或回到 VS Code 扩展重新发起重置。',
  invalid: '重置链接无效或已过期。',
  invalidRecoverLink: '你可以重新打开邮件中的重置链接重试。',
  invalidRecoverVsCode: '或回到 VS Code 扩展，重新发起“忘记同步口令”以获取新的重置邮件。',
  rateLimited: '操作过于频繁，请稍后再试。',
  failure: '处理失败，请检查网络后重试。',
  retry: '重试',
} as const;

type State = 'processing' | 'ready' | 'launched' | 'invalid' | 'failure' | 'rate-limited';

// 一次性 token 只从地址栏读一次，读后立即清理（§5.1：不进入 returnTo/历史/日志）。
// 仅在内存保留，用于认领阶段失败时的重试；刷新/关闭页面后不可恢复。
const token = readToken();
const state = ref<State>('processing');
const canRetry = ref(false);

// openUri 含一次性 handoffTicket：仅存于内存 ref，绝不写入 storage/URL/日志，绝不展示/复制。
const openUri = ref('');
const expiresTime = ref<Date | null>(null);
const remaining = ref('');
const expired = ref(false);
const rateLimitSeconds = ref(0);

let csrfToken = '';
// claim 是否已成功（已持有 link-flow cookie）。失败前保持 false，使重试重新认领。
let claimDone = false;
let countdownId: number | undefined;

onMounted(async () => {
  if (token) {
    history.replaceState(null, '', window.location.pathname);
  }
  try {
    csrfToken = await ensureCsrf();
    await bootstrap();
  } catch {
    // 防御：初始 CSRF 获取异常（当前 ensureCsrf 内部已捕获网络错误不抛出）时进入失败态，
    // 避免页面卡死在「正在处理」。重试时会在 authenticateAndHandoff 里重新获取 CSRF。
    state.value = 'failure';
    canRetry.value = true;
  }
});

onBeforeUnmount(() => {
  if (countdownId !== undefined) window.clearInterval(countdownId);
});

async function bootstrap() {
  state.value = 'processing';
  canRetry.value = false;

  if (token && !claimDone) {
    const claimed = await claimLinkFlow('sync-reset', token);
    if (claimed.kind === 'invalid') {
      state.value = 'invalid';
      return;
    }
    if (claimed.kind === 'failure') {
      state.value = 'failure';
      canRetry.value = true;
      return;
    }
    claimDone = true;
  }

  await authenticateAndHandoff();
}

async function authenticateAndHandoff() {
  state.value = 'processing';
  canRetry.value = false;
  const csrf = csrfToken || (csrfToken = await ensureCsrf());
  const refreshed = await refresh(csrf);
  if (refreshed.kind === 'invalid-credentials') {
    // 未登录：跳登录页，登录成功后回到干净的 /sync-reset（不含 token）。
    window.location.assign(withBase('/login?flow=sync-reset'));
    return;
  }
  if (refreshed.kind !== 'ok') {
    state.value = 'failure';
    canRetry.value = true;
    return;
  }
  const accessToken = getAccessToken();
  if (!accessToken) {
    state.value = 'failure';
    canRetry.value = true;
    return;
  }

  // 已登录直接打开链接：先显式绑定 held mail-flow（§5.3 消费前置）；未登录路径在
  // 登录成功时由服务端绑定。createHandoff 以 flow.userId === authUserId 为权威兜底。
  const bound = await bindMailFlow(csrf, accessToken);
  if (bound.kind === 'invalid') {
    state.value = 'invalid';
    return;
  }
  if (bound.kind === 'unauthorized') {
    window.location.assign(withBase('/login?flow=sync-reset'));
    return;
  }
  if (bound.kind === 'failure') {
    state.value = 'failure';
    canRetry.value = true;
    return;
  }

  await doHandoff(accessToken, csrf);
}

async function doHandoff(accessToken: string, csrf: string) {
  state.value = 'processing';
  canRetry.value = false;
  const result = await createSyncResetHandoff(csrf, accessToken);
  if (result.kind === 'success') {
    openUri.value = result.openUri;
    expiresTime.value = new Date(result.expiresTime);
    state.value = 'ready';
    startCountdown();
  } else if (result.kind === 'invalid') {
    state.value = 'invalid';
  } else if (result.kind === 'unauthorized') {
    window.location.assign(withBase('/login?flow=sync-reset'));
  } else if (result.kind === 'rate-limited') {
    rateLimitSeconds.value = result.retryAfter;
    state.value = 'rate-limited';
  } else {
    state.value = 'failure';
    canRetry.value = true;
  }
}

function launch() {
  if (!openUri.value) return;
  // 15 分钟票据到期后不得再唤起（会交出发时效 ticket，只得到服务端 INVALID）。
  // 倒计时 tick 可能尚未触发，这里再以真实时钟复核一次。
  if (isExpiredNow()) {
    expired.value = true;
    state.value = 'invalid';
    return;
  }
  state.value = 'launched';
  history.replaceState(null, '', window.location.pathname);
  // 唤起 VS Code；openUri/ticket 不离内存、不落 URL（replaceState 已清）。
  window.location.assign(openUri.value);
}

function retryLaunch() {
  // 仅内存复用已签发 ticket；过期后不再盲目重放，改为引导恢复（§5.4 步骤 5）。
  if (!openUri.value) return;
  if (isExpiredNow()) {
    expired.value = true;
    state.value = 'invalid';
    return;
  }
  window.location.assign(openUri.value);
}

function isExpiredNow(): boolean {
  return !!expiresTime.value && expiresTime.value.getTime() <= Date.now();
}

function retry() {
  void bootstrap();
}

function startCountdown() {
  if (!expiresTime.value) return;
  const tick = () => {
    const ms = expiresTime.value!.getTime() - Date.now();
    if (ms <= 0) {
      remaining.value = '0:00';
      expired.value = true;
      if (countdownId !== undefined) window.clearInterval(countdownId);
      return;
    }
    const s = Math.ceil(ms / 1000);
    remaining.value = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  countdownId = window.setInterval(tick, 1000);
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

    <template v-else-if="state === 'ready'">
      <p class="muted">{{ TEXT.ready }}</p>
      <p class="muted">{{ TEXT.sameAccountHint }}</p>
      <p v-if="remaining" class="muted">{{ TEXT.expiresIn }} {{ remaining }}</p>
      <button v-if="!expired" class="primary" @click="launch">{{ TEXT.openVsCode }}</button>
      <p v-else class="error">{{ TEXT.expired }}</p>
    </template>

    <template v-else-if="state === 'launched'">
      <p class="muted">{{ TEXT.launched }}</p>
      <p v-if="!expired" class="muted">{{ TEXT.expiresIn }} {{ remaining }}</p>
      <button v-if="!expired" class="primary" @click="retryLaunch">{{ TEXT.retryOpen }}</button>
      <p v-else class="error">{{ TEXT.expired }}</p>
    </template>

    <template v-else-if="state === 'invalid'">
      <p class="error">{{ TEXT.invalid }}</p>
      <p class="muted">{{ TEXT.invalidRecoverLink }}</p>
      <p class="muted">{{ TEXT.invalidRecoverVsCode }}</p>
    </template>

    <template v-else-if="state === 'rate-limited'">
      <p class="error">{{ TEXT.rateLimited }}（约 {{ rateLimitSeconds }} 秒）</p>
      <button class="primary" @click="retry">{{ TEXT.retry }}</button>
    </template>

    <template v-else-if="state === 'failure'">
      <p class="error">{{ TEXT.failure }}</p>
      <button v-if="canRetry" class="primary" @click="retry">{{ TEXT.retry }}</button>
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
</style>