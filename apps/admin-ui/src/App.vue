<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue';
import { router, installRouter, navigate, withBase, stripBase } from './lib/router';
import { safeReturnTo } from './lib/returnTo';
import { ADMIN_DEFAULT_PATH, ADMIN_ROUTES } from './routes';
import { refreshSession, getAccessToken, logout } from '@devbelt/auth-client';
import { me, type ConsoleMe } from './api/me';
import { applyTheme, getTheme, nextTheme, THEME_LABEL, type ThemeChoice } from './lib/theme';
import AdminNav from './pages/AdminNav.vue';
import AdminUsersView from './pages/AdminUsersView.vue';
import AdminUserDetailView from './pages/AdminUserDetailView.vue';
import AdminOrdersView from './pages/AdminOrdersView.vue';
import AdminInvoicesView from './pages/AdminInvoicesView.vue';
import AdminAuditView from './pages/AdminAuditView.vue';
import AdminPlansView from './pages/AdminPlansView.vue';
import AdminAiTopupView from './pages/AdminAiTopupView.vue';
import AdminAiProvidersView from './pages/AdminAiProvidersView.vue';
import AdminAiBillingView from './pages/AdminAiBillingView.vue';
import AdminVersionView from './pages/AdminVersionView.vue';
import AdminOverviewView from './pages/AdminOverviewView.vue';
import AdminFeedbackView from './pages/AdminFeedbackView.vue';

installRouter(ADMIN_ROUTES);

// `/admin/`（应用内路径 `/`）规范化到默认落地页，避免停在非规范 URL。
if (router.pathname === '/') navigate(ADMIN_DEFAULT_PATH);

const state = ref<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
const me_ = ref<ConsoleMe | null>(null);
const logoutError = ref(false);

const view = computed<{ comp: Component | null; props: Record<string, unknown> }>(() => {
  switch (router.name) {
    case 'admin-overview': return { comp: AdminOverviewView, props: {} };
    case 'admin-feedback': return { comp: AdminFeedbackView, props: {} };
    case 'admin-users': return { comp: AdminUsersView, props: {} };
    case 'admin-user-detail': return { comp: AdminUserDetailView, props: { userId: router.params.id ?? '' } };
    case 'admin-orders': return { comp: AdminOrdersView, props: {} };
    case 'admin-invoices': return { comp: AdminInvoicesView, props: {} };
    case 'admin-audit': return { comp: AdminAuditView, props: {} };
    case 'admin-plans': return { comp: AdminPlansView, props: {} };
    case 'admin-ai-topup': return { comp: AdminAiTopupView, props: {} };
    case 'admin-ai-providers': return { comp: AdminAiProvidersView, props: {} };
    case 'admin-ai-billing': return { comp: AdminAiBillingView, props: {} };
    case 'admin-version': return { comp: AdminVersionView, props: {} };
    default: return { comp: null, props: {} };
  }
});

function redirectToLogin(): void {
  const p = stripBase(window.location.pathname);
  // 本地先过 safeReturnTo，不依赖登录页兜底：即使登录页未来漏了校验，也不会带出开放重定向。
  const ret = safeReturnTo(p === '/' ? ADMIN_DEFAULT_PATH : p);
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

const theme = ref<ThemeChoice>(getTheme());
function toggleTheme(): void {
  theme.value = nextTheme(theme.value);
  applyTheme(theme.value);
}
</script>

<template>
  <div class="shell">
    <aside class="side">
      <div class="brand"><span class="logo">D</span>DevBelt<small>平台后台</small></div>
      <AdminNav v-if="state === 'ready'" />
      <div class="side-foot" v-if="me_">
        <span class="email" :title="me_.user.email">{{ me_.user.email }}</span>
        <button class="btn small ghost" :title="'主题：' + THEME_LABEL[theme]" @click="toggleTheme">{{ THEME_LABEL[theme] }}</button>
        <button class="btn small ghost" @click="onLogout">登出</button>
      </div>
    </aside>

    <main class="body">
      <div v-if="logoutError" class="logout-warn" role="alert">登出请求未得到服务器确认。</div>
      <p v-if="state === 'loading'" class="muted">加载中…</p>
      <p v-else-if="state === 'forbidden'">需要平台管理员权限。</p>
      <p v-else-if="state === 'error'">加载失败，请刷新重试。</p>
      <template v-else-if="state === 'ready'">
        <component :is="view.comp" v-bind="view.props" />
        <p v-if="!view.comp">页面不存在。<a :href="withBase('/users')" @click.prevent="navigate('/users')">返回用户</a></p>
      </template>
    </main>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); background: var(--c-bg); }
.side {
  position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 20px;
  padding: 18px 12px; background: var(--c-surface); border-right: 1px solid var(--c-border); overflow-y: auto;
}
.brand { display: flex; align-items: center; gap: 8px; padding: 0 8px 4px; font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
.brand small { font-weight: 500; font-size: 12px; color: var(--c-text-subtle); }
.logo { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; background: var(--c-accent); color: var(--c-on-accent); font-size: 14px; }
.side-foot { margin-top: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 8px 0; border-top: 1px solid var(--c-border); }
.email { flex: 1 1 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--c-text-muted); }
.body { padding: 28px 32px 64px; max-width: 1280px; width: 100%; }
.logout-warn {
  margin-bottom: 16px; padding: 10px 14px; border: 1px solid var(--c-warn-border); border-radius: var(--r-md);
  background: var(--c-warn-bg); color: var(--c-warn-text); font-size: 13px;
}
@media (max-width: 860px) {
  .shell { grid-template-columns: 1fr; }
  .side { position: static; height: auto; flex-direction: row; flex-wrap: wrap; }
  .body { padding: 20px 16px 48px; }
}
</style>
