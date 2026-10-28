import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { getNonce } from '../webview/html';
import { l10n } from '../i18n';

/**
 * 侧边栏「反馈」视图（`devbelt.feedback`）。
 *
 * 两部分：
 * 1) **直接反馈**：表单提交到 `POST /api/db/feedback`（无需登录，后台按 IP/安装 ID 限流）；
 *    自动附带匿名安装 ID、扩展版本与 OS，联系方式可选。
 * 2) 快捷入口：Bug / 建议 / 文档 / 评价，在白名单内打开外部链接。
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
const INSTALL_ID_KEY = 'devbelt.installId';

export class FeedbackViewProvider implements vscode.WebviewViewProvider {
  static register(
    serverUrl: string,
    globalState: vscode.Memento,
    extensionVersion: string,
  ): vscode.Disposable {
    return vscode.window.registerWebviewViewProvider(
      'devbelt.feedback',
      new FeedbackViewProvider(serverUrl, globalState, extensionVersion),
    );
  }

  constructor(
    private readonly serverUrl: string,
    private readonly globalState: vscode.Memento,
    private readonly extensionVersion: string,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml();
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = raw as { type?: string; id?: string; category?: string; content?: string; contact?: string };
      if (msg?.type === 'openFeedback' && typeof msg.id === 'string') {
        const url = FEEDBACK_URLS.get(msg.id);
        if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      if (msg?.type === 'submit') {
        void this.submit(view, msg);
      }
    });
  }

  private async submit(
    view: vscode.WebviewView,
    msg: { category?: string; content?: string; contact?: string },
  ): Promise<void> {
    const category = msg.category === 'bug' || msg.category === 'feature' || msg.category === 'other' ? msg.category : 'other';
    const content = (msg.content ?? '').trim();
    if (!content) {
      void view.webview.postMessage({ type: 'submitResult', ok: false, message: l10n('feedback.form.empty') });
      return;
    }
    if (content.length > 4000) {
      void view.webview.postMessage({ type: 'submitResult', ok: false, message: l10n('feedback.form.tooLong') });
      return;
    }
    const contact = (msg.contact ?? '').trim().slice(0, 200);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.serverUrl}/api/db/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          category,
          content,
          ...(contact ? { contact } : {}),
          installId: this.installId(),
          appVersion: this.extensionVersion,
          os: `${process.platform}/${process.arch}`,
        }),
        signal: controller.signal,
      });
      if (res.status === 201) {
        void view.webview.postMessage({ type: 'submitResult', ok: true, message: l10n('feedback.form.ok') });
        return;
      }
      if (res.status === 429) {
        void view.webview.postMessage({ type: 'submitResult', ok: false, message: l10n('feedback.form.rateLimited') });
        return;
      }
      void view.webview.postMessage({ type: 'submitResult', ok: false, message: l10n('feedback.form.failed') });
    } catch {
      void view.webview.postMessage({ type: 'submitResult', ok: false, message: l10n('feedback.form.failed') });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 随机匿名安装标识（无 PII）；缺失时生成并持久化。 */
  private installId(): string {
    const existing = this.globalState.get<string>(INSTALL_ID_KEY);
    if (existing) return existing;
    const id = randomUUID();
    void this.globalState.update(INSTALL_ID_KEY, id);
    return id;
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
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  .section { padding: 10px 12px; }
  .section + .section { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); }
  h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; }
  label { display: block; margin: 8px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  select, textarea, input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 5px 7px; font-family: inherit; font-size: 12px; }
  textarea { resize: vertical; min-height: 84px; }
  button.submit { margin-top: 10px; width: 100%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 7px 10px; cursor: pointer; font-size: 12px; }
  button.submit:disabled { opacity: .6; cursor: default; }
  .hint { margin: 6px 0 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .status { margin-top: 8px; font-size: 12px; }
  .status.ok { color: var(--vscode-testing-iconPassed, #3aa675); }
  .status.err { color: var(--vscode-errorForeground, #f14c4c); }
  ul.feedback { list-style: none; margin: 0; padding: 0; }
  button.feedback-item { display: block; width: 100%; text-align: left; background: transparent; color: var(--vscode-foreground); border: none; padding: 6px 0; cursor: pointer; font-size: 13px; }
  button.feedback-item:hover { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<div class="section">
  <h3>${l10n('feedback.form.title')}</h3>
  <label for="category">${l10n('feedback.form.category')}</label>
  <select id="category">
    <option value="bug">${l10n('feedback.form.category.bug')}</option>
    <option value="feature">${l10n('feedback.form.category.feature')}</option>
    <option value="other">${l10n('feedback.form.category.other')}</option>
  </select>
  <label for="content">${l10n('feedback.form.content')}</label>
  <textarea id="content" maxlength="4000" placeholder="${l10n('feedback.form.placeholder')}"></textarea>
  <label for="contact">${l10n('feedback.form.contact')}</label>
  <input id="contact" type="text" maxlength="200" />
  <button class="submit" id="send">${l10n('feedback.form.submit')}</button>
  <p class="hint">${l10n('feedback.form.hint')}</p>
  <div class="status" id="status"></div>
</div>
<div class="section">
  <h3>${l10n('feedback.more')}</h3>
  <ul class="feedback">${items}</ul>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  for (const b of document.querySelectorAll('button.feedback-item')) {
    b.addEventListener('click', () => vscode.postMessage({ type: 'openFeedback', id: b.dataset.id }));
  }
  const send = document.getElementById('send');
  const status = document.getElementById('status');
  const content = document.getElementById('content');
  send.addEventListener('click', () => {
    const text = content.value.trim();
    if (!text) { status.className = 'status err'; status.textContent = ${JSON.stringify(l10n('feedback.form.empty'))}; return; }
    send.disabled = true;
    status.className = 'status';
    status.textContent = ${JSON.stringify(l10n('feedback.form.sending'))};
    vscode.postMessage({
      type: 'submit',
      category: document.getElementById('category').value,
      content: text,
      contact: document.getElementById('contact').value,
    });
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type !== 'submitResult') return;
    send.disabled = false;
    status.className = m.ok ? 'status ok' : 'status err';
    status.textContent = m.message;
    if (m.ok) { content.value = ''; document.getElementById('contact').value = ''; }
  });
</script>
</body>
</html>`;
  }
}