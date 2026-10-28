import * as vscode from 'vscode';
import { getNonce } from '../webview/html';
import { l10n } from '../i18n';
import { getOrCreateInstallId } from '../telemetry/installId';
import { getOrCreateReplyKey, readReplyKey } from './replyKey';

/**
 * 侧边栏「反馈」视图（`devbelt.feedback`）。
 *
 * 三部分：
 * 1) **直接反馈**：表单提交到 `POST /api/db/feedback`（无需登录；已登录时带 Bearer 关联账号）；
 *    自动附带匿名安装 ID、回复凭证、扩展版本与 OS，联系方式可选。
 * 2) **我的反馈与回复**：`POST /api/db/feedback/thread` 拉取（非实时）：
 *    视图可见、点刷新、提交成功后各拉一次；未读回复数显示在视图徽标上。
 * 3) 快捷入口：Bug / 建议 / 文档 / 评价，在白名单内打开外部链接。
 *
 * 回复内容来自服务端，webview 内一律用 textContent 渲染，不拼接 HTML。
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
/** 已读到的最大回复 id（本地；不同步、不上报）。 */
const LAST_SEEN_REPLY_KEY = 'devbelt.feedback.lastSeenReplyId';

export interface FeedbackThreadReply { id: string; body: string; createTime: string }
export interface FeedbackThreadEntry {
  id: string;
  category: 'bug' | 'feature' | 'other';
  content: string;
  status: 'new' | 'triaged' | 'done' | 'rejected';
  createTime: string;
  replies: FeedbackThreadReply[];
}

export interface FeedbackViewDeps {
  serverUrl: string;
  globalState: vscode.Memento;
  secrets: vscode.SecretStorage;
  extensionVersion: string;
  /** 当前扩展 access token（未登录为 undefined）；仅用于可选关联账号。 */
  getAccessToken: () => string | undefined;
}

/** 回复 id 是十进制字符串（BIGINT），按数值比较。 */
function maxReplyId(items: FeedbackThreadEntry[]): bigint {
  let max = 0n;
  for (const i of items) for (const r of i.replies) {
    try { const v = BigInt(r.id); if (v > max) max = v; } catch { /* 忽略非数字 id */ }
  }
  return max;
}

export function countUnread(items: FeedbackThreadEntry[], lastSeen: bigint): number {
  let n = 0;
  for (const i of items) for (const r of i.replies) {
    try { if (BigInt(r.id) > lastSeen) n++; } catch { /* ignore */ }
  }
  return n;
}

export class FeedbackViewProvider implements vscode.WebviewViewProvider {
  static register(deps: FeedbackViewDeps): vscode.Disposable {
    return vscode.window.registerWebviewViewProvider('devbelt.feedback', new FeedbackViewProvider(deps));
  }

  private view?: vscode.WebviewView;
  private loading = false;

