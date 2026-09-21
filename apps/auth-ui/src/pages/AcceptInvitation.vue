<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase } from '../lib/router';
import {
  claimLinkFlow,
  acceptInvitation,
  bindMailFlow,
  type AcceptInvitationOrganization,
} from '@devbelt/auth-client';
import { ensureCsrf, refresh, getAccessToken } from '@devbelt/auth-client';

/** DB 控制台（db-ui）的挂载 base；身份页在根。 */
const DB_BASE = '/db';

const TEXT = {
  title: '接受组织邀请',
  processing: '正在处理…',
  success: '已加入组织。',
  alreadyAccepted: '你已加入该组织。',
  invalid: '邀请链接无效或已过期，请让管理员重新邀请。',
  failure: '处理失败，请检查网络后重试。',
  retry: '重试',
  enter: '进入控制台',
} as const;

type State = 'processing' | 'success' | 'already-accepted' | 'invalid' | 'failure';

// 一次性 token 只从地址栏读一次，读后立即清理（§5.1：不进入 returnTo/历史/日志）。
// 仅在内存保留，用于认领阶段失败时的重试；刷新/关闭页面后不可恢复。
const token = readToken();
const state = ref<State>('processing');
const canRetry = ref(false);
const organization = ref<AcceptInvitationOrganization | null>(null);

let csrfToken = '';
// claim 是否已成功（已持有 link-flow cookie）。失败前保持 false，使重试重新认领。
let claimDone = false;

onMounted(async () => {
  if (token) {
    history.replaceState(null, '', window.location.pathname);
  }
  csrfToken = await ensureCsrf();
  await bootstrap();
});

async function bootstrap() {
  state.value = 'processing';
  canRetry.value = false;

  if (token && !claimDone) {
    const claimed = await claimLinkFlow('accept-invitation', token);
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

  await authenticateAndAccept();
}

async function authenticateAndAccept() {
  state.value = 'processing';
  canRetry.value = false;
  const csrf = csrfToken || (csrfToken = await ensureCsrf());
  const refreshed = await refresh(csrf);
  if (refreshed.kind === 'invalid-credentials') {
    // 未登录：跳登录页，登录成功后回到干净的 /accept-invitation（不含 token）。
    window.location.assign(withBase('/login?flow=accept-invitation'));
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

  // 消费前置：显式绑定 held mail-flow 到当前用户（§5.3 裁定）。
  const bound = await bindMailFlow(csrf, accessToken);
  if (bound.kind === 'invalid') {
    state.value = 'invalid';
    return;
  }
  if (bound.kind === 'unauthorized') {
    window.location.assign(withBase('/login?flow=accept-invitation'));
    return;
  }
  if (bound.kind === 'failure') {
    state.value = 'failure';
    canRetry.value = true;
    return;
  }

  await doAccept(accessToken, csrf);
}

async function doAccept(accessToken: string, csrf: string) {
  state.value = 'processing';
  canRetry.value = false;
  const result = await acceptInvitation(csrf, accessToken);
  if (result.kind === 'success') {
    state.value = 'success';
    organization.value = result.organization;
  } else if (result.kind === 'already-accepted') {
    state.value = 'already-accepted';
    organization.value = result.organization;
  } else if (result.kind === 'invalid') {
    state.value = 'invalid';
  } else if (result.kind === 'unauthorized') {
    window.location.assign(withBase('/login?flow=accept-invitation'));
  } else {
    state.value = 'failure';
    canRetry.value = true;
  }
}

function retry() {
  void bootstrap();
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

    <template v-else-if="state === 'success' || state === 'already-accepted'">
      <p class="success">{{ state === 'success' ? TEXT.success : TEXT.alreadyAccepted }}</p>
      <p v-if="organization" class="muted">组织：{{ organization.name }}</p>
      <a class="button primary" :href="`${DB_BASE}/organizations`">{{ TEXT.enter }}</a>
    </template>

    <template v-else-if="state === 'failure'">
      <p class="error">{{ TEXT.failure }}</p>
      <button v-if="canRetry" class="button primary" @click="retry">{{ TEXT.retry }}</button>
    </template>

    <template v-else-if="state === 'invalid'">
      <p class="error">{{ TEXT.invalid }}</p>
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

.button {
  display: inline-block;
  text-decoration: none;
}

button.primary,
a.button.primary {
  background: var(--c-accent);
  color: var(--c-surface);
  border: none;
  padding: 12px 32px;
  border-radius: 6px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  margin: 22px 0;
}
</style>