<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue';
import { router, installRouter, navigate, withBase, stripBase, type RouteConfig } from './lib/router';
import { safeReturnTo } from './lib/returnTo';
import { refreshSession } from '@devbelt/auth-client';
import { getAccessToken, ensureCsrf, logout } from '@devbelt/auth-client';
import { me, type ConsoleMe } from './api/me';
import AccountView from './pages/AccountView.vue';
import DevicesView from './pages/DevicesView.vue';
import SyncView from './pages/SyncView.vue';
import OrdersView from './pages/OrdersView.vue';
import InvoicesView from './pages/InvoicesView.vue';
import CheckoutView from './pages/CheckoutView.vue';
import PlansView from './pages/PlansView.vue';
import OrganizationsView from './pages/OrganizationsView.vue';
import OrganizationDetailView from './pages/OrganizationDetailView.vue';
import ResourcesView from './pages/ResourcesView.vue';
import StatusPage from './pages/StatusPage.vue';

const ROUTES: RouteConfig[] = [
  { pattern: '/account', name: 'account' },
  { pattern: '/account/devices', name: 'devices' },
  { pattern: '/account/sync', name: 'sync' },
  { pattern: '/plans', name: 'plans' },
  { pattern: '/orders', name: 'orders' },
  { pattern: '/invoices', name: 'invoices' },
  { pattern: '/checkout', name: 'checkout' },
  { pattern: '/organizations', name: 'organizations' },
  { pattern: '/organizations/:id', name: 'organization-detail' },
  { pattern: '/organizations/:id/resources', name: 'organization-resources' },






];

installRouter(ROUTES);

const state = ref<'loading' | 'ready' | 'error'>('loading');
const me_ = ref<ConsoleMe | null>(null);
const logoutError = ref(false);


const view = computed<{ comp: Component; props: Record<string, unknown> }>(() => {
  switch (router.name) {
    case 'account':
      return { comp: AccountView, props: { user: me_.value?.user ?? null, subscription: me_.value?.subscription ?? null } };
    case 'devices':
      return { comp: DevicesView, props: {} };
    case 'sync':
      return { comp: SyncView, props: {} };
    case 'plans':
      return { comp: PlansView, props: { subscription: me_.value?.subscription ?? null } };
    case 'orders':
      return { comp: OrdersView, props: {} };
    case 'invoices':
      return { comp: InvoicesView, props: {} };
    case 'checkout':
      return { comp: CheckoutView, props: { user: me_.value?.user ?? null, subscription: me_.value?.subscription ?? null } };
    case 'organizations':
      return { comp: OrganizationsView, props: {} };
    case 'organization-detail':
      return { comp: OrganizationDetailView, props: { organizationId: router.params.id } };
    case 'organization-resources':
      return { comp: ResourcesView, props: { organizationId: router.params.id } };
    default:
      return { comp: StatusPage, props: { code: 404 } };
  }
});

function redirectToLogin(): void {
  const returnTo = safeReturnTo(stripBase(window.location.pathname));
  window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
}

onMounted(async () => {
  if (!getAccessToken()) {
    const refreshed = await refreshSession();
    if (refreshed.kind === 'unauthorized') {
      redirectToLogin();
      return;
    }
    if (refreshed.kind === 'failure') {
      state.value = 'error';
      return;
    }
  }
  const result = await me();
  if (result.kind === 'unauthorized') {
    redirectToLogin();
    return;
  }
  if (result.kind === 'failure') {
    state.value = 'error';
    return;
  }
  me_.value = result.value;
  state.value = 'ready';
  const p = stripBase(window.location.pathname);
  if (p === '/') navigate('/account');
});

async function onLogout(): Promise<void> {
  logoutError.value = false;
  const csrf = await ensureCsrf();
  const r = await logout(csrf);
  if (r.kind === 'ok') {
    window.location.assign('/login');
    return;
  }
  // 本机 token 已清除，但服务器 refresh-cookie 会话未被确认注销：提示并允许重试，避免静默假登出。
  logoutError.value = true;
}
</script>

