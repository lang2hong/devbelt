import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { AuthService } from './authService';
import { l10n } from '../i18n';

/** 设备/会话管理 webview：列出活跃会话、踢出设备 */
export class SessionView {
  private static panel?: vscode.WebviewPanel;

  static async open(auth: AuthService): Promise<void> {
    if (SessionView.panel) { SessionView.panel.reveal(vscode.ViewColumn.Active); return; }
    const panel = vscode.window.createWebviewPanel(
      'dbclient.sessions', l10n('sessions.title'), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    SessionView.panel = panel;
    panel.webview.html = SessionView.html();

    const refresh = async () => {
      try {
        const sessions = await auth.client.listSessions();
        panel.webview.postMessage({ type: 'sessions', sessions });
      } catch (e) {
        panel.webview.postMessage({ type: 'error', message: (e as Error).message });
      }
    };
    void refresh();
    const d = panel.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg?.type === 'revoke' && msg.id != null) {
        try { await auth.client.revokeSession(Number(msg.id)); await refresh(); }
        catch (e) { panel.webview.postMessage({ type: 'error', message: (e as Error).message }); }
      }
    });
    panel.onDidDispose(() => { d.dispose(); SessionView.panel = undefined; });
  }

  private static html(): string {
    const nonce = randomUUID();
    const s = (k: string) => l10n(k);
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;margin:0}
h2{font-size:14px;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid var(--vscode-panel-border);padding:6px 10px;text-align:left}
th{background:var(--vscode-editor-background)}
.btn{padding:3px 10px;border:none;border-radius:3px;cursor:pointer;background:var(--vscode-errorForeground);color:#fff}
.err{color:var(--vscode-errorForeground);font-size:12px;margin-top:8px}
.empty{color:var(--vscode-descriptionForeground);font-size:12px}
</style></head><body>
<h2>${s('sessions.title')}</h2>
<table><thead><tr><th>${s('sessions.device')}</th><th>IP</th><th>${s('sessions.created')}</th><th>${s('sessions.lastUsed')}</th><th>${s('sessions.current')}</th><th></th></tr></thead>
<tbody id="list"></tbody></table>
<div class="err" id="error"></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
window.addEventListener('message',e=>{const m=e.data;if(m.type==='sessions')render(m.sessions);else if(m.type==='error')document.getElementById('error').textContent=m.message;});
function fmt(s){if(!s)return '-';var d=new Date(s);if(isNaN(d))return s;var p=function(n){return (n<10?'0':'')+n;};return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());}
function render(ss){const l=document.getElementById('list');if(!ss.length){l.innerHTML='<tr><td colspan=6 class="empty">${s('sessions.empty')}</td></tr>';return;}l.innerHTML=ss.map(x=>'<tr><td>'+(x.deviceName||'-')+'</td><td>'+(x.ip||'-')+'</td><td>'+fmt(x.createTime)+'</td><td>'+fmt(x.lastUsedTime)+'</td><td>'+(x.current?'✓':'')+'</td><td>'+(x.current?'':'<button class="btn" onclick="revoke('+x.id+')">${s('sessions.kick')}</button>')+'</td></tr>').join('');}
function revoke(id){vscode.postMessage({type:'revoke',id});}
</script></body></html>`;
  }
}
