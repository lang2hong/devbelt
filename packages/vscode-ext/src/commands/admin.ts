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

/**
 * 打开管理后台。
 *
 * **刻意不携带 token。** 原实现是 `${serverUrl}/admin#token=<access token>`，
 * 把一个具备管理员权限的 bearer token 放进 URL fragment，代价是：
 *  - 进浏览器历史记录，并可能被会话恢复反复重放
 *  - 进剪贴板（用户复制地址栏）与任何"分享此页"路径
 *  - serverUrl 默认是明文 http，fragment 虽不上行，但整页仍是明文传输
 *  - access token 有效期内（当前配置 7d）那条历史记录一直可用
 *
 * 管理员在 admin-ui 手动登录一次即可，代价远小于把 token 写进浏览器历史。
 * 若要恢复免登录跳转，正确做法是服务端签发一次性、短时效的换取码，
 * 而不是直接传递长效 token。
 */
export function openAdminPanel(auth: AuthService): void {
  if (!auth.isLoggedIn()) {
    void vscode.window.showWarningMessage('Not logged in');
    return;
  }
  void vscode.env.openExternal(vscode.Uri.parse(`${auth.serverUrl}/admin`));
}