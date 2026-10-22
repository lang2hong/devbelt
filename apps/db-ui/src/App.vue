<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue';
import { router, installRouter, navigate, withBase, stripBase, type RouteConfig } from './lib/router';
import { safeReturnTo } from './lib/returnTo';
import { refreshSession } from '@devbelt/auth-client';
import { getAccessToken, ensureCsrf, logout } from '@devbelt/auth-client';
import { me, type ConsoleMe } from './api/me';
import { applyTheme, getTheme, nextTheme, THEME_LABEL, type ThemeChoice } from './lib/theme';
import AccountView from './pages/AccountView.vue';
import DevicesView from './pages/DevicesView.vue';
import SyncView from './pages/SyncView.vue';
import OrdersView from './pages/OrdersView.vue';
import InvoicesView from './pages/InvoicesView.vue';
import CheckoutView from './pages/CheckoutView.vue';
import AiTopupView from './pages/AiTopupView.vue';
import PlansView from './pages/PlansView.vue';
import StatusPage from './pages/StatusPage.vue';
import AuthenticatorView from './pages/AuthenticatorView.vue';

const ROUTES: RouteConfig[] = [
  { pattern: '/account', name: 'account' },
  { pattern: '/account/devices', name: 'devices' },
  { pattern: '/account/sync', name: 'sync' },
  { pattern: '/account/authenticator', name: 'authenticator' },
  { pattern: '/plans', name: 'plans' },
  { pattern: '/orders', name: 'orders' },
  { pattern: '/invoices', name: 'invoices' },
  { pattern: '/checkout', name: 'checkout' },
  { pattern: '/ai-topup', name: 'ai-topup' },






];

/** 分组导航：账户类 / 订阅与账单类（checkout 属于后者，无子项高亮）。 */
const NAV = [
  { title: '账户', names: ['account', 'devices', 'sync', 'authenticator'], links: [
    { name: 'account', path: '/account', label: '概览' },
    { name: 'devices', path: '/account/devices', label: '设备' },
    { name: 'sync', path: '/account/sync', label: '同步' },
    { name: 'authenticator', path: '/account/authenticator', label: '验证器' },
  ] },
  { title: '订阅与账单', names: ['plans', 'orders', 'invoices', 'ai-topup', 'checkout'], links: [
    { name: 'plans', path: '/plans', label: '套餐' },
    { name: 'orders', path: '/orders', label: '订单' },
    { name: 'invoices', path: '/invoices', label: '发票' },
    { name: 'ai-topup', path: '/ai-topup', label: 'AI 积分' },
  ] },
];
const activeGroup = computed(() => NAV.find((g) => g.names.includes(router.name ?? '')) ?? null);

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
    case 'authenticator':
      return { comp: AuthenticatorView, props: { user: me_.value?.user ?? null } };
    case 'plans':
      return { comp: PlansView, props: { subscription: me_.value?.subscription ?? null } };
    case 'orders':
      return { comp: OrdersView, props: {} };
    case 'invoices':
      return { comp: InvoicesView, props: {} };
    case 'checkout':
      return { comp: CheckoutView, props: { user: me_.value?.user ?? null, subscription: me_.value?.subscription ?? null } };
    case 'ai-topup':
      return { comp: AiTopupView, props: {} };
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

const theme = ref<ThemeChoice>(getTheme());
function toggleTheme(): void {
  theme.value = nextTheme(theme.value);
  applyTheme(theme.value);
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
      <header class="top">
        <nav class="nav" aria-label="主导航">
          <a class="brand" href="/">DevBelt</a>
          <a class="home" href="/" title="返回 DevBelt 首页">首页</a>
          <a
            v-for="g in NAV"
            :key="g.title"
            :href="withBase(g.links[0]!.path)"
            :class="{ on: g === activeGroup }"
            @click.prevent="navigate(g.links[0]!.path)"
          >{{ g.title }}</a>
          <span class="spacer"></span>
          <span class="email">{{ me_.user.email }}</span>
          <button class="btn small ghost" :title="'主题：' + THEME_LABEL[theme]" @click="toggleTheme">{{ THEME_LABEL[theme] }}</button>
          <button class="btn ghost small" @click="onLogout">登出</button>
        </nav>
        <nav v-if="activeGroup" class="subnav" aria-label="子导航">
          <a
            v-for="l in activeGroup.links"
            :key="l.name"
            :href="withBase(l.path)"
            :class="{ on: router.name === l.name }"
            @click.prevent="navigate(l.path)"
          >{{ l.label }}</a>
        </nav>
      </header>

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
.top { position: sticky; top: 0; z-index: 10; background: var(--c-surface); border-bottom: 1px solid var(--c-border); }
.nav { display: flex; align-items: center; gap: 4px; height: 54px; padding: 0 24px; }
.nav .brand { font-weight: 700; font-size: 15px; color: var(--c-text); margin-right: 8px; letter-spacing: -0.01em; text-decoration: none; padding: 0; }
.nav a.home { border-right: 1px solid var(--c-border); border-radius: 0; margin-right: 8px; }
.nav a { color: var(--c-text-muted); text-decoration: none; font-size: 14px; padding: 6px 12px; border-radius: var(--r-sm); }
.nav a:hover { background: var(--c-surface-muted); color: var(--c-text); }
.nav a.on { color: var(--c-accent-text); background: var(--c-accent-bg); font-weight: 600; }
.subnav { display: flex; gap: 20px; padding: 0 24px; border-top: 1px solid var(--c-divider); background: var(--c-surface); }
.subnav a { padding: 10px 2px; font-size: 13.5px; color: var(--c-text-muted); text-decoration: none; border-bottom: 2px solid transparent; }
.subnav a:hover { color: var(--c-text); }
.subnav a.on { color: var(--c-text); font-weight: 600; border-bottom-color: var(--c-accent); }
.spacer { flex: 1; }
.email { color: var(--c-text-muted); font-size: 13px; margin-right: 4px; }
.body { max-width: 960px; margin: 0 auto; padding: 28px 24px 64px; }
.error-box { padding: 80px 24px; text-align: center; }
.logout-warn {
  display: flex; align-items: center; gap: 12px; max-width: 960px; margin: 0 auto;
  padding: 10px 24px; background: var(--c-warn-bg); border-bottom: 1px solid var(--c-warn-border);
  color: var(--c-warn-text); font-size: 13px;
}
</style>
