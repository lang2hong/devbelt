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
} as const;

const FEATURE_NAMES: Record<number, string> = {
  [Feature.er_export]: 'ER Diagram',
  [Feature.excel]: 'Excel Import/Export',
  [Feature.datatransfer]: 'Data Transfer',
  [Feature.team_share]: 'Team Sharing',
  [Feature.audit_log]: 'Audit Log',
};

/**
 * 收费前置校验：检查当前套餐是否含某功能。
 * 用 cachedPlan（SyncStatusBar 刷新时填）避免每次网络；
 * 无缓存则临时 getMe；网络失败降级放行（不阻断用户）。
 * 无权限时提示升级，返回 false。
 */
export async function requireFeature(auth: AuthService, feature: number): Promise<boolean> {
  let plan = auth.getCachedPlan();
  if (!plan) {
    try {
      const me = await auth.client.getMe();
      auth.setCachedPlan(me.plan);
      plan = me.plan;
    } catch {
      return true; // 网络失败不阻断
    }
  }
  if ((plan.features & feature) === feature) return true;
  const name = FEATURE_NAMES[feature] || 'This feature';
  const choice = await vscode.window.showInformationMessage(
    `${name} requires a Pro or Team plan.`,
    'Upgrade',
  );
  if (choice === 'Upgrade') void vscode.commands.executeCommand('dbclient.login');
  return false;
}
