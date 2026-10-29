import * as vscode from 'vscode';
import { getNonce } from '../webview/html';
import { l10n } from '../i18n';
import type { FeedbackController } from './feedbackController';
import { FEEDBACK_ITEMS } from './feedbackPanel';

/** 侧边栏入口命令：在编辑器区域打开反馈面板。 */
export const OPEN_FEEDBACK_COMMAND = 'devbelt.feedback.open';

const FEEDBACK_URLS = new Map(FEEDBACK_ITEMS.map((i) => [i.id, i.url]));

/**
 * 侧边栏「反馈」视图（`devbelt.feedback`）。
 *
 * 入口**并列**展示：写反馈 / 查看回复（打开面板），以及 Bug 报告、功能建议、
 * 文档、评分四个外链。此前这些外链藏在面板底部，用户找不到；侧边栏空间足够
 * 放下并列入口。未读徽标仍挂在视图上。
 *
 * 视图可见时拉取一次线程（非实时）。
 */
export class FeedbackViewProvider implements vscode.WebviewViewProvider {
  static register(controller: FeedbackController): vscode.Disposable {
    return vscode.window.registerWebviewViewProvider('devbelt.feedback', new FeedbackViewProvider(controller));
  }

  private view?: vscode.WebviewView;
  private unsubscribe?: () => void;

  constructor(private readonly controller: FeedbackController) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml();
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = raw as { type?: string; id?: string };
      if (msg?.type === 'open') void vscode.commands.executeCommand(OPEN_FEEDBACK_COMMAND);
      else if (msg?.type === 'openLink') {
        const url = typeof msg.id === 'string' ? FEEDBACK_URLS.get(msg.id) : undefined;
        if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
      } else if (msg?.type === 'ready') void this.refresh();
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    });
    this.unsubscribe?.();
    this.unsubscribe = this.controller.onDidChange(() => this.apply());
    view.onDidDispose(() => {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      if (this.view === view) this.view = undefined;
    });
    this.apply();
  }

  private async refresh(): Promise<void> {
    await this.controller.refresh();
    this.apply();
  }

  /** 徽标与提醒行都从 controller 快照推导。 */
  private apply(): void {
    const view = this.view;
    if (!view) return;
    const { unread } = this.controller.snapshot();
    view.badge = unread > 0 ? { value: unread, tooltip: l10n('feedback.thread.unread', { n: unread }) } : undefined;
    void view.webview.postMessage({
      type: 'state',
      unread,
      text: unread > 0 ? l10n('feedback.thread.unread', { n: unread }) : l10n('feedback.entry.none'),
    });
  }

  private renderHtml(): string {
    const nonce = getNonce();
    const links = FEEDBACK_ITEMS
      .map((i) => `<li><button class="link" data-id="${i.id}">${l10n(i.labelKey)}</button></li>`)
      .join('');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { padding: 10px 12px; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  button.open { width: 100%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 7px 10px; cursor: pointer; font-size: 12px; }
  button.open:hover { background: var(--vscode-button-hoverBackground); }
  .note { margin: 8px 0 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .note.unread { color: var(--vscode-foreground); font-weight: 600; }
  ul.links { list-style: none; margin: 10px 0 0; padding: 8px 0 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); }
  button.link { display: block; width: 100%; text-align: left; background: transparent; color: var(--vscode-textLink-foreground); border: none; padding: 5px 0; cursor: pointer; font-size: 12px; }
  button.link:hover { text-decoration: underline; }
</style>
</head>
<body>
<button class="open" id="open">${l10n('feedback.entry.open')}</button>
<p class="note" id="note" role="status" aria-live="polite"></p>
<ul class="links">${links}</ul>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const note = document.getElementById('note');
  document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
  for (const b of document.querySelectorAll('button.link')) {
    b.addEventListener('click', () => vscode.postMessage({ type: 'openLink', id: b.dataset.id }));
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type !== 'state') return;
    note.textContent = m.text;
    note.className = m.unread > 0 ? 'note unread' : 'note';
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
