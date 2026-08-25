import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import type { AuthService } from './authService';

/**
 * 账户/套餐面板（Vue 版，替代原 accountView.ts 的同步塞 HTML）。
 *
 * 消息协议（与 webview/src/views/AccountView.vue 对齐）：
 *   webview → ext: ready | upgrade{code}
 *   ext → webview: init{mode:'account'} | me{me} | error{message}
 *
 * 原实现是「先 loading HTML、getMe 后整体替换 HTML」，迁移后改为异步消息：
 * 视图挂载后发 ready，扩展端 getMe 再回 me（或 error）。
 */
export class AccountView extends BaseWebView {
  private static current?: AccountView;
  private initSent = false;
  private readonly auth: AuthService;

  private constructor(auth: AuthService) {
    super('dbclient.account', l10n('account.title'));
    this.auth = auth;
  }

  static open(auth: AuthService): void {
    if (AccountView.current) {
      AccountView.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    AccountView.current = new AccountView(auth);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg?.type === 'upgrade') {
      void vscode.window.showInformationMessage(l10n('account.upgradeHint'));
      return;
    }
    if (msg?.type !== 'ready') return;
    if (!this.initSent) {
      this.initSent = true;
      this.post({ type: 'init', mode: 'account' });
      return;
    }
    try {
      const me = await this.auth.client.getMe();
      this.post({ type: 'me', me });
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (AccountView.current === this) AccountView.current = undefined;
  }
}
