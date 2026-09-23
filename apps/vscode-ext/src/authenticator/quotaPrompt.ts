import * as vscode from 'vscode';
import { l10n } from '../i18n';

/**
 * 验证器配额超限提示：单按钮「升级 Pro」，点选打开套餐面板（`devbelt.plans`）。
 * 命令 handler 与 provider 的配额预检共用，确保「达上限不展开表单」的 UX 一致。
 */
export async function promptAuthenticatorUpgrade(limit: number): Promise<void> {
  const upgrade = l10n('authenticator.quota.upgrade');
  const choice = await vscode.window.showWarningMessage(
    l10n('authenticator.quota.reached', { limit }),
    upgrade,
  );
  if (choice === upgrade) await vscode.commands.executeCommand('devbelt.plans');
}
