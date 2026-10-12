import * as vscode from 'vscode';
import { getNonce } from '../webview/html';
import { l10n } from '../i18n';

/**
 * 侧边栏「工具」视图（`devbelt.tools`）：竖向工具列表。
 *
 * 目前两项：验证器（`devbelt.authenticator`）、AI Chat（`devbelt.ai.chat`）——点击执行其命令（打开现有面板）。
 * 工具清单以 `TOOLS` 数组维护；新增工具只加数组项 + i18n。
 */
const TOOLS: ReadonlyArray<{ command: string; labelKey: string }> = [
  { command: 'devbelt.authenticator', labelKey: 'authenticator.title' },
  { command: 'devbelt.ai.chat', labelKey: 'ai.title' },
];

export class ToolsViewProvider implements vscode.WebviewViewProvider {
  static register(): vscode.Disposable {
    return vscode.window.registerWebviewViewProvider('devbelt.tools', new ToolsViewProvider());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml();
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = raw as { type?: string; command?: string };
      if (msg?.type === 'openTool' && typeof msg.command === 'string' && TOOLS.some((t) => t.command === msg.command)) {
        void vscode.commands.executeCommand(msg.command);
      }
    });
  }

  private renderHtml(): string {
    const nonce = getNonce();
    const items = TOOLS
      .map((t) => `<li><button class="tool" data-command="${t.command}">${l10n(t.labelKey)}</button></li>`)
      .join('');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); }
  ul.tools { list-style: none; margin: 0; padding: 4px 0; }
  button.tool { display: block; width: 100%; text-align: left; background: transparent; color: var(--vscode-foreground); border: none; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  button.tool:hover { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<ul class="tools">${items}</ul>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  for (const b of document.querySelectorAll('button.tool')) {
    b.addEventListener('click', () => vscode.postMessage({ type: 'openTool', command: b.dataset.command }));
  }
</script>
</body>
</html>`;
  }
}
