import type { Deps, Sub } from './shared';
import { LoginFormView } from '../sync/loginFormView';
import { AccountView } from '../sync/accountView';
import { SessionView } from '../sync/sessionView';

/**
 * 账户与登录入口（应用账号层面，区别于 `user.ts` 的数据库实例用户管理）。
 *
 * 这四条命令曾随 V2 同步删除而悬空（有声明无 handler）：登录/注册、账户面板、
 * 会话/设备管理、登出。这里重新接到现有 webview 与 `AuthService`。
 * 登录态上下文 `dbclient.loggedIn` 由 `extension.ts` 的 AuthEvent 订阅统一刷新。
 */
export function registerAccountCommands(deps: Deps, sub: Sub): void {
  sub('dbclient.login', () => {
    LoginFormView.open(deps.auth);
  });

  sub('dbclient.account', () => {
    AccountView.open(deps.auth);
  });

  sub('dbclient.sessions', () => {
    SessionView.open(deps.auth);
  });

  sub('dbclient.logout', async () => {
    await deps.auth.logout();
  });
}