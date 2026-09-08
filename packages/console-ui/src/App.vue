<script setup lang="ts">
import { onMounted, ref, watchEffect } from 'vue';
import { ensureCsrf, getAccessToken, me, logout, refresh } from './api/consoleAuth';

const state = ref<'loading' | 'ready' | 'unauthorized' | 'error'>('loading');
const user = ref<{ email: string; displayName: string | null } | null>(null);

let redirected = false;
watchEffect(() => {
  if (state.value === 'unauthorized' && !redirected) {
    redirected = true;
    window.location.assign('/login');
  }
});

onMounted(async () => {
  // 会话恢复：内存无 access token 时，尝试用 refresh cookie 静默续一次（§4.3）。
  if (!getAccessToken()) {
    const csrf = await ensureCsrf();
    const refreshed = await refresh(csrf);
    if (refreshed.kind !== 'ok') {
      state.value = 'unauthorized';
      return;
    }
  }
  const result = await me();
  if (result.kind === 'ok') {
    user.value = result.value.user;
    state.value = 'ready';
  } else if (result.kind === 'unauthorized') {
    state.value = 'unauthorized';
  } else {
    state.value = 'error';
  }
});

async function onLogout() {
  const csrf = await ensureCsrf();
  await logout(csrf);
  window.location.assign('/login');
}
</script>

<template>
  <main class="shell">
    <p v-if="state === 'loading'" class="muted">加载中…</p>
    <p v-else-if="state === 'error'" class="error">加载失败，请刷新重试。</p>
    <template v-else-if="user">
      <h1>账户</h1>
      <p>{{ user.email }}</p>
      <p><a href="/console/organizations">组织</a>（即将上线）</p>
      <button class="btn" @click="onLogout">登出</button>
    </template>
  </main>
</template>

<style scoped>
.shell { max-width: 600px; margin: 80px auto; padding: 28px 32px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; }
h1 { font-size: 20px; font-weight: 700; color: #0f172a; }
.muted { color: #57606a; }
.error { color: #cf222e; }
.btn { background: #0969da; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
</style>