  constructor(private readonly deps: FeedbackViewDeps) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
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
        return;
      }
      if (msg?.type === 'ready' || msg?.type === 'refresh') {
        void this.refreshThread();
        return;
      }
      if (msg?.type === 'markRead') {
        void this.markAllRead();
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refreshThread();
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  private authHeaders(): Record<string, string> {
    const token = this.deps.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
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
    const replyKey = await getOrCreateReplyKey(this.deps.secrets);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.deps.serverUrl}/api/db/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...this.authHeaders() },
        body: JSON.stringify({
          category,
          content,
          ...(contact ? { contact } : {}),
          installId: getOrCreateInstallId(this.deps.globalState),
          ...(replyKey ? { replyKey } : {}),
          appVersion: this.deps.extensionVersion,
          os: `${process.platform}/${process.arch}`,
        }),
        signal: controller.signal,
      });
      if (res.status === 201) {
        void view.webview.postMessage({ type: 'submitResult', ok: true, message: l10n('feedback.form.ok') });
        void this.refreshThread();
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

  /** 拉取线程并刷新列表与徽标；失败只在面板提示，不弹通知。 */
  async refreshThread(): Promise<void> {
    const view = this.view;
    if (!view || this.loading) return;
    this.loading = true;
    void view.webview.postMessage({ type: 'threadLoading' });
    const replyKey = await readReplyKey(this.deps.secrets);
    const token = this.deps.getAccessToken();
    if (!replyKey && !token) {
      this.loading = false;
      this.applyThread(view, []);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.deps.serverUrl}/api/db/feedback/thread`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...this.authHeaders() },
        body: JSON.stringify({
          installId: getOrCreateInstallId(this.deps.globalState),
          ...(replyKey ? { replyKey } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        void view.webview.postMessage({ type: 'threadError', message: l10n('feedback.thread.failed') });
        return;
      }
      const data = (await res.json()) as { items?: FeedbackThreadEntry[] };
      this.applyThread(view, Array.isArray(data.items) ? data.items : []);
    } catch {
      void view.webview.postMessage({ type: 'threadError', message: l10n('feedback.thread.failed') });
    } finally {
      clearTimeout(timer);
      this.loading = false;
    }
  }

  private lastItems: FeedbackThreadEntry[] = [];

  private lastSeen(): bigint {
    try { return BigInt(this.deps.globalState.get<string>(LAST_SEEN_REPLY_KEY) ?? '0'); } catch { return 0n; }
  }

  private applyThread(view: vscode.WebviewView, items: FeedbackThreadEntry[]): void {
    this.lastItems = items;
    const unread = countUnread(items, this.lastSeen());
    view.badge = unread > 0 ? { value: unread, tooltip: l10n('feedback.thread.unread', { n: unread }) } : undefined;
    void view.webview.postMessage({ type: 'thread', items, lastSeen: this.lastSeen().toString() });
  }

  private async markAllRead(): Promise<void> {
    const max = maxReplyId(this.lastItems);
    if (max > this.lastSeen()) await this.deps.globalState.update(LAST_SEEN_REPLY_KEY, max.toString());
    if (this.view) this.view.badge = undefined;
  }

  private renderHtml(): string {
    const nonce = getNonce();
    const items = FEEDBACK_ITEMS
      .map((t) => `<li><button class="feedback-item" data-id="${t.id}">${l10n(t.labelKey)}</button></li>`)
      .join('');
    const i18n = {
      empty: l10n('feedback.form.empty'),
      sending: l10n('feedback.form.sending'),
      threadEmpty: l10n('feedback.thread.empty'),
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
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  .section { padding: 10px 12px; }
  .section + .section { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); }
  h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  label { display: block; margin: 8px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  select, textarea, input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 5px 7px; font-family: inherit; font-size: 12px; }
  textarea { resize: vertical; min-height: 84px; }
  button.submit { margin-top: 10px; width: 100%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 7px 10px; cursor: pointer; font-size: 12px; }
  button.submit:disabled { opacity: .6; cursor: default; }
  button.link { background: transparent; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; padding: 0; }
  button.link:disabled { opacity: .6; cursor: default; }
  .hint { margin: 6px 0 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .status { margin-top: 8px; font-size: 12px; }
  .status.ok { color: var(--vscode-testing-iconPassed, #3aa675); }
  .status.err { color: var(--vscode-errorForeground, #f14c4c); }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .thread { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
  .item { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 4px; padding: 8px; }
  .meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .text { margin: 4px 0 0; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .reply { margin-top: 8px; padding: 6px 8px; border-left: 2px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08)); }
  .reply.unread { border-left-color: var(--vscode-notificationsInfoIcon-foreground, var(--vscode-textLink-foreground)); }
  .tag { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 3px; font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
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
  <div class="status" id="status" role="status" aria-live="polite"></div>
</div>
<div class="section">
  <div class="row">
    <h3>${l10n('feedback.thread.title')}</h3>
    <button class="link" id="refresh">${l10n('feedback.thread.refresh')}</button>
  </div>
  <div id="threadStatus" class="muted" role="status" aria-live="polite"></div>
  <div id="thread" class="thread"></div>
</div>
<div class="section">
  <h3>${l10n('feedback.more')}</h3>
  <ul class="feedback">${items}</ul>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const I18N = ${JSON.stringify(i18n)};
  for (const b of document.querySelectorAll('button.feedback-item')) {
    b.addEventListener('click', () => vscode.postMessage({ type: 'openFeedback', id: b.dataset.id }));
  }
  const send = document.getElementById('send');
  const status = document.getElementById('status');
  const content = document.getElementById('content');
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
        const rb = el('div', unread ? 'reply unread' : 'reply');
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
      if (m.ok) { content.value = ''; document.getElementById('contact').value = ''; }
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
