import * as vscode from 'vscode';
import { AuthService } from '../sync/authService';

let adminCommand: vscode.Disposable | undefined;

/** 当前账号是否为管理员（未登录或网络失败返回 false） */
export async function isAdminUser(auth: AuthService): Promise<boolean> {
  if (!auth.isLoggedIn()) return false;
  try {
    const me = await auth.client.getMe();
    return me.user.role === 'admin';
  } catch {
    return false;
  }
}

/**
 * 动态注入管理员能力：
 * 仅当前账号是 admin 时注册 `dbclient.openAdminPanel` 命令（不写进 package.json，
 * 因此命令面板与非管理员完全不可见），并同步 `dbclient.isAdmin` 上下文。
 * 登录成功 / 登出 / 扩展激活恢复会话时调用。
 */
export async function refreshAdminCommand(auth: AuthService): Promise<void> {
  const isAdmin = await isAdminUser(auth);
  if (isAdmin && !adminCommand) {
    adminCommand = vscode.commands.registerCommand('dbclient.openAdminPanel', () => openAdminPanel(auth));
  } else if (!isAdmin && adminCommand) {
    adminCommand.dispose();
    adminCommand = undefined;
  }
  await vscode.commands.executeCommand('setContext', 'dbclient.isAdmin', isAdmin);
}

export function openAdminPanel(auth: AuthService): void {
  const token = auth.getAccessToken();
  if (!token) {
    void vscode.window.showWarningMessage('Not logged in');
    return;
  }
  const serverUrl = AuthService.getServerUrl(vscode.workspace.getConfiguration());
  void vscode.env.openExternal(vscode.Uri.parse(`${serverUrl}/admin#token=${encodeURIComponent(token)}`));
}