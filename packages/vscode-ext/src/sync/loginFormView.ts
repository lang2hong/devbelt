import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import type { AuthService } from './authService';

/**
 * 登录/注册表单（Vue 版，替代原 loginForm.ts 的原生 HTML）。
 *
 * 消息协议（与 webview/src/views/LoginFormView.vue 对齐）：
 *   webview → ext: ready | login{email,password} | register{email,password,confirm}
 *   ext → webview: init{mode:'loginForm'} | error{message} | success{message}
 *
 * ready 双跳：App.vue 默认挂 QueryView，首个 ready 切到 loginForm 模式；
 * 第二个 ready 来自 LoginFormView 挂载，此后等待用户提交。
 */
export class LoginFormView extends BaseWebView {
  private static current?: LoginFormView;
  private initSent = false;
  private readonly auth: AuthService;
  private readonly onLoggedIn?: () => void;

  private constructor(auth: AuthService, onLoggedIn?: () => void) {
    super('dbclient.login', l10n('login.title'));
    this.auth = auth;
    this.onLoggedIn = onLoggedIn;
  }

  static open(auth: AuthService, onLoggedIn?: () => void): void {
    if (LoginFormView.current) {
      LoginFormView.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    LoginFormView.current = new LoginFormView(auth, onLoggedIn);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg?.type === 'ready') {
      if (!this.initSent) {
        this.initSent = true;
        this.post({ type: 'init', mode: 'loginForm' });
        return;
      }
      return; // 目标视图已挂载，等待用户提交
    }
    if (msg?.type !== 'login' && msg?.type !== 'register') return;

    const email: string = (msg.email || '').trim();
    const password: string = msg.password || '';
    const confirm: string = msg.confirm || '';
    if (!email || !password) {
      this.post({ type: 'error', message: l10n('login.fail') });
      return;
    }
    if (msg.type === 'register' && password !== confirm) {
      this.post({ type: 'error', message: l10n('login.pwMismatch') });
      return;
    }
    try {
      if (msg.type === 'register') await this.auth.register(email, password);
      else await this.auth.login(email, password);
      this.post({ type: 'success', message: l10n('login.success') });
      this.onLoggedIn?.();
      setTimeout(() => this.dispose(), 600);
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      const cause = e.cause ? [e.cause.code, e.cause.message].filter(Boolean).join(': ') : '';
      const m = e.message || l10n('login.fail');
      this.post({ type: 'error', message: cause ? `${m} [${cause}]` : m });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (LoginFormView.current === this) LoginFormView.current = undefined;
  }
}
