import * as vscode from 'vscode';
import { getWebviewHtml } from '../webview/html';
import { diagError } from '../utils/diagnostics';
import { isZh, l10n } from '../i18n';
import type { AuthenticatorStore } from './store';
import { promptAuthenticatorUpgrade } from './quotaPrompt';
import { exportAuthenticatorEntries } from './exportAll';
import { decodeOtpauthFromPngDataUrl } from './qrDecode';
import { parseOtpauthUri } from './otpauth';
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
        if (!view.visible) { this.clearTimer(); return; }
        if (!this.initSent) return; // 未完成握手前不启动 timer（2nd ready 时会启动）
        this.tick();
        this.startTimer();
      }),
      view.onDidDispose(() => this.unbind()),
    ];
  }

  /** 外部命令/「＋」入口：先在主进程做配额预检，达上限直接弹升级、不展开表单。 */
  openAddForm(): void {
    const q = this.store.checkQuota();
    if (!q.ok) {
      void promptAuthenticatorUpgrade(q.limit);
      return;
    }
    if (this.view && this.initSent) this.post({ type: 'openAddForm' });
    else this.pendingAction = 'openAddForm';
  }

  /** EventBus 订阅入口：条目/分组/标签变更后重发快照（并立即补一次 tick，口令即时出现）。 */
  async refresh(): Promise<void> {
    if (!this.view || !this.initSent) return;
    this.sendSnapshot();
    this.tick();
  }

  private async handleMessage(raw: any): Promise<void> {
    const msg = raw as AuthenticatorUpMessage;
    switch (msg?.type) {
      case 'ready': this.onReady(); return;
      case 'copy': await this.onCopy(msg); return;
      case 'toggleGroup': this.onToggleGroup(msg); return;
      case 'requestAddForm': this.openAddForm(); return;
      case 'addUri': await this.onAddUri(msg); return;
      case 'addImage': await this.onAddImage(msg); return;
      case 'add': await this.onAdd(msg); return;
      case 'update': await this.onUpdate(msg); return;
      case 'delete': await this.onDelete(msg); return;
      case 'addGroup': await this.onAddGroup(msg); return;
      case 'updateGroup': await this.onUpdateGroup(msg); return;
      case 'deleteGroup': await this.onDeleteGroup(msg); return;
      case 'moveEntry': await this.onMoveEntry(msg); return;
      case 'reorderGroup': await this.onReorderGroup(msg); return;
      case 'addTag': await this.onAddTag(msg); return;
      case 'removeTag': await this.onRemoveTag(msg); return;
      case 'export': await exportAuthenticatorEntries(this.store); return;
      default: return;
    }
  }

  /** IPC 边界的 null/'' → 持久化模型语义的 undefined（未分组）。 */
  private normGroupId(v: string | null | undefined): string | undefined {
    return v == null || v === '' ? undefined : v;
  }

  private postFormError(field: string | undefined, key: string, source: 'form' | 'external' = 'form'): void {
    this.post({ type: 'formError', field, message: l10n(key), source });
  }

  private async onAdd(msg: Extract<AuthenticatorUpMessage, { type: 'add' }>): Promise<void> {
    const e = msg.entry;
    const res = await this.store.addEntry({
      issuer: e.issuer,
      account: e.account,
      secret: e.secret,
      algorithm: e.algorithm,
      digits: e.digits,
      period: e.period,
      groupId: this.normGroupId(e.groupId),
      tags: e.tags,
    });
    if (res.ok) return; // 成功后 EventBus → refresh 下发快照
    if (res.reason === 'quota') { await promptAuthenticatorUpgrade(res.limit); return; }
    if (res.reason === 'invalidSecret') { this.postFormError(res.field ?? 'secret', 'authenticator.err.invalidSecret'); return; }
    if (res.reason === 'invalidField') { this.postFormError(res.field, 'authenticator.err.invalidField'); return; }
    this.post({ type: 'error', message: l10n('authenticator.error.generic') });
  }

  private async onUpdate(msg: Extract<AuthenticatorUpMessage, { type: 'update' }>): Promise<void> {
    const p = msg.patch;
    const res = await this.store.updateEntry(msg.id, {
      issuer: p.issuer,
      account: p.account,
      secret: p.secret,
      algorithm: p.algorithm,
      digits: p.digits,
      period: p.period,
      // 直接把原始值交给 store：store 以 `!== undefined` 判定"是否变更分组"，
      // undefined=不修改、null/''=移到未分组。若在此预先归一成 undefined 会丢掉"移到未分组"语义。
      groupId: p.groupId,
      tags: p.tags,
    });
    if (res.ok) return;
    if (res.reason === 'invalidSecret') { this.postFormError('secret', 'authenticator.err.invalidSecret'); return; }
    if (res.reason === 'invalidField') { this.postFormError(undefined, 'authenticator.err.invalidField'); return; }
    this.post({ type: 'error', message: l10n('authenticator.error.generic') });
  }

  private async onAddImage(msg: Extract<AuthenticatorUpMessage, { type: 'addImage' }>): Promise<void> {
    // 先做配额预检：达上限直接弹升级，不浪费解码。
    const quota = this.store.checkQuota();
    if (!quota.ok) { await promptAuthenticatorUpgrade(quota.limit); return; }
    let uri: string | null;
    try {
      uri = decodeOtpauthFromPngDataUrl(msg.dataUrl);
    } catch (e) {
      diagError('authenticator image decode failed', String(e));
      this.postFormError(undefined, 'authenticator.image.invalid', 'external');
      return;
    }
    if (!uri) { this.postFormError(undefined, 'authenticator.image.notFound', 'external'); return; }
    await this.addFromUri(uri, 'authenticator.image.invalid');
  }

  /** 粘贴/图片两条入口共用的"解析 URI 并新增"逻辑。invalidKey 为解析失败时的文案键。 */
  private async addFromUri(uri: string, invalidKey: string): Promise<void> {
    if (uri.startsWith('otpauth-migration://')) {
      this.postFormError(undefined, 'authenticator.uri.migrationUnsupported', 'external');
      return;
    }
    let parsed: ReturnType<typeof parseOtpauthUri>;
    try {
      parsed = parseOtpauthUri(uri);
    } catch (e) {
      diagError('authenticator uri parse failed', String(e));
      this.postFormError(undefined, invalidKey, 'external');
      return;
    }
    const res = await this.store.addEntry({
      issuer: parsed.issuer,
      account: parsed.account,
      secret: parsed.secret,
      algorithm: parsed.algorithm,
      digits: parsed.digits,
      period: parsed.period,
    });
    if (res.ok) return; // EventBus → refresh
    if (res.reason === 'quota') { await promptAuthenticatorUpgrade(res.limit); return; }
    if (res.reason === 'invalidSecret') {
      this.postFormError('secret', 'authenticator.err.invalidSecret', 'external');
      return;
    }
    if (res.reason === 'invalidField') {
      this.postFormError(res.field, 'authenticator.err.invalidField', 'external');
      return;
    }
    this.post({ type: 'error', message: l10n('authenticator.error.generic') });
  }

  private async onAddUri(msg: Extract<AuthenticatorUpMessage, { type: 'addUri' }>): Promise<void> {
    if (typeof msg.uri !== 'string' || !msg.uri) { this.postFormError(undefined, 'authenticator.uri.invalid', 'external'); return; }
    await this.addFromUri(msg.uri, 'authenticator.uri.invalid');
  }

  private async onDelete(msg: Extract<AuthenticatorUpMessage, { type: 'delete' }>): Promise<void> {
    const res = await this.store.deleteEntry(msg.id);
    if (!res.ok) this.post({ type: 'error', message: l10n('authenticator.error.generic') });
  }

  private async onAddGroup(msg: Extract<AuthenticatorUpMessage, { type: 'addGroup' }>): Promise<void> {
    const res = msg.beforeId !== undefined
      ? await this.store.addGroupBefore(msg.name, msg.beforeId)
      : await this.store.addGroup(msg.name, msg.afterId);
    if (!res.ok) this.postFormError('name', 'authenticator.err.invalidName');
  }

  private async onUpdateGroup(msg: Extract<AuthenticatorUpMessage, { type: 'updateGroup' }>): Promise<void> {
    const res = await this.store.renameGroup(msg.id, msg.name);
    if (!res.ok) this.postFormError('name', res.reason === 'invalidName' ? 'authenticator.err.invalidName' : 'authenticator.err.notFound');
  }

  private async onDeleteGroup(msg: Extract<AuthenticatorUpMessage, { type: 'deleteGroup' }>): Promise<void> {
    await this.store.deleteGroup(msg.id);
  }

  private async onMoveEntry(msg: Extract<AuthenticatorUpMessage, { type: 'moveEntry' }>): Promise<void> {
    // targetGroupId: null 表示移到未分组——原样交给 store（见 onUpdate 注释）
    const res = await this.store.updateEntry(msg.id, { groupId: msg.targetGroupId });
    if (!res.ok) this.post({ type: 'error', message: l10n('authenticator.error.generic') });
  }

  private async onReorderGroup(msg: Extract<AuthenticatorUpMessage, { type: 'reorderGroup' }>): Promise<void> {
    await this.store.reorderGroup(msg.orderedGroupIds);
  }

  private async onAddTag(msg: Extract<AuthenticatorUpMessage, { type: 'addTag' }>): Promise<void> {
    const res = await this.store.addTag(msg.name, msg.color);
    if (!res.ok) this.postFormError('name', res.reason === 'invalidName' ? 'authenticator.err.invalidName' : 'authenticator.err.invalidColor');
  }

  private async onRemoveTag(msg: Extract<AuthenticatorUpMessage, { type: 'removeTag' }>): Promise<void> {
    await this.store.deleteTag(msg.id);
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
    try {
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
    } catch (e) {
      // store 未就绪（init 失败）等异常不得冒泡到 VS Code 事件回调里；记录并跳过本次快照。
      diagError('authenticator snapshot', String(e));
    }
  }

  /** 每秒 tick：只算未折叠组的 codes，合并为一条消息下发。 */
  private tick(): void {
    if (!this.view || !this.initSent) return;
    try {
      const nowMs = Date.now();
      const ids = this.store.listEntries()
        .filter((e) => !this.foldedGroups.has(e.groupId ?? null))
        .map((e) => e.id);
      const codes = this.store.getCodes(ids, nowMs);
      this.post({ type: 'tick', nowMs, codes });
    } catch (e) {
      diagError('authenticator tick', String(e));
    }
  }

  private async onCopy(msg: Extract<AuthenticatorUpMessage, { type: 'copy' }>): Promise<void> {
    const code = typeof msg.code === 'string' ? msg.code : '';
    const entryId = typeof msg.entryId === 'string' ? msg.entryId : '';
    if (!/^(?:\d{6}|\d{8})$/.test(code)) {
      this.post({ type: 'formError', message: l10n('authenticator.copy.invalid'), source: 'external' });
      return;
    }
    await vscode.env.clipboard.writeText(code);
    this.post({ type: 'copyOk', entryId });
  }

  private onToggleGroup(msg: Extract<AuthenticatorUpMessage, { type: 'toggleGroup' }>): void {
    if (typeof msg.folded !== 'boolean') return; // 非法 IPC 值不误判
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
    // webview 重载后折叠 UI 复位，主进程折叠态也要复位，避免新卡片因"仍被当作折叠"而不下发 codes。
    this.foldedGroups.clear();
  }

  dispose(): void {
    this.unbind();
  }
}
