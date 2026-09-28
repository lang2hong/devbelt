import * as vscode from 'vscode';
import { uniqueId } from '@devbelt/db-host/utils/id';
import { BaseWebView } from '../result/baseWebView';
import { diagError } from '../utils/diagnostics';
import { l10n } from '../i18n';
import type { AuthenticatorStore } from './store';
import { promptAuthenticatorUpgrade } from './quotaPrompt';
import { exportAuthenticatorEntries } from './exportAll';
import { decodeOtpauthFromPngDataUrl } from './qrDecode';
import { parseOtpauthUri } from '@devbelt/db-host/authenticator/otpauth';
import type { AuthenticatorUpMessage } from '../result/protocol';

/**
 * 验证器视图（WebviewPanel，与 Query/Design 等一致；**不在活动栏加图标**）。
 *
 * 复用 `BaseWebView` 的面板生命周期与「两次 ready」握手：
 * - 第一次 ready（默认 QueryView 挂载）→ 下发 `init{mode:'authenticator'}`，App.vue 切到本视图；
 * - 第二次 ready（AuthenticatorView 挂载）→ 下发快照 + 起每秒 tick + 消费 pendingAction。
 * 面板 `retainContextWhenHidden:true`（BaseWebView 默认），隐藏后仍存活，tick 持续；
 * 关闭（onDispose）时清 timer 与单例。
 *
 * secret 只在主进程 store 内，**绝不下发 webview**。
 */
export class AuthenticatorView extends BaseWebView {
  private static current?: AuthenticatorView;
  private timer?: ReturnType<typeof setInterval>;
  private pendingAction?: 'openAddForm';
  /** 折叠态仅面板内存维护，决定 tick 时哪些组的 codes 需要下发。 */
  private readonly foldedGroups = new Set<string | null>();
  /** 粘贴/扫码解析出的待入库 secret：只留宿主，表单补齐分组后按 prefillId 合并。 */
  private pendingPrefill?: { id: string; secret: string };

  private constructor(private readonly store: AuthenticatorStore) {
    super('devbelt.authenticator', l10n('authenticator.title'));
  }

