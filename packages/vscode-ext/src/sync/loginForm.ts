import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { AuthService } from './authService';
import { l10n } from '../i18n';

/**
 * 登录/注册表单（webview 单页，登录/注册 tab 切换）。
 * 保持 LoginForm.open(auth, onLoggedIn?) 接口不变。
 */
export class LoginForm {
  private static panel: vscode.WebviewPanel | undefined;

  static async open(auth: AuthService, onLoggedIn?: () => void): Promise<void> {
    if (LoginForm.panel) {
      LoginForm.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbclient.login',
      l10n('login.title'),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    LoginForm.panel = panel;
    panel.webview.html = LoginForm.html();

    const disposable = panel.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg?.type !== 'login' && msg?.type !== 'register') return;
      const email: string = (msg.email || '').trim();
      const password: string = msg.password || '';
      const confirm: string = msg.confirm || '';
      if (!email || !password) {
        panel.webview.postMessage({ type: 'error', message: l10n('login.fail') });
        return;
      }
      if (msg.type === 'register' && password !== confirm) {
        panel.webview.postMessage({ type: 'error', message: l10n('login.pwMismatch') });
        return;
      }
      try {
        if (msg.type === 'register') await auth.register(email, password);
        else await auth.login(email, password);
        panel.webview.postMessage({ type: 'success', message: l10n('login.success') });
        onLoggedIn?.();
        setTimeout(() => panel.dispose(), 600);
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: (err as Error).message || l10n('login.fail') });
      }
    });

    panel.onDidDispose(() => {
      disposable.dispose();
      LoginForm.panel = undefined;
    });
  }

  private static html(): string {
    const nonce = randomUUID();
    const s = (k: string) => l10n(k);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display:flex; justify-content:center; padding: 48px 20px; box-sizing:border-box; margin: 0; }
  .card { width: 320px; }
  .tabs { display:flex; margin-bottom: 18px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { flex:1; padding: 8px; text-align:center; cursor:pointer; color: var(--vscode-descriptionForeground); font-size: 13px; user-select:none; }
  .tab.active { color: var(--vscode-foreground); border-bottom: 2px solid var(--vscode-focusBorder); }
  .field { margin-bottom: 12px; }
  label { display:block; font-size: 12px; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
  input { width: 100%; box-sizing:border-box; padding: 6px 8px; font-size: 13px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; outline: none; }
  input:focus { border-color: var(--vscode-focusBorder); }
  .btn { width:100%; padding: 7px; font-size:13px; border:none; border-radius:3px; cursor:pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn:disabled { opacity: .5; cursor: default; }
  .msg { font-size: 12px; margin-top: 10px; min-height: 16px; }
  .error { color: var(--vscode-errorForeground); }
  .success { color: var(--vscode-testing-iconPassed-color, #4ec9b0); }
  #confirmField { display: none; }
</style>
</head>
<body>
<div class="card">
  <div class="tabs">
    <div class="tab active" id="tabLogin">${s('login.tabLogin')}</div>
    <div class="tab" id="tabRegister">${s('login.tabRegister')}</div>
  </div>
  <form id="form">
    <div class="field"><label for="email">${s('login.email')}</label><input id="email" name="email" type="email" autocomplete="off" /></div>
    <div class="field"><label for="password">${s('login.password')}</label><input id="password" name="password" type="password" autocomplete="off" /></div>
    <div class="field" id="confirmField"><label for="confirm">${s('login.confirm')}</label><input id="confirm" name="confirm" type="password" autocomplete="off" /></div>
    <button class="btn" id="submit" type="submit">${s('login.submitLogin')}</button>
    <div class="msg error" id="error"></div>
    <div class="msg success" id="success"></div>
  </form>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const S = { submitLogin: ${JSON.stringify(s('login.submitLogin'))}, submitRegister: ${JSON.stringify(s('login.submitRegister'))} };
let mode = 'login';
const tabLogin = document.getElementById('tabLogin');
const tabRegister = document.getElementById('tabRegister');
const confirmField = document.getElementById('confirmField');
const submit = document.getElementById('submit');
const error = document.getElementById('error');
const success = document.getElementById('success');
const emailEl = document.getElementById('email');
const passwordEl = document.getElementById('password');
const confirmEl = document.getElementById('confirm');
function setMode(m) {
  mode = m;
  tabLogin.className = 'tab' + (m === 'login' ? ' active' : '');
  tabRegister.className = 'tab' + (m === 'register' ? ' active' : '');
  confirmField.style.display = (m === 'register') ? 'block' : 'none';
  submit.textContent = (m === 'register') ? S.submitRegister : S.submitLogin;
  error.textContent = ''; success.textContent = '';
}
tabLogin.onclick = () => setMode('login');
tabRegister.onclick = () => setMode('register');
document.getElementById('form').onsubmit = (e) => {
  e.preventDefault();
  error.textContent = ''; success.textContent = '';
  submit.disabled = true;
  vscode.postMessage({ type: mode, email: emailEl.value, password: passwordEl.value, confirm: confirmEl.value });
};
window.addEventListener('message', (e) => {
  const msg = e.data;
  submit.disabled = false;
  if (msg.type === 'error') { error.textContent = msg.message; }
  else if (msg.type === 'success') { success.textContent = msg.message; }
});
setMode('login');
emailEl.focus();
</script>
</body>
</html>`;
  }
}
