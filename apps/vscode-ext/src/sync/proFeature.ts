import * as vscode from 'vscode';
import { l10n } from '../i18n';

/**
 * Pro 能力门禁提示：单按钮「查看套餐」，点选打开套餐面板（`devbelt.plans`）。
 * 与验证器配额提示（quotaPrompt）保持同一种交互，避免每种限制各有一套弹窗。
 */
export async function promptProFeature(message: string): Promise<void> {
  const view = l10n('plan.action.viewPlans');
  const choice = await vscode.window.showWarningMessage(message, view);
  if (choice === view) await vscode.commands.executeCommand('devbelt.plans');
}
