import * as vscode from 'vscode';
import { AuthService } from './authService';
import { l10n } from '../i18n';

/**
 * 登录/注册表单（InputBox 方式，替代原 webview）。
 * 保持 LoginForm.open(auth, onLoggedIn?) 接口不变。
 */
export class LoginForm {
  static async open(auth: AuthService, onLoggedIn?: () => void): Promise<void> {
    const action = await vscode.window.showQuickPick(
      [
        { label: l10n('cmd.login'), value: 'login' as const },
        { label: l10n('cmd.register'), value: 'register' as const },
      ],
      { placeHolder: l10n('cmd.selectAction') },
    );
    if (!action) return;

    const email = await vscode.window.showInputBox({
      prompt: 'Email',
      placeHolder: 'user@example.com',
    });
    if (!email) return;

    const password = await vscode.window.showInputBox({
      prompt: 'Password',
      password: true,
    });
    if (!password) return;

    try {
      if (action.value === 'register') {
        await auth.register(email, password);
      } else {
        await auth.login(email, password);
      }
      onLoggedIn?.();
      vscode.window.showInformationMessage(l10n(action.value === 'register' ? 'cmd.registered' : 'cmd.loggedIn'));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  }
}
