import * as vscode from 'vscode';
import { getNonce } from '../webview/html';
import { l10n } from '../i18n';
import type { FeedbackController } from './feedbackController';

/**
 * 反馈独立面板（编辑器区域的 WebviewPanel，单例）。
 *
 * 内容：反馈表单、「我的反馈与回复」、其他渠道链接（Bug / 建议 / 文档 / 评价）。
 * 侧边栏 `devbelt.feedback` 只保留入口与未读提醒，空间不够的内容都在这里。
 *
 * - `retainContextWhenHidden`：切换标签页不丢未提交的草稿。
 * - 回复来自服务端，一律经 `textContent` 渲染，不拼接 HTML。
 * - 只有面板**可见**时才把回复标为已读。
 */

export const FEEDBACK_ITEMS: ReadonlyArray<{ id: string; labelKey: string; url: string }> = [
  {
    id: 'bug',
    labelKey: 'feedback.bug',
    url: 'https://github.com/lang2hong/devbelt/issues/new?labels=bug&title=%5BBug%5D%20',
  },
  {
    id: 'feature',
    labelKey: 'feedback.feature',
    url: 'https://github.com/lang2hong/devbelt/issues/new?labels=enhancement&title=%5BFeature%5D%20',
  },
  {
    id: 'docs',
    labelKey: 'feedback.docs',
    url: 'https://github.com/lang2hong/devbelt/tree/main/docs',
  },
  {
    id: 'review',
    labelKey: 'feedback.review',
    url: 'https://marketplace.visualstudio.com/items?itemName=lang2hong.devbelt-db-client&ssr=false#review-details',
  },
];

const FEEDBACK_URLS = new Map(FEEDBACK_ITEMS.map((i) => [i.id, i.url]));
const VIEW_TYPE = 'devbelt.feedbackPanel';

export class FeedbackPanel {
  private static current?: FeedbackPanel;

