<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue';
import { router, installRouter, navigate, withBase, stripBase, type RouteConfig } from './lib/router';
import { refreshSession, getAccessToken, logout } from '@devkit/auth-client';
import { me, type ConsoleMe } from './api/me';
import AdminNav from './pages/AdminNav.vue';
import AdminUsersView from './pages/AdminUsersView.vue';
import AdminOrganizationsView from './pages/AdminOrganizationsView.vue';
import AdminOrdersView from './pages/AdminOrdersView.vue';
import AdminInvoicesView from './pages/AdminInvoicesView.vue';
import AdminAuditView from './pages/AdminAuditView.vue';
import AdminPlansView from './pages/AdminPlansView.vue';
import AdminVersionView from './pages/AdminVersionView.vue';

const ROUTES: RouteConfig[] = [
  { pattern: '/users', name: 'admin-users' },
  { pattern: '/organizations', name: 'admin-organizations' },
  { pattern: '/orders', name: 'admin-orders' },
  { pattern: '/invoices', name: 'admin-invoices' },
  { pattern: '/audit', name: 'admin-audit' },
  { pattern: '/plans', name: 'admin-plans' },
  { pattern: '/version', name: 'admin-version' },
];

installRouter(ROUTES);

const state = ref<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
const me_ = ref<ConsoleMe | null>(null);
const logoutError = ref(false);

const view = computed<{ comp: Component | null; props: Record<string, unknown> }>(() => {
  switch (router.name) {
    case 'admin-users': return { comp: AdminUsersView, props: {} };
    case 'admin-organizations': return { comp: AdminOrganizationsView, props: {} };
    case 'admin-orders': return { comp: AdminOrdersView, props: {} };
    case 'admin-invoices': return { comp: AdminInvoicesView, props: {} };
    case 'admin-audit': return { comp: AdminAuditView, props: {} };
    case 'admin-plans': return { comp: AdminPlansView, props: {} };
    case 'admin-version': return { comp: AdminVersionView, props: {} };
    default: return { comp: null, props: {} };
  }
});

function redirectToLogin(): void {
  const p = stripBase(window.location.pathname);
  const ret = p === '/' ? '/users' : p;
  window.location.assign(`/login?returnTo=${encodeURIComponent(`/admin${ret}`)}`);
}

onMounted(async () => {
  const refreshed = await refreshSession();
  if (refreshed.kind === 'unauthorized' || getAccessToken() === null) {
    redirectToLogin();
    return;
  }
  const result = await me();
  if (result.kind === 'ok') {
    me_.value = result.value;
    state.value = result.value.platformAdmin ? 'ready' : 'forbidden';
  } else if (result.kind === 'unauthorized') {
    redirectToLogin();
  } else {
    state.value = 'error';
  }
});

async function onLogout(): Promise<void> {
  logoutError.value = false;
  const result = await logout();
  if (result.kind === 'ok') {
    window.location.assign('/login');
    return;
  }
  logoutError.value = true;
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <span class="brand">DevBelt 平台后台</span>
      <span class="spacer" />
      <template v-if="me_">
        <span class="email">{{ me_.user.email }}</span>
        <button class="btn ghost" @click="onLogout">登出</button>
      </template>
    </header>

    <main class="body">
      <p v-if="state === 'loading'">加载中…</p>
      <p v-else-if="state === 'forbidden'">需要平台管理员权限。</p>
      <p v-else-if="state === 'error'">加载失败，请刷新重试。</p>
      <template v-else-if="state === 'ready'">
        <AdminNav />
        <component :is="view.comp" v-bind="view.props" />
        <p v-if="!view.comp">页面不存在。<a :href="withBase('/users')" @click.prevent="navigate('/users')">返回用户</a></p>
      </template>
    </main>

    <div v-if="logoutError" class="logout-warn" role="alert">登出请求未得到服务器确认。</div>
  </div>
</template>