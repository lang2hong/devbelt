import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import { diagError } from '../utils/diagnostics';
import { looksLikeNetworkError } from './syncFailure';
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
  private readonly auth: AuthService;
  private readonly onLoggedIn?: () => void;

  private constructor(auth: AuthService, onLoggedIn?: () => void) {
    super('devbelt.login', l10n('login.title'));
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

    // 注册只发送验证邮件，不返回 token，随后进入邮箱验证步骤。
    if (msg?.type === 'login' || msg?.type === 'register') {
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
        if (msg.type === 'register') {
          await this.auth.register(email, password);
          this.post({ type: 'verifySent', email, message: l10n('login.verifySent') });
        } else {
          await this.auth.login(email, password);
          this.post({ type: 'success', message: l10n('login.success') });
          this.onLoggedIn?.();
          setTimeout(() => this.dispose(), 600);
        }
      } catch (err) {
        this.postError(err);
      }
      return;
    }

    // 验证 token（注册后）
    if (msg?.type === 'verify') {
      const token: string = (msg.token || '').trim();
      if (!token) {
        this.post({ type: 'error', message: l10n('login.tokenRequired') });
        return;
      }
      try {
        await this.auth.confirmEmail(token);
        this.post({ type: 'verified', message: l10n('login.verified') });
      } catch (err) {
        this.postError(err);
      }
      return;
    }

    // 重发验证邮件
    if (msg?.type === 'resend') {
      const email: string = (msg.email || '').trim();
      if (!email) {
        this.post({ type: 'error', message: l10n('login.fail') });
        return;
      }
      try {
        await this.auth.resendVerification(email);
        this.post({ type: 'success', message: l10n('login.verifyResent') });
      } catch (err) {
        this.postError(err);
      }
    }
  }

  private postError(err: unknown): void {
    // 权益错误单独本地化：设备数超限等来自服务端的 403，否则英文原文会直接冒泡进登录框。
    const codeOf = (x: unknown): string | undefined => {
      if (!x || typeof x !== 'object') return undefined;
      const c = (x as { code?: string }).code;
      if (typeof c === 'string') return c;
      const cause = (x as { cause?: unknown }).cause;
      return codeOf(cause);
    };
    if (codeOf(err) === 'PERSONAL_FEATURE_REQUIRED') {
      diagError('login failed: personal feature required', String((err as Error)?.message ?? err));
      this.post({ type: 'error', message: l10n('login.deviceLimit') });
      return;
    }
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const cause = e.cause ? [e.cause.code, e.cause.message].filter(Boolean).join(': ') : '';
    const m = e.message || l10n('login.fail');
    // 内部原因只进诊断通道，弹窗只给用户可理解的失败文案。
    if (cause) diagError(`login failed: ${m} (${cause})`);
    // 网络层故障（fetch failed / ECONN* / 超时）是英文技术串，用户无从下手：换成本地化说明。
    // 服务端给出的业务错误文案（密码错误等）保持原样。
    if (looksLikeNetworkError(m, e.cause?.code, e.cause?.message)) {
      this.post({ type: 'error', message: l10n('login.networkError') });
      return;
    }
    this.post({ type: 'error', message: m });
  }

  protected onDispose(): void {
    super.onDispose();
    if (LoginFormView.current === this) LoginFormView.current = undefined;
  }
}
