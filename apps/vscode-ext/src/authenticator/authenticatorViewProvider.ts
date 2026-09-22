import * as vscode from 'vscode';
import { getWebviewHtml } from '../webview/html';
import { diagError } from '../utils/diagnostics';
import { isZh, l10n } from '../i18n';
import type { AuthenticatorStore } from './store';
import type { AuthenticatorDownMessage, AuthenticatorUpMessage } from '../result/protocol';

/**
 * 侧边栏「验证器」WebviewViewProvider（仓库里第一个 WebviewViewProvider）。
 *
 * 与 WebviewPanel（BaseWebView）的关键差异：
 * - 侧边栏 view 没有 `retainContextWhenHidden`：隐藏后 webview 上下文销毁，再次显示会加载
 *   新 HTML、useVsCode 产生新 `__load`，因此 `resolveWebviewView` 可能被多次调用，
 *   每次都必须重绑 webview、重置握手状态、重发 init、重启 timer。
 * - 只有 view 可见时才跑 tick timer（省电）；隐藏清 timer、可见立刻补一次。
 * - 两阶段 ready：第一次 ready → 发 init；第二次 ready（App.vue 切到 AuthenticatorView 后）
 *   → 下发快照 + 起 timer + 消费 pendingAction。
 *
 * 依赖注入：`extensionUri` 由 extension.ts 传入（`BaseWebView._extensionUri` 是
 * protected static，外部类不可读）。secret 只在主进程 store 内，**绝不下发 webview**。
 */
export class AuthenticatorViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private initSent = false;
  private currentLoad?: string;
  private timer?: ReturnType<typeof setInterval>;
  private pendingAction?: 'openAddForm';
  /** 折叠态只在主进程内存维护（不落 memento），决定 tick 时哪些组的 codes 需要下发。 */
  private readonly foldedGroups = new Set<string | null>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: AuthenticatorStore,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    // 可能被多次调用（视图重建）：先清理上一次绑定，避免重复监听/timer 泄漏。
    this.unbind();
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getWebviewHtml(view.webview, this.extensionUri);
    this.initSent = false;
    this.currentLoad = undefined;
    this.disposables = [
      view.webview.onDidReceiveMessage((msg) => {
        // 新一轮 webview 加载（__load 变化）：重置两阶段握手，否则会把重载后的首个 ready
        // 当成第二次、给尚未挂载的视图推数据 → 消息丢失。
        if (msg && typeof msg.__load === 'string' && msg.__load !== this.currentLoad) {
          this.currentLoad = msg.__load;
          this.initSent = false;
        }
        void this.handleMessage(msg).catch((e) => {
          diagError('authenticator message handler', String(e));
          this.post({ type: 'error', message: l10n('authenticator.error.generic') });
        });
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.tick();
          this.startTimer();
        } else {
          this.clearTimer();
        }
      }),
      view.onDidDispose(() => this.unbind()),
    ];
  }

  /** 外部命令入口（S3 的「＋」/命令面板用）：ready 后直发，否则挂起到第二次 ready 补发。 */
  openAddForm(): void {
    if (this.view && this.initSent) this.post({ type: 'openAddForm' });
    else this.pendingAction = 'openAddForm';
  }

  /** EventBus 订阅入口：条目/分组/标签变更后重发快照。 */
  async refresh(): Promise<void> {
    if (!this.view || !this.initSent) return;
    this.sendSnapshot();
  }

  private async handleMessage(raw: any): Promise<void> {
    const msg = raw as AuthenticatorUpMessage;
    switch (msg?.type) {
      case 'ready': this.onReady(); return;
      case 'copy': await this.onCopy(msg); return;
      case 'toggleGroup': this.onToggleGroup(msg); return;
      // S2 只实现以上动作；add/update/delete/addGroup/.../export 属 S3，此处忽略。
      default: return;
    }
  }

  private onReady(): void {
    if (!this.initSent) {
      this.initSent = true;
      this.post({ type: 'init', mode: 'authenticator', isZh: isZh() });
      return;
    }
    // 第二次 ready：下发快照 → 起 timer → 补发挂起的动作。
    this.sendSnapshot();
    this.tick();
    if (this.view?.visible) this.startTimer();
    if (this.pendingAction === 'openAddForm') {
      this.pendingAction = undefined;
      this.post({ type: 'openAddForm' });
    }
  }

  private sendSnapshot(): void {
    const entries = this.store.listEntries().map((e) => {
      const { groupId, ...rest } = e;
      return {
        ...rest,
        groupId: groupId ?? null,
        ...(this.store.isSecretMissing(e.id) ? { error: 'secretMissing' as const } : {}),
      };
    });
    this.post({
      type: 'snapshot',
      entries,
      groups: [...this.store.listGroups()],
      tags: [...this.store.listTags()],
    });
  }

  /** 每秒 tick：只算未折叠组的 codes，合并为一条消息下发。 */
  private tick(): void {
    if (!this.view) return;
    const nowMs = Date.now();
    const ids = this.store.listEntries()
      .filter((e) => !this.foldedGroups.has(e.groupId ?? null))
      .map((e) => e.id);
    const codes = this.store.getCodes(ids, nowMs);
    this.post({ type: 'tick', nowMs, codes });
  }

  private async onCopy(msg: Extract<AuthenticatorUpMessage, { type: 'copy' }>): Promise<void> {
    const code = typeof msg.code === 'string' ? msg.code : '';
    const entryId = typeof msg.entryId === 'string' ? msg.entryId : '';
    if (!/^(?:\d{6}|\d{8})$/.test(code)) {
      this.post({ type: 'formError', message: l10n('authenticator.copy.invalid') });
      return;
    }
    await vscode.env.clipboard.writeText(code);
    this.post({ type: 'copyOk', entryId });
  }

  private onToggleGroup(msg: Extract<AuthenticatorUpMessage, { type: 'toggleGroup' }>): void {
    const key: string | null = typeof msg.groupId === 'string' ? msg.groupId : null;
    if (msg.folded) this.foldedGroups.add(key);
    else this.foldedGroups.delete(key);
    if (!msg.folded) this.tick(); // 展开瞬间补发该组 codes
  }

  private post(msg: AuthenticatorDownMessage): void {
    if (!this.view) return;
    void this.view.webview.postMessage(msg);
  }

  private startTimer(): void {
    this.clearTimer();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private unbind(): void {
    this.clearTimer();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.view = undefined;
    this.initSent = false;
    this.currentLoad = undefined;
  }

  dispose(): void {
    this.unbind();
  }
}