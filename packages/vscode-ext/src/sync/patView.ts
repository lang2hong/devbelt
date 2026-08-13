import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { AuthService } from './authService';
import { l10n } from '../i18n';

/** PAT 管理 webview：列/建/撤个人访问令牌 */
export class PatView {
  private static panel?: vscode.WebviewPanel;

  static async open(auth: AuthService): Promise<void> {
    if (PatView.panel) { PatView.panel.reveal(vscode.ViewColumn.Active); return; }
    const panel = vscode.window.createWebviewPanel(
      'dbclient.pats', l10n('pats.title'), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    PatView.panel = panel;
    panel.webview.html = PatView.html();

    const refresh = async () => {
      try {
        const pats = await auth.client.listPats();
        panel.webview.postMessage({ type: 'pats', pats });
      } catch (e) {
        panel.webview.postMessage({ type: 'error', message: (e as Error).message });
      }
    };
    void refresh();
    const d = panel.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg?.type === 'create') {
        try {
          const r = await auth.client.createPat(msg.name, msg.scopes);
          panel.webview.postMessage({ type: 'created', token: r.token, name: msg.name });
          await refresh();
        } catch (e) { panel.webview.postMessage({ type: 'error', message: (e as Error).message }); }
      } else if (msg?.type === 'revoke' && msg.id != null) {
        try { await auth.client.revokePat(Number(msg.id)); await refresh(); }
        catch (e) { panel.webview.postMessage({ type: 'error', message: (e as Error).message }); }
      }
    });
    panel.onDidDispose(() => { d.dispose(); PatView.panel = undefined; });
  }

  private static html(): string {
    const nonce = randomUUID();
    const s = (k: string) => l10n(k);
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;margin:0}
h2{font-size:14px;margin:0 0 12px}
.form{display:flex;gap:6px;margin-bottom:16px}
input{padding:5px 8px;font-size:13px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px}
input.name{width:160px} input.scopes{flex:1;min-width:200px}
.btn{padding:5px 12px;border:none;border-radius:3px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:13px}
.btn.danger{background:var(--vscode-errorForeground);color:#fff}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid var(--vscode-panel-border);padding:6px 10px;text-align:left}
.token{margin:8px 0;padding:8px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:3px;font-family:monospace;font-size:12px;word-break:break-all}
.err{color:var(--vscode-errorForeground);font-size:12px;margin-top:8px}
.empty{color:var(--vscode-descriptionForeground);font-size:12px}
</style></head><body>
<h2>${s('pats.title')}</h2>
<div class="form">
<input id="name" class="name" placeholder="${s('pats.createName')}" />
<input id="scopes" class="scopes" placeholder="${s('pats.scopes')} (sync:read,sync:write)" />
<button class="btn" id="createBtn">${s('pats.createBtn')}</button>
</div>
<div id="tokenArea"></div>
<table><thead><tr><th>${s('pats.name')}</th><th>${s('pats.scopes')}</th><th>${s('pats.created')}</th><th></th></tr></thead><tbody id="list"></tbody></table>
<div class="err" id="error"></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
document.getElementById('createBtn').onclick=()=>{const name=document.getElementById('name').value.trim();if(!name)return;const scopes=document.getElementById('scopes').value.trim();vscode.postMessage({type:'create',name,scopes});};
window.addEventListener('message',e=>{const m=e.data;if(m.type==='pats')render(m.pats);else if(m.type==='created')showToken(m.token,m.name);else if(m.type==='error')document.getElementById('error').textContent=m.message;});
function render(pp){const l=document.getElementById('list');if(!pp.length){l.innerHTML='<tr><td colspan=4 class="empty">${s('pats.empty')}</td></tr>';return;}l.innerHTML=pp.map(p=>'<tr><td>'+p.name+'</td><td>'+p.scopes+'</td><td>'+p.createTime+'</td><td><button class="btn danger" onclick="revoke('+p.id+')">${s('pats.revoke')}</button></td></tr>').join('');}
function revoke(id){vscode.postMessage({type:'revoke',id});}
function showToken(token,name){const a=document.getElementById('tokenArea');a.innerHTML='<div class="token">'+token+'</div><div style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:8px">${s('pats.token')}</div>';}
</script></body></html>`;
  }
}
