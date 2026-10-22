import * as vscode from 'vscode';
import { getNonce } from '../webview/html';
import { l10n } from '../i18n';

/**
 * 侧边栏「反馈」视图（`devbelt.feedback`）：竖向反馈入口列表。
 *
 * 点击后在外部浏览器打开对应页面。链接采用 key 白名单映射，webview 无法注入任意外链。
 */

const FEEDBACK_ITEMS: ReadonlyArray<{ id: string; labelKey: string; url: string }> = [
  {
    id: 'bug',
    labelKey: 'feedback.bug',
    url: 'https://github.com/lang2hong/vscode-db-client/issues/new?labels=bug&title=%5BBug%5D%20',
  },
  {
    id: 'feature',
    labelKey: 'feedback.feature',
    url: 'https://github.com/lang2hong/vscode-db-client/issues/new?labels=enhancement&title=%5BFeature%5D%20',
  },
  {
    id: 'docs',
    labelKey: 'feedback.docs',
    url: 'https://github.com/lang2hong/vscode-db-client/tree/main/docs',
  },
  {
    id: 'review',
    labelKey: 'feedback.review',
    url: 'https://marketplace.visualstudio.com/items?itemName=lang2hong.devbelt-db-client&ssr=false#review-details',
  },
];

const FEEDBACK_URLS = new Map(FEEDBACK_ITEMS.map((i) => [i.id, i.url]));

export class FeedbackViewProvider implements vscode.WebviewViewProvider {
  static register(): vscode.Disposable {
    return vscode.window.registerWebviewViewProvider('devbelt.feedback', new FeedbackViewProvider());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml();
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = raw as { type?: string; id?: string };
      if (msg?.type === 'openFeedback' && typeof msg.id === 'string') {
        const url = FEEDBACK_URLS.get(msg.id);
        if (url) {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        }
      }
    });
  }

  private renderHtml(): string {
    const nonce = getNonce();
    const items = FEEDBACK_ITEMS
      .map((t) => `<li><button class="feedback-item" data-id="${t.id}">${l10n(t.labelKey)}</button></li>`)
      .join('');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); }
  ul.feedback { list-style: none; margin: 0; padding: 4px 0; }
  button.feedback-item { display: block; width: 100%; text-align: left; background: transparent; color: var(--vscode-foreground); border: none; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  button.feedback-item:hover { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<ul class="feedback">${items}</ul>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  for (const b of document.querySelectorAll('button.feedback-item')) {
    b.addEventListener('click', () => vscode.postMessage({ type: 'openFeedback', id: b.dataset.id }));
  }
</script>
</body>
</html>`;
  }
}
