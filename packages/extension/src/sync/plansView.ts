import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import { DEFAULT_SERVER_URL, type AuthService } from './authService';

/**
 * 套餐面板（Vue 版）：展示个人/组织套餐目录与当前个人套餐。
 *
 * 消息协议（与 webview/src/views/PlansView.vue 对齐）：
 *   webview → ext: ready | openConsole{path}
 *   ext → webview: init{mode:'plans'} | plans{plans,current,loggedIn} | error{message}
 *
 * 目录来自 GET /api/db/plans（需登录）；当前套餐取 AuthService 的权益缓存（/api/db/me 落盘）。
 * 升级/联系等动作只允许打开浏览器控制台的固定路径（白名单，webview 不能借此打开任意 URL）。
 */
const CONSOLE_PATHS = new Set<string>(['/console/plans', '/console/checkout']);

export class PlansView extends BaseWebView {
  private static current?: PlansView;
  private initSent = false;

  private constructor(private readonly auth: AuthService) {
    super('dbclient.plans', l10n('plan.title'));
  }

  static open(auth: AuthService): void {
    if (PlansView.current) {
      PlansView.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    PlansView.current = new PlansView(auth);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg?.type === 'ready') {
      if (!this.initSent) {
        this.initSent = true;
        this.post({ type: 'init', mode: 'plans' });
        return;
      }
      await this.sendPlans();
      return;
    }
    if (msg?.type === 'openConsole' && typeof msg.path === 'string' && CONSOLE_PATHS.has(msg.path)) {
      void vscode.env.openExternal(vscode.Uri.parse(`${DEFAULT_SERVER_URL}${msg.path}`));
    }
  }

  private async sendPlans(): Promise<void> {
    const loggedIn = this.auth.isLoggedIn();
    if (!loggedIn) {
      this.post({ type: 'plans', plans: null, current: null, loggedIn: false });
      return;
    }
    try {
      // 刷新权益缓存，确保「当前套餐」是最新值（refreshEntitlement 内部吞错，失败降级到缓存/Free）。
      await this.auth.refreshEntitlement();
      const plans = await this.auth.client.getPlans();
      const current = this.auth.getCachedEntitlement()?.planCode ?? 'free';
      this.post({ type: 'plans', plans, current, loggedIn: true });
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (PlansView.current === this) PlansView.current = undefined;
  }
}