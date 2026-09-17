import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import type { AuthService } from './authService';
import type { SyncSessionFactory } from './sessionFactory';

/**
 * 账户面板消息协议：
 * webview -> ext: ready | action{action}
 * ext -> webview: init{mode:'account',loggedIn,isZh} | me{me} | syncStatus{status} | error{message}
 *
 * `action` 为下表中的命令 id 白名单，webview 不能借此触发任意命令。
 */
const ACTION_COMMANDS = new Set<string>([
  'devbelt.initializePersonalSync',
  'devbelt.unlockPersonalSync',
  'devbelt.changeLoginPassword',
  'devbelt.changeSyncPassword',
  'devbelt.recoverSync',
  'devbelt.recoverByAccount',
  'devbelt.resetSync',
  'devbelt.syncPull',
  'devbelt.syncPush',
  'devbelt.exportConnections',
  'devbelt.importConnections',
  'devbelt.sessions',
  'devbelt.plans',
  'devbelt.openConsole',
  'devbelt.logout',
]);

interface SyncStatusSummary {
  initialized: boolean;
  unlocked: boolean;
  keyEpoch: string | null;
  conflicts: number;
  pendingCleanup: boolean;
}

export class AccountView extends BaseWebView {
  private static current?: AccountView;
  private readonly auth: AuthService;
  private readonly factory: SyncSessionFactory;
  private initSent = false;

  private constructor(auth: AuthService, factory: SyncSessionFactory) {
    super('devbelt.account', l10n('account.title'));
    this.auth = auth;
    this.factory = factory;
  }

  static open(auth: AuthService, factory: SyncSessionFactory): void {
    if (AccountView.current) {
      AccountView.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    AccountView.current = new AccountView(auth, factory);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg?.type === 'ready') {
      // 首次 ready 来自默认视图（QueryView）：只切到 account。
      // 子视图（AccountView）挂载后再次 ready，此时才下发数据，避免早于挂载而丢失。
      if (!this.initSent) {
        this.initSent = true;
        this.post({ type: 'init', mode: 'account' });
        return;
      }
      await this.sendAccount();
      return;
    }
    if (msg?.type === 'action' && typeof msg.action === 'string' && ACTION_COMMANDS.has(msg.action)) {
      await vscode.commands.executeCommand(msg.action);
      // 动作（改密/登出/口令变更）可能改变账户或同步态，回传后刷新。
      await this.sendAccount();
    }
  }

  /** 下发账户信息与同步状态；未登录只下发未登录态。 */
  private async sendAccount(): Promise<void> {
    const loggedIn = this.auth.isLoggedIn();
    if (!loggedIn) {
      this.post({ type: 'me', me: null });
      this.post({ type: 'syncStatus', status: null });
      return;
    }
    try {
      await this.factory.ensureSession();
    } catch {
      // 会话不可用不阻断账户信息展示；同步状态按已建会话（可能为空）呈现。
    }
    try {
      const me = await this.auth.getMe();
      this.post({ type: 'me', me });
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
    this.post({ type: 'syncStatus', status: this.syncSummary() });
  }

  private syncSummary(): SyncStatusSummary {
    const s = this.factory.current;
    return {
      initialized: s?.localEpoch !== undefined,
      unlocked: s?.isUnlocked ?? false,
      keyEpoch: s?.localEpoch ?? null,
      conflicts: s?.listConflicts().length ?? 0,
      pendingCleanup: s?.pendingCleanup !== undefined,
    };
  }

  protected onDispose(): void {
    super.onDispose();
    if (AccountView.current === this) AccountView.current = undefined;
  }
}