import * as vscode from 'vscode';
import type { AuthService } from './authService';

/**
 * 功能位标志（与 server domain/enums.ts Feature 对齐）。
 * 套餐 features 字段为位掩码；按位与判断是否可用。
 */
export const Feature = {
  basic: 1,
  er_export: 2,
  excel: 4,
  datatransfer: 8,
  team_share: 16,
  audit_log: 32,
  export_connections: 64,
} as const;

const FEATURE_NAMES: Record<number, string> = {
  [Feature.er_export]: 'ER Diagram',
  [Feature.excel]: 'Excel Import/Export',
  [Feature.datatransfer]: 'Data Transfer',
  [Feature.team_share]: 'Team Sharing',
  [Feature.audit_log]: 'Audit Log',
  [Feature.export_connections]: 'Export Connections',
};

function featureName(feature: number): string {
  return FEATURE_NAMES[feature] || 'This feature';
}

/**
 * 收费前置校验：检查当前套餐是否含某功能。
 * 用 cachedPlan（SyncStatusBar 刷新时填）避免每次网络；
 * 无缓存则临时 getMe；网络失败降级放行（不阻断用户）。
 * 无权限时提示升级，返回 false。
 */
export async function requireFeature(auth: AuthService, feature: number): Promise<boolean> {
  const name = featureName(feature);
  // 未登录：付费能力直接拦截并引导登录。此前未登录会被下面 catch 当「网络失败」
  // 放行（getMe 抛 401 → return true），等于未登录用户白嫖所有付费功能。
  if (!auth.isLoggedIn()) {
    const choice = await vscode.window.showInformationMessage(
      `${name} requires a Pro or Team plan. Sign in to continue.`,
      'Login',
    );
    if (choice === 'Login') void vscode.commands.executeCommand('dbclient.login');
    return false;
  }
  let plan = auth.getCachedPlan();
  if (!plan) {
    try {
      const me = await auth.client.getMe();
      auth.setCachedPlan(me.plan);
      plan = me.plan;
    } catch {
      return true; // 已登录但网络失败，不阻断
    }
  }
  if ((plan.features & feature) === feature) return true;
  const choice = await vscode.window.showInformationMessage(
    `${name} requires a Pro or Team plan.`,
    'Upgrade',
  );
  if (choice === 'Upgrade') void vscode.commands.executeCommand('dbclient.account');
  return false;
}

/**
 * 取「同时打开的连接数」上限。
 *
 * 返回 undefined = 不限；返回正整数 = 上限。孱弱网络下的取舍：
 *
 *  - 未登录：本地固定 1，不依赖网络（逼登录，也防止匿名白嫖多开）。
 *  - 已登录且有缓存（内存或 globalState 持久化）：直接按套餐限制，无网络也正确。
 *  - 已登录但无任何缓存且 getMe 失败（首次使用遇到弱网）：**放行**，
 *    宁可少拦一次，也不把付费用户在弱网下锁死。
 */
export async function resolveMaxOpenConnections(auth: AuthService): Promise<number | undefined> {
  if (!auth.isLoggedIn()) return 1;
  let plan = auth.getCachedPlan();
  if (!plan) {
    try {
      const me = await auth.client.getMe();
      auth.setCachedPlan(me.plan);
      plan = me.plan;
    } catch {
      return undefined; // 已登录但网络失败，放行
    }
  }
  return plan.perUserMaxOpenConnections > 0 ? plan.perUserMaxOpenConnections : undefined; // 0 = 无限
}

/**
 * 取「可保存的连接总数」上限（perUserMaxPrivateConnections）。
 * 语义与 resolveMaxOpenConnections 一致：连到 sync push 的 server 端校验，
 * 这里在本地保存时提前拦截，避免本地超配后同步反复 403 的割裂体验。
 * 未登录按 free 上限 10 拦（引导登录）；0 = 无限。
 */
export async function resolveMaxConnections(auth: AuthService): Promise<number | undefined> {
  if (!auth.isLoggedIn()) return 10;
  let plan = auth.getCachedPlan();
  if (!plan) {
    try {
      const me = await auth.client.getMe();
      auth.setCachedPlan(me.plan);
      plan = me.plan;
    } catch {
      return undefined; // 已登录但网络失败，放行
    }
  }
  return plan.perUserMaxPrivateConnections > 0 ? plan.perUserMaxPrivateConnections : undefined; // 0 = 无限
}