  /** 打开或聚焦面板（单例）。 */
  static open(controller: FeedbackController): void {
    if (FeedbackPanel.current) {
      FeedbackPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void FeedbackPanel.current.refresh();
      return;
    }
    FeedbackPanel.current = new FeedbackPanel(controller);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private unsubscribe?: () => void;

  private constructor(private readonly controller: FeedbackController) {
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      l10n('feedback.panel.title'),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.renderHtml();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((raw: unknown) => void this.onMessage(raw)),
      this.panel.onDidChangeViewState(() => {
        if (this.panel.visible) void this.refresh();
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );
    this.unsubscribe = controller.onDidChange(() => this.push());
  }

  private dispose(): void {
    this.unsubscribe?.();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    if (FeedbackPanel.current === this) FeedbackPanel.current = undefined;
  }

  private async onMessage(raw: unknown): Promise<void> {
    const msg = raw as {
      type?: string; id?: string; category?: string; content?: string; contact?: string;
      images?: Array<{ fileName?: string; dataBase64?: string }>;
    };
    switch (msg?.type) {
      case 'ready':
      case 'refresh':
        await this.refresh();
        return;
      case 'openLink': {
        const url = typeof msg.id === 'string' ? FEEDBACK_URLS.get(msg.id) : undefined;
        if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      case 'markRead':
        if (this.panel.visible) await this.controller.markAllRead();
        return;
      case 'submit':
        await this.submit(msg);
        return;
    }
  }

  private async submit(msg: {
    category?: string; content?: string; contact?: string;
    images?: Array<{ fileName?: string; dataBase64?: string }>;
  }): Promise<void> {
    const content = (msg.content ?? '').trim();
    if (!content) {
      void this.panel.webview.postMessage({ type: 'submitResult', ok: false, message: l10n('feedback.form.empty') });
      return;
    }
    if (content.length > 4000) {
      void this.panel.webview.postMessage({ type: 'submitResult', ok: false, message: l10n('feedback.form.tooLong') });
      return;
    }
    // 服务端还会再校验一次；这里先挡明显超限，避免把几 MB 的 payload 发出去。
    const rawImages = Array.isArray(msg.images) ? msg.images : [];
    if (rawImages.length > 3) {
      void this.panel.webview.postMessage({ type: 'submitResult', ok: false, message: l10n('feedback.form.images.tooMany') });
      return;
    }
    const images: Array<{ fileName: string; dataBase64: string }> = [];
    let total = 0;
    for (const img of rawImages) {
      const dataBase64 = typeof img?.dataBase64 === 'string' ? img.dataBase64 : '';
      // base64 长度 × 3/4 ≈ 原始字节数；用长度先挡，避免在 host 侧再解码一次大字符串。
      const approxBytes = Math.floor((dataBase64.length * 3) / 4);
      if (approxBytes > 2 * 1024 * 1024) {
        void this.panel.webview.postMessage({ type: 'submitResult', ok: false, message: l10n('feedback.form.images.tooLarge') });
        return;
      }
      total += approxBytes;
      if (total > 6 * 1024 * 1024) {
        void this.panel.webview.postMessage({ type: 'submitResult', ok: false, message: l10n('feedback.form.images.totalTooLarge') });
        return;
      }
      images.push({ fileName: typeof img?.fileName === 'string' ? img.fileName : '', dataBase64 });
    }

    const outcome = await this.controller.submit({
      category: msg.category ?? 'other',
      content,
      contact: msg.contact ?? '',
      ...(images.length > 0 ? { images } : {}),
    });
    const message =
      outcome === 'ok' ? l10n('feedback.form.ok')
      : outcome === 'rateLimited' ? l10n('feedback.form.rateLimited')
      : outcome === 'tooLarge' ? l10n('feedback.form.images.totalTooLarge')
      : l10n('feedback.form.failed');
    void this.panel.webview.postMessage({ type: 'submitResult', ok: outcome === 'ok', message });
    if (outcome === 'ok') void this.refresh();
  }

  private async refresh(): Promise<void> {
    void this.panel.webview.postMessage({ type: 'threadLoading' });
    const ok = await this.controller.refresh();
    if (!ok) void this.panel.webview.postMessage({ type: 'threadError', message: l10n('feedback.thread.failed') });
  }

  private push(): void {
    const snap = this.controller.snapshot();
    void this.panel.webview.postMessage({ type: 'thread', items: snap.items, lastSeen: snap.lastSeen });
  }

  private renderHtml(): string {
    const nonce = getNonce();
    const i18n = {
      empty: l10n('feedback.form.empty'),
      sending: l10n('feedback.form.sending'),
      threadEmpty: l10n('feedback.thread.empty'),
      imgTooMany: l10n('feedback.form.images.tooMany'),
      imgTooLarge: l10n('feedback.form.images.tooLarge'),
      imgType: l10n('feedback.form.images.type'),
      imgTotal: l10n('feedback.form.images.totalTooLarge'),
      imgRemove: l10n('feedback.form.images.remove'),
      imgAdd: l10n('feedback.form.images.add'),
      threadLoading: l10n('feedback.thread.loading'),
      noReply: l10n('feedback.thread.noReply'),
      reply: l10n('feedback.thread.reply'),
      newBadge: l10n('feedback.thread.new'),
      status: {
        new: l10n('feedback.thread.status.new'),
        triaged: l10n('feedback.thread.status.triaged'),
        done: l10n('feedback.thread.status.done'),
        rejected: l10n('feedback.thread.status.rejected'),
      },
    };
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body { margin: 0; padding: 20px 24px 32px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); line-height: 1.5; }
  .layout { display: flex; flex-direction: column; gap: 32px; max-width: 780px; margin: 0 auto; }
  section + section { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); padding-top: 24px; }
  h2 { margin: 0 0 12px; font-size: 15px; font-weight: 600; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  label { display: block; margin: 12px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  select, textarea, input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 6px 8px; font-family: inherit; font-size: 13px; }
  textarea { resize: vertical; min-height: 140px; }
  button.submit { margin-top: 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 7px 18px; cursor: pointer; font-size: 13px; }
  button.submit:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.submit:disabled { opacity: .6; cursor: default; }
  button.link { background: transparent; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; padding: 0; }
  button.link:disabled { opacity: .6; cursor: default; }
  .hint { margin: 8px 0 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .status { margin-top: 8px; font-size: 12px; min-height: 1em; }
  .status.ok { color: var(--vscode-testing-iconPassed, #3aa675); }
  .status.err { color: var(--vscode-errorForeground, #f14c4c); }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .thread { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; }
  .item { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 4px; padding: 10px 12px; }
  .meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .text { margin: 6px 0 0; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
  .reply { margin-top: 10px; padding: 8px 10px; border-left: 2px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08)); }
  .tag { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 3px; font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  ul.links { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 16px; }
  button.feedback-item { background: transparent; color: var(--vscode-textLink-foreground); border: none; padding: 4px 0; cursor: pointer; font-size: 13px; }
  button.feedback-item:hover { text-decoration: underline; }
  .images { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
  .thumb { position: relative; width: 96px; height: 96px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 4px; overflow: hidden; background: var(--vscode-input-background); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb button { position: absolute; top: 2px; right: 2px; width: 20px; height: 20px; line-height: 1; padding: 0; border: none; border-radius: 50%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
  .img-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  input[type=file] { display: none; }
  button.secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 3px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
</style>
</head>
<body>
<div class="layout">
  <section aria-labelledby="form-title">
    <h2 id="form-title">${l10n('feedback.form.title')}</h2>
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
    <label>${l10n('feedback.form.images.label')}</label>
    <div class="img-row">
      <button class="secondary" id="pickImages" type="button">${l10n('feedback.form.images.add')}</button>
      <span class="muted">${l10n('feedback.form.images.hint')}</span>
    </div>
    <input id="imageInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple />
    <div class="images" id="images"></div>
    <button class="submit" id="send">${l10n('feedback.form.submit')}</button>
    <p class="hint">${l10n('feedback.form.hint')}</p>
    <div class="status" id="status" role="status" aria-live="polite"></div>
  </section>
  <section aria-labelledby="thread-title">
    <div class="row">
      <h2 id="thread-title">${l10n('feedback.thread.title')}</h2>
      <button class="link" id="refresh">${l10n('feedback.thread.refresh')}</button>
    </div>
    <div id="threadStatus" class="muted" role="status" aria-live="polite"></div>
    <div id="thread" class="thread"></div>
  </section>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const I18N = ${JSON.stringify(i18n)};
  for (const b of document.querySelectorAll('button.feedback-item')) {
    b.addEventListener('click', () => vscode.postMessage({ type: 'openLink', id: b.dataset.id }));
  }
  const send = document.getElementById('send');
  const status = document.getElementById('status');
  const content = document.getElementById('content');
  const imageInput = document.getElementById('imageInput');
  const imagesBox = document.getElementById('images');
  const MAX_IMAGES = 3, MAX_IMAGE_BYTES = 2 * 1024 * 1024, MAX_TOTAL_BYTES = 6 * 1024 * 1024;
  const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  let images = [];

  function setStatus(text, ok) {
    status.className = ok === undefined ? 'status' : (ok ? 'status ok' : 'status err');
    status.textContent = text;
  }
  function renderImages() {
    imagesBox.replaceChildren();
    images.forEach((img, i) => {
      const box = document.createElement('div');
      box.className = 'thumb';
      const el = document.createElement('img');
      el.src = img.dataUrl;
      el.alt = img.fileName;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.title = I18N.imgRemove;
      rm.addEventListener('click', () => { images.splice(i, 1); renderImages(); });
      box.append(el, rm);
      imagesBox.append(box);
    });
  }
  function readFile(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => {
        const dataUrl = String(r.result || '');
        resolve({ fileName: file.name, dataUrl, dataBase64: dataUrl.split(',')[1] || '' });
      };
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });
  }
  document.getElementById('pickImages').addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', async () => {
    for (const file of Array.from(imageInput.files || [])) {
      if (images.length >= MAX_IMAGES) { setStatus(I18N.imgTooMany, false); break; }
      if (!ALLOWED.includes(file.type)) { setStatus(I18N.imgType, false); continue; }
      if (file.size > MAX_IMAGE_BYTES) { setStatus(I18N.imgTooLarge, false); continue; }
      const total = images.reduce((n, x) => n + x.size, 0) + file.size;
      if (total > MAX_TOTAL_BYTES) { setStatus(I18N.imgTotal, false); break; }
      const img = await readFile(file);
      if (img) { img.size = file.size; images.push(img); }
    }
    imageInput.value = '';
    renderImages();
  });
  const refresh = document.getElementById('refresh');
  const thread = document.getElementById('thread');
  const threadStatus = document.getElementById('threadStatus');

  send.addEventListener('click', () => {
    const text = content.value.trim();
    if (!text) { status.className = 'status err'; status.textContent = I18N.empty; return; }
    send.disabled = true;
    status.className = 'status';
    status.textContent = I18N.sending;
    vscode.postMessage({
      type: 'submit',
      category: document.getElementById('category').value,
      content: text,
      contact: document.getElementById('contact').value,
      images: images.map((x) => ({ fileName: x.fileName, dataBase64: x.dataBase64 })),
    });
  });
  refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  function fmt(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }
  function isUnread(id, lastSeen) {
    try { return BigInt(id) > BigInt(lastSeen); } catch { return false; }
  }
  // 服务端文本一律经 textContent 渲染，不拼 innerHTML。
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function renderThread(items, lastSeen) {
    thread.replaceChildren();
    if (!items.length) { threadStatus.textContent = I18N.threadEmpty; return; }
    threadStatus.textContent = '';
    let hasUnread = false;
    for (const it of items) {
      const box = el('div', 'item');
      const meta = el('div', 'meta');
      meta.append(el('span', '', I18N.status[it.status] || it.status), el('span', '', fmt(it.createTime)));
      box.append(meta, el('p', 'text', it.content));
      if (!it.replies.length) box.append(el('p', 'muted', I18N.noReply));
      for (const r of it.replies) {
        const unread = isUnread(r.id, lastSeen);
        hasUnread = hasUnread || unread;
        const rb = el('div', 'reply');
        const rm = el('div', 'meta');
        const who = el('span', '', I18N.reply);
        if (unread) who.append(el('span', 'tag', I18N.newBadge));
        rm.append(who, el('span', '', fmt(r.createTime)));
        rb.append(rm, el('p', 'text', r.body));
        box.append(rb);
      }
      thread.append(box);
    }
    if (hasUnread) vscode.postMessage({ type: 'markRead' });
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type === 'submitResult') {
      send.disabled = false;
      status.className = m.ok ? 'status ok' : 'status err';
      status.textContent = m.message;
      if (m.ok) { content.value = ''; document.getElementById('contact').value = ''; images = []; renderImages(); }
      return;
    }
    if (m?.type === 'threadLoading') { refresh.disabled = true; threadStatus.textContent = I18N.threadLoading; return; }
    if (m?.type === 'threadError') { refresh.disabled = false; threadStatus.textContent = m.message; return; }
    if (m?.type === 'thread') { refresh.disabled = false; renderThread(m.items || [], m.lastSeen || '0'); }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