<template>
  <main class="shell">
    <p v-if="state === 'loading'" class="muted">加载中…</p>
    <div v-else-if="state === 'error'" class="error-box">
      <p class="error">加载失败。</p>
      <a :href="'/login'">返回登录</a>
    </div>

    <template v-else-if="me_">
      <nav class="nav">
        <a class="brand" href="/">DB Client</a>
        <a class="home" href="/" title="返回 DevBelt 首页">首页</a>
        <a :href="withBase('/account')" @click.prevent="navigate('/account')" :class="{ on: router.name === 'account' }">账户</a>
        <a :href="withBase('/account/devices')" @click.prevent="navigate('/account/devices')" :class="{ on: router.name === 'devices' }">设备</a>
        <a :href="withBase('/account/sync')" @click.prevent="navigate('/account/sync')" :class="{ on: router.name === 'sync' }">同步</a>
        <a :href="withBase('/plans')" @click.prevent="navigate('/plans')" :class="{ on: router.name === 'plans' }">套餐</a>
        <a :href="withBase('/orders')" @click.prevent="navigate('/orders')" :class="{ on: router.name === 'orders' }">订单</a>
        <a :href="withBase('/invoices')" @click.prevent="navigate('/invoices')" :class="{ on: router.name === 'invoices' }">发票</a>
        <a :href="withBase('/organizations')" @click.prevent="navigate('/organizations')" :class="{ on: router.name === 'organizations' || router.name === 'organization-detail' || router.name === 'organization-resources' }">组织</a>
        <span class="spacer"></span>
        <span class="email">{{ me_.user.email }}</span>
        <button class="btn ghost" @click="onLogout">登出</button>
      </nav>

      <div v-if="logoutError" class="logout-warn" role="alert">
        <span>登出请求未得到服务器确认，本机登录态已清除。建议重试或关闭浏览器。</span>
        <button class="btn ghost" @click="onLogout">重试</button>
      </div>

      <div class="body">
        <component :is="view.comp" v-bind="view.props" />
      </div>
    </template>
  </main>
</template>

<style scoped>
.shell { min-height: 100vh; background: var(--c-bg); }
.nav {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 4px;
  height: 54px; padding: 0 24px;
  background: var(--c-surface); border-bottom: 1px solid var(--c-border);
}
.nav .brand { font-weight: 700; font-size: 15px; color: var(--c-text); margin-right: 8px; letter-spacing: -0.01em; text-decoration: none; padding: 0; }
.nav a.home { border-right: 1px solid var(--c-border); border-radius: 0; margin-right: 8px; }
.nav a {
  color: var(--c-text-muted); text-decoration: none; font-size: 13.5px;
  padding: 6px 12px; border-radius: var(--r-sm);
}
.nav a:hover { background: var(--c-surface-muted); color: var(--c-text); }
.nav a.on { color: var(--c-accent-text); background: var(--c-accent-bg); font-weight: 600; }
.spacer { flex: 1; }
.email { color: var(--c-text-muted); font-size: 13px; margin-right: 4px; }
.body { max-width: 960px; margin: 0 auto; padding: 32px 24px 64px; }
.btn { background: var(--c-success); color: var(--c-surface); border: none; height: 32px; padding: 0 14px; border-radius: var(--r-md); font-size: 13px; font-weight: 600; cursor: pointer; }
.btn:hover { filter: brightness(0.96); }
.btn.ghost { background: transparent; color: var(--c-text-muted); border: 1px solid var(--c-border-strong); font-weight: 500; }
.muted { color: var(--c-text-muted); }
.error { color: var(--c-danger); }
.error-box { padding: 80px 24px; text-align: center; }
.loadout-warn, .logout-warn {
  display: flex; align-items: center; gap: 12px; max-width: 960px; margin: 0 auto;
  padding: 10px 24px; background: var(--c-warn-bg); border-bottom: 1px solid var(--c-warn-border);
  color: var(--c-warn-text); font-size: 13px;
}
.logout-warn .btn { height: 28px; }
</style>