  /** 打开或聚焦面板（单例）。 */
  static open(store: AuthenticatorStore): void {
    if (AuthenticatorView.current) {
      AuthenticatorView.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    AuthenticatorView.current = new AuthenticatorView(store);
  }

  /** 命令/「＋」入口：先配额预检，达上限弹升级、不展开表单；否则打开面板并请求表单。 */
  static openAddForm(store: AuthenticatorStore): void {
    const view = AuthenticatorView.ensure(store);
    view.requestAddForm();
  }

  /** EventBus 订阅入口：条目/分组/标签变更后重发快照。 */
  static refreshCurrent(): void {
    void AuthenticatorView.current?.refresh();
  }

  static disposeCurrent(): void {
    AuthenticatorView.current?.dispose();
  }

  private static ensure(store: AuthenticatorStore): AuthenticatorView {
    if (!AuthenticatorView.current) AuthenticatorView.current = new AuthenticatorView(store);
    else AuthenticatorView.current.panel.reveal(vscode.ViewColumn.Active);
    return AuthenticatorView.current;
  }

  private requestAddForm(): void {
    const q = this.store.checkQuota();
    if (!q.ok) { void promptAuthenticatorUpgrade(q.limit); return; }
    if (this.initSent) this.post({ type: 'openAddForm' });
    else this.pendingAction = 'openAddForm';
  }

  async refresh(): Promise<void> {
    if (!this.initSent) return;
    this.sendSnapshot();
    this.tick();
  }

  protected async handleMessage(raw: any): Promise<void> {
    const msg = raw as AuthenticatorUpMessage;
    switch (msg?.type) {
      case 'ready':
        if (!this.initSent) {
          this.initSent = true;
          this.post({ type: 'init', mode: 'authenticator' });
          return;
        }
        this.sendSnapshot();
        this.tick();
        this.startTimer();
        if (this.pendingAction === 'openAddForm') {
          this.pendingAction = undefined;
          this.post({ type: 'openAddForm' });
        }
        return;
      case 'copy': await this.onCopy(msg); return;
      case 'toggleGroup': this.onToggleGroup(msg); return;
      case 'requestAddForm': this.requestAddForm(); return;
      case 'addUri': this.onAddUri(msg); return;
      case 'addImage': await this.onAddImage(msg); return;
      case 'cancelPrefill': this.pendingPrefill = undefined; return;
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
    let secret = e.secret;
    // 预填表单（粘贴链接/扫码）不带 secret：用宿主暂存的一次性 secret 补齐。
    if (msg.prefillId !== undefined) {
      const pending = this.pendingPrefill;
      if (!pending || pending.id !== msg.prefillId) { this.postFormError('secret', 'authenticator.uri.invalid', 'external'); return; }
      secret = pending.secret;
    }
    const res = await this.store.addEntry({
      issuer: e.issuer, account: e.account, secret,
      algorithm: e.algorithm, digits: e.digits, period: e.period,
      groupId: this.normGroupId(e.groupId), tags: e.tags,
    });
    if (res.ok) { if (msg.prefillId !== undefined) this.pendingPrefill = undefined; return; }
    if (res.reason === 'quota') { await promptAuthenticatorUpgrade(res.limit); return; }
    if (res.reason === 'invalidSecret') { this.postFormError(res.field ?? 'secret', 'authenticator.err.invalidSecret'); return; }
    if (res.reason === 'invalidField') { this.postFormError(res.field, 'authenticator.err.invalidField'); return; }
    this.post({ type: 'error', message: l10n('authenticator.error.generic') });
  }

  private async onUpdate(msg: Extract<AuthenticatorUpMessage, { type: 'update' }>): Promise<void> {
    const p = msg.patch;
    const res = await this.store.updateEntry(msg.id, {
      issuer: p.issuer, account: p.account, secret: p.secret,
      algorithm: p.algorithm, digits: p.digits, period: p.period,
      // 原样透传：store 以 `!== undefined` 判定分组变更，null/''=移到未分组。
      groupId: p.groupId, tags: p.tags,
    });
    if (res.ok) return;
    if (res.reason === 'invalidSecret') { this.postFormError('secret', 'authenticator.err.invalidSecret'); return; }
    if (res.reason === 'invalidField') { this.postFormError(undefined, 'authenticator.err.invalidField'); return; }
    this.post({ type: 'error', message: l10n('authenticator.error.generic') });
  }

  private async onAddImage(msg: Extract<AuthenticatorUpMessage, { type: 'addImage' }>): Promise<void> {
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
    this.prefillFromUri(uri, 'authenticator.image.invalid');
  }

  /**
   * 解析 otpauth URI 后**不直接入库**：secret 留在宿主，只下发非密文字段 + 一次性 prefillId，
   * webview 打开预填表单、选好分组后再按 prefillId 合并 secret 入库（守住「secret 不下发」约束）。
   * 直接入库的分支（配额/字段校验）随之移到 onAdd。
   */
  private prefillFromUri(uri: string, invalidKey: string): void {
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
    const id = uniqueId('ap');
    this.pendingPrefill = { id, secret: parsed.secret };
    this.post({
      type: 'prefillAdd', prefillId: id,
      entry: {
        issuer: parsed.issuer, account: parsed.account,
        algorithm: parsed.algorithm, digits: parsed.digits, period: parsed.period,
      },
    });
  }

  private onAddUri(msg: Extract<AuthenticatorUpMessage, { type: 'addUri' }>): void {
    if (typeof msg.uri !== 'string' || !msg.uri) { this.postFormError(undefined, 'authenticator.uri.invalid', 'external'); return; }
    this.prefillFromUri(msg.uri, 'authenticator.uri.invalid');
  }

  private async onDelete(msg: Extract<AuthenticatorUpMessage, { type: 'delete' }>): Promise<void> {
    const res = await this.store.deleteEntry(msg.id);
    if (!res.ok) this.post({ type: 'error', message: l10n('authenticator.error.generic') });
  }

  private async onAddGroup(msg: Extract<AuthenticatorUpMessage, { type: 'addGroup' }>): Promise<void> {
    const res = msg.beforeId !== undefined
      ? await this.store.addGroupBefore(msg.name, msg.beforeId)
      : await this.store.addGroup(msg.name, msg.afterId);
    if (!res.ok) { this.postFormError('name', 'authenticator.err.invalidName'); return; }
    // 回传新分组 id：添加表单里「新建分组」后据此自动选中。
    this.post({ type: 'groupAdded', id: res.group.id });
  }

  private async onUpdateGroup(msg: Extract<AuthenticatorUpMessage, { type: 'updateGroup' }>): Promise<void> {
    const res = await this.store.renameGroup(msg.id, msg.name);
    if (!res.ok) this.postFormError('name', res.reason === 'invalidName' ? 'authenticator.err.invalidName' : 'authenticator.err.notFound');
  }

  private async onDeleteGroup(msg: Extract<AuthenticatorUpMessage, { type: 'deleteGroup' }>): Promise<void> {
    await this.store.deleteGroup(msg.id);
  }

  private async onMoveEntry(msg: Extract<AuthenticatorUpMessage, { type: 'moveEntry' }>): Promise<void> {
    const res = await this.store.updateEntry(msg.id, { groupId: msg.targetGroupId });
    if (!res.ok) this.post({ type: 'error', message: l10n('authenticator.error.generic') });
  }

  private async onReorderGroup(msg: Extract<AuthenticatorUpMessage, { type: 'reorderGroup' }>): Promise<void> {
    await this.store.reorderGroup(msg.orderedGroupIds);
  }

  private async onAddTag(msg: Extract<AuthenticatorUpMessage, { type: 'addTag' }>): Promise<void> {
    const res = await this.store.addTag(msg.name, msg.color);
    if (!res.ok) { this.postFormError('name', res.reason === 'invalidName' ? 'authenticator.err.invalidName' : 'authenticator.err.invalidColor'); return; }
    // 回传新标签 id：添加/编辑表单里新建标签后据此自动勾选。
    this.post({ type: 'tagAdded', id: res.tag.id });
  }

  private async onRemoveTag(msg: Extract<AuthenticatorUpMessage, { type: 'removeTag' }>): Promise<void> {
    await this.store.deleteTag(msg.id);
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
      this.post({ type: 'snapshot', entries, groups: [...this.store.listGroups()], tags: [...this.store.listTags()] });
    } catch (e) {
      diagError('authenticator snapshot', String(e));
    }
  }

  /** 未分组/孤儿 groupId 归一为 null，与 UI sections 的未分组判定一致。 */
  private effectiveGroupKey(groupId: string | undefined, validGroupIds: Set<string>): string | null {
    return groupId && validGroupIds.has(groupId) ? groupId : null;
  }

  private tick(): void {
    if (!this.initSent) return;
    try {
      const nowMs = Date.now();
      const validGroupIds = new Set(this.store.listGroups().map((g) => g.id));
      const ids = this.store.listEntries()
        .filter((e) => !this.foldedGroups.has(this.effectiveGroupKey(e.groupId, validGroupIds)))
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
    if (typeof msg.folded !== 'boolean') return;
    const key: string | null = typeof msg.groupId === 'string' ? msg.groupId : null;
    if (msg.folded) this.foldedGroups.add(key);
    else this.foldedGroups.delete(key);
    if (!msg.folded) this.tick();
  }

  private startTimer(): void {
    this.clearTimer();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  private clearTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  protected onDispose(): void {
    super.onDispose();
    this.clearTimer();
    this.foldedGroups.clear();
    this.pendingPrefill = undefined;
    if (AuthenticatorView.current === this) AuthenticatorView.current = undefined;
  }
}
