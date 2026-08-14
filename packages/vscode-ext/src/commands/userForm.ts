import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { DbTreeNode } from '../tree/dbTreeNode';
import type { Deps } from './shared';
import { requireCapability } from './shared';
import { l10n } from '../i18n';
import { AuditLogger } from '../utils/auditLogger';

const PRIVILEGES = [
  'ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE',
  'CREATE', 'CREATE VIEW', 'SHOW VIEW', 'ALTER', 'DROP', 'INDEX',
  'REFERENCES', 'TRIGGER', 'EXECUTE',
];

export class UserForm extends BaseWebView {
  private constructor(
    private readonly mode: 'create' | 'grant',
    private readonly node: DbTreeNode,
    private readonly deps: Deps,
  ) {
    super(
      'dbclient.userForm',
      `${mode === 'create' ? l10n('user.createTitle') : l10n('user.grantTitle')} @ ${node.conn?.name || ''}`,
    );
  }

  static openCreate(deps: Deps, node: DbTreeNode): void {
    new UserForm('create', node, deps);
  }

  static openGrant(deps: Deps, node: DbTreeNode): void {
    new UserForm('grant', node, deps);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type === 'ready') {
      this.sendInit();
      return;
    }
    if (msg.type === 'cancel') { this.dispose(); return; }
    if (msg.type !== 'submit') return;
    const conn = this.node.conn;
    if (!conn) return;
    try {
      const session = await this.deps.manager.connect(conn);
      if (!requireCapability(session, 'manageUsers')) { this.dispose(); return; }
      if (this.mode === 'create') {
        await session.table.createUser(msg.name, msg.password, msg.host);
        // 只记动作与对象，绝不记密码
        AuditLogger.tryLog({ action: 'user_manage', connName: conn.name || conn.host, sql: `CREATE USER ${msg.name}@${msg.host}` });
        this.deps.treeProvider.refresh();
        vscode.window.showInformationMessage(l10n('user.created', { name: msg.name }));
      } else {
        const parts = this.node.label.split('@');
        const db = msg.database || this.node.database;
        const privs: string[] = Array.isArray(msg.priv) ? msg.priv : [msg.priv];
        for (const priv of privs) {
          await session.table.grantPrivilege(parts[0], priv, db, parts[1] || '%');
        }
        AuditLogger.tryLog({ action: 'user_manage', connName: conn.name || conn.host, database: db, sql: `GRANT ${privs.join(', ')} TO ${this.node.label}` });
        this.deps.treeProvider.refresh();
        vscode.window.showInformationMessage(l10n('user.granted', { priv: privs.join(', '), name: this.node.label }));
      }
      this.dispose();
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  }

  private sendInit(): void {
    this.post({
      type: 'init',
      mode: 'userForm',
      userMode: this.mode,
      nodeLabel: this.node.label,
      database: this.node.database || '',
      privileges: PRIVILEGES,
    });
  }
}
