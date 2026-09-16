<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue';
import { router, installRouter, navigate, type RouteConfig } from './lib/router';
import { safeReturnTo } from './lib/returnTo';
import { refreshSession } from './session';
import { getAccessToken, ensureCsrf, logout } from './api/consoleAuth';
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
import AdminUsersView from './pages/AdminUsersView.vue';
import AdminOrganizationsView from './pages/AdminOrganizationsView.vue';
import AdminOrdersView from './pages/AdminOrdersView.vue';
import AdminInvoicesView from './pages/AdminInvoicesView.vue';
import AdminAuditView from './pages/AdminAuditView.vue';
import AdminVersionView from './pages/AdminVersionView.vue';
import StatusPage from './pages/StatusPage.vue';

const ROUTES: RouteConfig[] = [
  { pattern: '/console/account', name: 'account' },
  { pattern: '/console/account/devices', name: 'devices' },
  { pattern: '/console/account/sync', name: 'sync' },
  { pattern: '/console/plans', name: 'plans' },
  { pattern: '/console/orders', name: 'orders' },
  { pattern: '/console/invoices', name: 'invoices' },
  { pattern: '/console/checkout', name: 'checkout' },
  { pattern: '/console/organizations', name: 'organizations' },
  { pattern: '/console/organizations/:id', name: 'organization-detail' },
  { pattern: '/console/organizations/:id/resources', name: 'organization-resources' },
  { pattern: '/console/admin/users', name: 'admin-users' },
  { pattern: '/console/admin/organizations', name: 'admin-organizations' },
  { pattern: '/console/admin/orders', name: 'admin-orders' },
  { pattern: '/console/admin/invoices', name: 'admin-invoices' },
  { pattern: '/console/admin/audit', name: 'admin-audit' },
  { pattern: '/console/admin/version', name: 'admin-version' },
];

installRouter(ROUTES);

const state = ref<'loading' | 'ready' | 'error'>('loading');
const me_ = ref<ConsoleMe | null>(null);
const logoutError = ref(false);

const view = computed<{ comp: Component; props: Record<string, unknown> }>(() => {
  // 防御纵深：即使直接导航到 /console/admin/*，非平台管理员也只看到 403（服务端同样拒绝）。
  if (router.name && router.name.startsWith('admin-') && !me_.value?.platformAdmin) {
    return { comp: StatusPage, props: { code: 403 } };
  }
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
    case 'admin-users':
      return { comp: AdminUsersView, props: {} };
    case 'admin-organizations':
      return { comp: AdminOrganizationsView, props: {} };
    case 'admin-orders':
      return { comp: AdminOrdersView, props: {} };
    case 'admin-invoices':
      return { comp: AdminInvoicesView, props: {} };
    case 'admin-audit':
      return { comp: AdminAuditView, props: {} };
    case 'admin-version':
      return { comp: AdminVersionView, props: {} };
    default:
      return { comp: StatusPage, props: { code: 404 } };
  }
});

function redirectToLogin(): void {
  const returnTo = safeReturnTo(window.location.pathname);
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
  const p = window.location.pathname;
  if (p === '/console' || p === '/console/') navigate('/console/account');
  if (p === '/console/admin' || p === '/console/admin/') navigate('/console/admin/users');
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
      <a href="/login">返回登录</a>
    </div>

    <template v-else-if="me_">
      <nav class="nav">
        <span class="brand">DB Client</span>
        <a href="/console/account" @click.prevent="navigate('/console/account')" :class="{ on: router.name === 'account' }">账户</a>
        <a href="/console/account/devices" @click.prevent="navigate('/console/account/devices')" :class="{ on: router.name === 'devices' }">设备</a>
        <a href="/console/account/sync" @click.prevent="navigate('/console/account/sync')" :class="{ on: router.name === 'sync' }">同步</a>
        <a href="/console/plans" @click.prevent="navigate('/console/plans')" :class="{ on: router.name === 'plans' }">套餐</a>
        <a href="/console/orders" @click.prevent="navigate('/console/orders')" :class="{ on: router.name === 'orders' }">订单</a>
        <a href="/console/invoices" @click.prevent="navigate('/console/invoices')" :class="{ on: router.name === 'invoices' }">发票</a>
        <a href="/console/organizations" @click.prevent="navigate('/console/organizations')" :class="{ on: router.name === 'organizations' || router.name === 'organization-detail' || router.name === 'organization-resources' }">组织</a>
        <a v-if="me_.platformAdmin" href="/console/admin/users" @click.prevent="navigate('/console/admin/users')" :class="{ on: ['admin-users', 'admin-organizations', 'admin-orders', 'admin-invoices', 'admin-audit', 'admin-version'].includes(router.name ?? '') }">管理</a>
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
.shell { min-height: 100vh; background: #f6f8fa; }
.nav { display: flex; align-items: center; gap: 16px; padding: 12px 24px; background: #fff; border-bottom: 1px solid #d0d7de; }
.brand { font-weight: 700; color: #0f172a; margin-right: 8px; }
.nav a { color: #57606a; text-decoration: none; font-size: 14px; padding: 2px 0; }
.nav a.on { color: #0969da; font-weight: 600; border-bottom: 2px solid #0969da; }
.spacer { flex: 1; }
.email { color: #57606a; font-size: 13px; }
.body { max-width: 860px; margin: 0 auto; padding: 32px 24px; }
.btn { background: #0969da; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
.btn.ghost { background: transparent; color: #57606a; border: 1px solid #d0d7de; }
.muted { color: #57606a; }
.error { color: #cf222e; }
.error-box { padding: 80px 24px; text-align: center; }
.logout-warn { display: flex; align-items: center; gap: 12px; max-width: 860px; margin: 0 auto; padding: 10px 24px; background: #fff8c5; border-bottom: 1px solid #d4a72c; color: #9a6700; font-size: 13px; }
.logout-warn .btn { padding: 5px 12px; }
</style>