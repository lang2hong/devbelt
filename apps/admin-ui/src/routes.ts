import type { RouteConfig } from './lib/router';

/**
 * 平台后台路由表。
 *
 * `/` 映射到用户页（默认落地页）：否则从 `/admin/` 进入时路径为 `/`，匹配不到任何
 * 路由，会命中 App.vue 的「页面不存在」分支。进入后 `App.vue` 会把 `/` 规范化为
 * `ADMIN_DEFAULT_PATH`。
 */
export const ADMIN_ROUTES: RouteConfig[] = [
  { pattern: '/', name: 'admin-users' },
  { pattern: '/users', name: 'admin-users' },
  { pattern: '/orders', name: 'admin-orders' },
  { pattern: '/invoices', name: 'admin-invoices' },
  { pattern: '/audit', name: 'admin-audit' },
  { pattern: '/plans', name: 'admin-plans' },
  { pattern: '/ai-topup', name: 'admin-ai-topup' },
  { pattern: '/ai-providers', name: 'admin-ai-providers' },
  { pattern: '/ai-billing', name: 'admin-ai-billing' },
  { pattern: '/version', name: 'admin-version' },
];

/** 默认落地路径（`/` 规范化目标）。 */
export const ADMIN_DEFAULT_PATH = '/users';