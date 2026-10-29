import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import { diagError } from '../utils/diagnostics';
import { errorDetail } from './syncFailure';
import { DEFAULT_SERVER_URL, type AuthService } from './authService';
import type { SyncSessionFactory } from '@devbelt/db-host/sync/sessionFactory';
import type { HubTab } from '../result/protocol';
import { AuthEvent, eventBus } from '@devbelt/db-host/utils/event';

/**
 * 账户中心（单面板 + 标签页：账户 / 设备 / 套餐）。
 *
 * 合并原 AccountView / SessionView / PlansView 三个独立面板为一个面板，viewType 仍为
 * `devbelt.account`（命令 id 不变），点标签在面板内切换。消息协议：
 *   webview → ext: ready{view?} | action{action} | revoke{deviceId} | openConsole{path}
 *   ext → webview: init{mode:'accountHub',tab} | me{me} | syncStatus{status}
 *                  | devices{devices,canRevoke} | plans{plans,current,loggedIn}
 *                  | selectTab{tab} | error{message}
 *
 * 握手沿用「两次 ready」：首个 ready（默认视图 QueryView，无 view）→ 下发 init 切换模式；
 * 之后每个标签子视图挂载时发 ready{view}，据 view 下发对应数据。
 */

/** webview 可触发的命令白名单（`action` 不能借此执行任意命令）。 */
const ACTION_COMMANDS = new Set<string>([
  // 单一「启用同步」入口：按远端状态自动路由（有→解锁，无→初始化），不自动同步。
  'devbelt.syncEntry',
  'devbelt.initializePersonalSync',
  'devbelt.unlockPersonalSync',
  'devbelt.changeLoginPassword',
  'devbelt.changeSyncPassword',
  'devbelt.recoverSync',
  'devbelt.recoverByAccount',
  'devbelt.resetSync',
  'devbelt.resetLocalSync',
  'devbelt.destroySync',
  'devbelt.syncDoctor',
  'devbelt.authenticator',
  'devbelt.syncNow',
  'devbelt.syncPull',
  'devbelt.syncPush',
  'devbelt.exportConnections',
  'devbelt.importConnections',
  'devbelt.sessions',
  'devbelt.plans',
  'devbelt.openConsole',
  'devbelt.logout',
]);

/** 套餐「升级」只能打开控制台固定路径（webview 不能借此打开任意 URL）。 */
const CONSOLE_PATHS = new Set<string>(['/db/plans', '/db/checkout']);

interface SyncStatusSummary {
  initialized: boolean;
  unlocked: boolean;
  keyEpoch: string | null;
  conflicts: number;
  pendingCleanup: boolean;
}

export class AccountHubView extends BaseWebView {
  private static current?: AccountHubView;
  private readonly auth: AuthService;
  private readonly factory: SyncSessionFactory;
  /** 首次 ready 时下发的初始标签；后续命令触发只发 selectTab。 */
  private readonly initialTab: HubTab;
  private readonly authSub: { dispose(): void };

  private constructor(auth: AuthService, factory: SyncSessionFactory, tab: HubTab) {
    super('devbelt.account', l10n('account.title'));
    this.auth = auth;
    this.factory = factory;
    this.initialTab = tab;
    // 换号/登出时本面板若开着，重新拉账号与设备列表，避免停留在上一个账号的数据。
    this.authSub = eventBus.subscribe(AuthEvent, () => {
      void this.sendAccount();
      void this.sendSession();
    });
  }

  static open(auth: AuthService, factory: SyncSessionFactory, tab: HubTab = 'account'): void {
    if (AccountHubView.current) {
      AccountHubView.current.panel.reveal(vscode.ViewColumn.Active);
      // 面板已存在：直接切到请求的标签，不重建面板。
      AccountHubView.current.post({ type: 'selectTab', tab });
      return;
    }
    AccountHubView.current = new AccountHubView(auth, factory, tab);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg?.type === 'ready') {
      if (!this.initSent) {
        this.initSent = true;
        this.post({ type: 'init', mode: 'accountHub', tab: this.initialTab });
        return;
      }
      // 标签子视图挂载后按 view 请求数据。
      if (msg.view === 'session') { await this.sendSession(); return; }
      if (msg.view === 'plans') { await this.sendPlans(); return; }
      // sync / security 也只需要账户+同步状态；Security 页本身只触发命令。
      await this.sendAccount();
      return;
    }
    if (msg?.type === 'action' && typeof msg.action === 'string' && ACTION_COMMANDS.has(msg.action)) {
      await vscode.commands.executeCommand(msg.action);
      // 打开设备/套餐是切标签（open() 会发 selectTab），无需再刷账户。
      if (msg.action === 'devbelt.sessions' || msg.action === 'devbelt.plans') return;
      // 其余动作（改密/登出/口令变更/同步）可能改变账户或同步态，回传后刷新。
      await this.sendAccount();
      return;
    }
    if (msg?.type === 'revoke' && msg.deviceId) {
      try {
        await this.auth.client.revokeDevice(String(msg.deviceId));
        await this.sendSession();
      } catch (e) {
        diagError('account hub request failed', { op: 'revokeDevice', ...errorDetail(e) });
        this.post({ type: 'error', message: l10n('account.loadFailed') });
      }
      return;
    }
    if (msg?.type === 'openConsole' && typeof msg.path === 'string' && CONSOLE_PATHS.has(msg.path)) {
      void vscode.env.openExternal(vscode.Uri.parse(`${DEFAULT_SERVER_URL}${msg.path}`));
      return;
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
      diagError('account hub request failed', { op: 'getMe', ...errorDetail(e) });
      this.post({ type: 'error', message: l10n('account.loadFailed') });
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

  /** 下发设备列表（撤销本人设备恒允许，canRevoke 恒为 true）。 */
  private async sendSession(): Promise<void> {
    try {
      void this.auth.refreshEntitlement();
      const { devices } = await this.auth.client.listDevices();
      this.post({ type: 'devices', devices, canRevoke: true, currentDeviceId: this.auth.currentDeviceId() });
    } catch (e) {
      diagError('account hub request failed', { op: 'listDevices', ...errorDetail(e) });
      this.post({ type: 'error', message: l10n('account.loadFailed') });
    }
  }

  /** 下发套餐目录与当前个人套餐（未登录只下发未登录态）。 */
  private async sendPlans(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      this.post({ type: 'plans', plans: null, current: null, loggedIn: false });
      return;
    }
    try {
      let current = this.auth.getCachedEntitlement()?.planCode ?? 'free';
      let periodEndTime: string | null = null;
      try {
        const me = await this.auth.getMe();
        current = me.subscription?.planCode ?? current;
        periodEndTime = me.subscription?.periodEndTime ?? null;
      } catch {
        // /me 失败不阻断套餐目录；保留缓存套餐。
      }
      const plans = await this.auth.client.getPlans();
      this.post({ type: 'plans', plans, current, periodEndTime, loggedIn: true });
    } catch (e) {
      diagError('account hub request failed', { op: 'getPlans', ...errorDetail(e) });
      this.post({ type: 'error', message: l10n('account.loadFailed') });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    this.authSub.dispose();
    if (AccountHubView.current === this) AccountHubView.current = undefined;
  }
}