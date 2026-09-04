import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import type { AuthService } from './authService';

/**
 * 账户面板消息协议：
 * webview -> ext: ready
 * ext -> webview: init{mode:'account'} | me{me} | error{message}
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
    if (msg?.type !== 'ready') return;
    if (!this.initSent) {
      this.initSent = true;
      this.post({ type: 'init', mode: 'account' });
      return;
    }
    try {
      const me = await this.auth.getMe();
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
