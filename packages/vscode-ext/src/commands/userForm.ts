import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { DbTreeNode } from '../tree/dbTreeNode';
import type { Deps } from './shared';
import { requireCapability } from './shared';
import { l10n } from '../i18n';

const PRIVILEGES = [
  'ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE',
  'CREATE', 'ALTER', 'DROP', 'INDEX', 'CREATE VIEW', 'SHOW VIEW',
  'REFERENCES', 'TRIGGER', 'EXECUTE', 'GRANT OPTION',
];

export class UserForm extends BaseWebView {
  private constructor(
    private readonly mode: 'create' | 'grant',
    private readonly node: DbTreeNode,
    private readonly deps: Deps,
  ) {
    super('dbclient.userForm', `${mode === 'create' ? 'Create User' : 'Grant'} @ ${node.conn?.name || ''}`);
    this.panel.webview.html = this.buildHtml();
  }

  static openCreate(deps: Deps, node: DbTreeNode): void {
    new UserForm('create', node, deps);
  }

  static openGrant(deps: Deps, node: DbTreeNode): void {
    new UserForm('grant', node, deps);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type === 'cancel') { this.dispose(); return; }
    if (msg.type !== 'submit') return;
    try {
      const session = await this.deps.manager.connect(this.node.conn!);
      if (!requireCapability(session, 'manageUsers')) { this.dispose(); return; }
      if (this.mode === 'create') {
        await session.table.createUser(msg.name, msg.password, msg.host);
        this.deps.treeProvider.refresh();
        vscode.window.showInformationMessage(l10n('user.created', { name: msg.name }));
      } else {
        const parts = this.node.label.split('@');
        const db = msg.database || this.node.database;
        await session.table.grantPrivilege(parts[0], msg.priv, db, parts[1] || '%');
        this.deps.treeProvider.refresh();
        vscode.window.showInformationMessage(l10n('user.granted', { priv: msg.priv, name: this.node.label }));
      }
      this.dispose();
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  }

  private buildHtml(): string {
    if (this.mode === 'create') {
      return this.shell('Create User', `
        <div class="field"><label>Username</label><input id="name" autofocus></div>
        <div class="field"><label>Password</label><input id="password" type="password"></div>
        <div class="field"><label>Confirm Password</label><input id="confirm" type="password"></div>
        <div class="field"><label>Host</label><input id="host" value="%"></div>`,
        `const vscode=acquireVsCodeApi();
function submit(){const n=name.value,p=password.value,c=confirm.value,h=host.value||'%';if(!n)return alert('Username required');if(p!==c)return alert('Passwords do not match');vscode.postMessage({type:'submit',name:n,password:p,host:h});}
function cancel(){vscode.postMessage({type:'cancel'});}`,
      );
    }
    const privChecks = PRIVILEGES.map((p) => `<label class="priv"><input type="checkbox" value="${p}"> ${p}</label>`).join('');
    const db = (this.node.database || '').replace(/"/g, '&quot;');
    return this.shell(`Grant Privilege to ${this.node.label}`, `
      <div class="field"><label>Privileges</label><div class="privs">${privChecks}</div></div>
      <div class="field"><label>Database</label><input id="database" value="${db}"></div>`,
      `const vscode=acquireVsCodeApi();
function submit(){const ps=[...document.querySelectorAll('.privs input:checked')].map(c=>c.value);if(!ps.length)return alert('Select at least one privilege');const priv=ps.join(', ');const d=database.value;vscode.postMessage({type:'submit',priv,database:d});}
function cancel(){vscode.postMessage({type:'cancel'});}`,
    );
  }

  private shell(title: string, body: string, script: string): string {
    const nonce = this.nonce();
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);padding:16px;font-size:13px}
h3{margin:0 0 12px}
.field{margin-bottom:12px}
.field label{display:block;margin-bottom:4px}
input{width:100%;box-sizing:border-box;padding:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px}
.privs{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.priv{display:flex;gap:6px;align-items:center}
.btn{padding:6px 16px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;margin-right:8px}
.btn.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
</style></head><body>
<h3>${title}</h3>
${body}
<button class="btn" onclick="submit()">Submit</button>
<button class="btn sec" onclick="cancel()">Cancel</button>
<script nonce="${nonce}">${script}</script>
</body></html>`;
  }

  private nonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
    return t;
  }
}
