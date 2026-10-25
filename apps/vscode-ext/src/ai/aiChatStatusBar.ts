import * as vscode from 'vscode';
import { l10n } from '../i18n';

/**
 * 常驻 AI 对话入口（状态栏）：侧栏收起时也能一步打开。
 *
 * 与 NL2SQL 单发结果条（`AiStatusBar`，`$(sparkle)`）分开展示：那个是"本次生成的
 * 结果"，这个是"打开对话"，两者语义不同，共用一个项会互相覆盖。
 */
export class AiChatStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 89);
    this.item.command = 'devbelt.ai.chat';
    this.item.text = '$(comment-discussion) AI';
    this.item.tooltip = l10n('ai.statusBar.chatTooltip');
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
