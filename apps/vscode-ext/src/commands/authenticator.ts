import type { Deps, Sub } from './shared';
import { AuthenticatorView } from '../authenticator/authenticatorView';
import { promptAuthenticatorUpgrade } from '../authenticator/quotaPrompt';
import { exportAuthenticatorEntries } from '../authenticator/exportAll';

/**
 * P5 · 2FA/TOTP 验证器命令（WebviewPanel 形态，不在活动栏加图标）。
 *
 * - `devbelt.authenticator`：打开/聚焦验证器面板。
 * - `devbelt.authenticator.add`：先配额预检，达上限直接弹升级、不展开表单；否则打开面板并请求表单。
 * - `devbelt.authenticator.export`：主进程独占文件 IO（不依赖面板是否就绪）。
 *
 * 业务错误都由 store 结果对象承载、不抛，避免被 makeSub 兜成通用"命令失败"对话框。
 */
export function registerAuthenticatorCommands(deps: Deps, sub: Sub): void {
  sub('devbelt.authenticator', () => {
    AuthenticatorView.open(deps.authStore);
  });

  sub('devbelt.authenticator.add', async () => {
    const quota = deps.authStore.checkQuota();
    if (!quota.ok) {
      await promptAuthenticatorUpgrade(quota.limit);
      return;
    }
    AuthenticatorView.openAddForm(deps.authStore);
  });

  sub('devbelt.authenticator.export', async () => {
    await exportAuthenticatorEntries(deps.authStore);
  });
}
