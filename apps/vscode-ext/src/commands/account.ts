import * as vscode from 'vscode';
import type { Deps, Sub } from './shared';
import { LoginFormView } from '../sync/loginFormView';
import { AccountHubView } from '../sync/accountHubView';
import { DEFAULT_SERVER_URL } from '../sync/authService';
import { l10n } from '../i18n';

/**
 * 账户与登录入口（应用账号层面，区别于 `user.ts` 的数据库实例用户管理）。
 *
 * 这四条命令曾随 V2 同步删除而悬空（有声明无 handler）：登录/注册、账户面板、
 * 会话/设备管理、登出。这里重新接到现有 webview 与 `AuthService`。
 * 登录态上下文 `devbelt.loggedIn` 由 `extension.ts` 的 AuthEvent 订阅统一刷新。
 */

/** 登录密码最小长度（与 server `PASSWORD_MIN` 一致）。 */
const PASSWORD_MIN = 9;

/** 打开当前用户的管理后台（浏览器）；控制台登录态在浏览器侧，未登录需自行登录。 */
export function openConsole(): void {
  void vscode.env.openExternal(vscode.Uri.parse(`${DEFAULT_SERVER_URL}/db/account`));
}

/**
 * 修改登录密码：旧密码 + 新密码（双输入）。成功后服务端撤销全部会话
 * （`PASSWORD_CHANGED_RELOGIN_REQUIRED`），本地随之登出，提示重新登录。
 */
export async function changeLoginPassword(deps: Deps): Promise<void> {
  if (!deps.auth.isLoggedIn()) {
    void vscode.window.showWarningMessage(l10n('account.loginRequired'));
    return;
  }
  const oldPassword = await vscode.window.showInputBox({
    prompt: l10n('account.pwd.old'), password: true, ignoreFocusOut: true,
  });
  if (!oldPassword) return;
  const newPassword = await vscode.window.showInputBox({
    prompt: l10n('account.pwd.new'), password: true, ignoreFocusOut: true,
  });
  if (!newPassword) return;
  if ([...newPassword].length < PASSWORD_MIN) {
    void vscode.window.showErrorMessage(l10n('account.pwd.tooShort'));
    return;
  }
  const confirmation = await vscode.window.showInputBox({
    prompt: l10n('account.pwd.confirm'), password: true, ignoreFocusOut: true,
  });
  if (confirmation === undefined) return;
  if (newPassword !== confirmation) {
    void vscode.window.showErrorMessage(l10n('account.pwd.mismatch'));
    return;
  }
  try {
    await deps.auth.changePassword(oldPassword, newPassword);
  } catch {
    void vscode.window.showErrorMessage(l10n('account.pwd.failed'));
    return;
  }
  // 改密后服务端已使所有会话失效：本地登出，进入重新登录流程。
  await deps.auth.logout();
  void vscode.window.showInformationMessage(l10n('account.pwd.changed'));
}

export function registerAccountCommands(deps: Deps, sub: Sub): void {
  sub('devbelt.login', () => {
    LoginFormView.open(deps.auth);
  });

  sub('devbelt.account', () => {
    AccountHubView.open(deps.auth, deps.syncFactory, 'account');
  });

  sub('devbelt.sessions', () => {
    AccountHubView.open(deps.auth, deps.syncFactory, 'session');
  });

  sub('devbelt.plans', () => {
    AccountHubView.open(deps.auth, deps.syncFactory, 'plans');
  });

  sub('devbelt.openConsole', () => {
    openConsole();
  });

  sub('devbelt.changeLoginPassword', () => {
    void changeLoginPassword(deps);
  });

  sub('devbelt.logout', async () => {
    await deps.auth.logout();
  });
}