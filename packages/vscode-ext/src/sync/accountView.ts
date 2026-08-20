import * as vscode from 'vscode';
import type { AuthService } from './authService';
import { l10n } from '../i18n';

/** 账户/套餐面板：展示当前套餐、配额用量与订阅状态（升级入口） */
export class AccountView {
  private static panel?: vscode.WebviewPanel;

  static async open(auth: AuthService): Promise<void> {
    if (AccountView.panel) { AccountView.panel.reveal(vscode.ViewColumn.Active); return; }
    const panel = vscode.window.createWebviewPanel(
      'dbclient.account', l10n('account.title'), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    AccountView.panel = panel;
    panel.webview.html = AccountView.loadingHtml();

    try {
      const me = await auth.client.getMe();
      panel.webview.html = AccountView.detailHtml(me);
    } catch (e) {
      panel.webview.html = AccountView.errorHtml((e as Error).message);
    }
    panel.onDidDispose(() => { AccountView.panel = undefined; });
  }

  private static loadingHtml(): string {
    return '<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:20px">…</body></html>';
  }

  private static errorHtml(message: string): string {
    return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-errorForeground)">${message}</body></html>`;
  }

  private static detailHtml(me: any): string {
    const plan = me.plan;
    const u = me.usage;
    const sub = me.subscription;
    const bytes = (n: number) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
    const quota = (cur: number, max: number) => max === 0 ? `${cur} / ∞` : `${cur} / ${max}`;
    const row = (k: string, v: string) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;margin:0}
h2{font-size:14px;margin:0 0 12px}
table{border-collapse:collapse;font-size:13px;width:100%;max-width:440px}
td{padding:6px 10px;border:1px solid var(--vscode-panel-border)}
td:first-child{color:var(--vscode-descriptionForeground);width:160px}
p{color:var(--vscode-descriptionForeground);font-size:12px;margin-top:12px;max-width:440px}
</style></head><body>
<h2>${plan.name} <small>(${plan.code})</small></h2>
<table>
${row(l10n('account.devices'), quota(u.devices, plan.maxDevices))}
${row(l10n('account.connections'), quota(u.connections, plan.maxConnections))}
${row(l10n('account.sync'), `${bytes(u.syncBytes)} / ${plan.syncQuotaBytes ? bytes(plan.syncQuotaBytes) : '∞'}`)}
${row(l10n('account.subscription'), sub ? sub.status : '-')}
</table>
<p>${l10n('account.upgradeHint')}</p>
</body></html>`;
  }
}