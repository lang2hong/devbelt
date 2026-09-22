import * as vscode from 'vscode';
import type { Deps, Sub } from './shared';

/**
 * P5 · 2FA/TOTP 验证器命令（S2 只注册聚焦命令）。
 *
 * S2 范围：仅 `devbelt.authenticator`——聚焦侧边栏并刷新，让用户看到已有条目与实时口令。
 * `devbelt.authenticator.add` / `devbelt.authenticator.export` 与视图标题栏按钮属 S3。
 *
 * 注：本命令不设置 provider.pendingAction（无添加表单可开）；S3 的 add 命令会先做超限预检
 * 再 `provider.openAddForm()`。所有业务错误走结果对象、不抛，避免被 makeSub 兜成通用错误框。
 */
export function registerAuthenticatorCommands(deps: Deps, sub: Sub): void {
  sub('devbelt.authenticator', async () => {
    await vscode.commands.executeCommand('devbelt.tools.authenticator.focus');
    await deps.authViewProvider.refresh();
  });
}
