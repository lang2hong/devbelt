import * as vscode from 'vscode';
import type { AuthService } from './authService';
import { l10n } from '../i18n';

export interface AuthStatusBar {
  refresh(): void;
}

/**
 * 登录状态栏（常驻，左右与同步状态栏相邻）。
 *
 * - 未登录：`$(account) 未登录`；已登录：`$(account) <邮箱>`。
 * - 点击统一弹出菜单（`devbelt.accountMenu`）：登录 / 账户中心 / 同步 / 立即同步 /
 *   打开控制台 / 退出登录。
 *
 * 与 `syncStatusBar` 互补：同步项仅在登录后出现，本项在未登录时也给出可见入口。
 */
export function createAuthStatusBar(context: vscode.ExtensionContext, auth: AuthService): AuthStatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(item);

  function refresh(): void {
    item.command = 'devbelt.accountMenu';
    if (!auth.isLoggedIn()) {
      item.text = `$(account) ${l10n('auth.status.loggedOut')}`;
      item.tooltip = l10n('auth.status.loginHint');
      item.show();
      return;
    }
    item.text = `$(account) ${l10n('auth.status.loggedIn')}`;
    item.tooltip = l10n('auth.status.accountHint');
    item.show();
    void auth.getEmail().then((email) => {
      if (!auth.isLoggedIn()) return; // 查邮箱期间已登出（竞态）
      if (email) item.text = `$(account) ${email}`;
    });
  }

  refresh();
  return { refresh };
}
