import * as vscode from 'vscode';
import { DbTreeNode } from '../tree/dbTreeNode';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm, requireCapability } from './shared';
import { UserForm } from './userForm';
import { AuditLogger } from '../utils/auditLogger';

export function registerUserCommands(deps: Deps, sub: Sub): void {
  const { manager, treeProvider } = deps;

  sub('dbclient.createUser', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    UserForm.openCreate(deps, node);
  });

  sub('dbclient.dropUser', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (!(await confirm('user.dropConfirm', 'user.drop', node.label))) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'manageUsers')) return;
    const parts = node.label.split('@');
    await session.table.dropUser(parts[0], parts[1] || '%');
    AuditLogger.tryLog({ action: 'user_manage', connName: node.conn.name || node.conn.host, sql: `DROP USER ${node.label}` });
    treeProvider.refresh();
  });

  sub('dbclient.changePassword', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const password = await vscode.window.showInputBox({ prompt: l10n('user.passwordPrompt'), password: true });
    if (!password) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'manageUsers')) return;
    const parts = node.label.split('@');
    await session.table.alterUserPassword(parts[0], password, parts[1] || '%');
    // 只记动作与对象，绝不记密码
    AuditLogger.tryLog({ action: 'user_manage', connName: node.conn.name || node.conn.host, sql: `ALTER USER ${node.label} (password changed)` });
    vscode.window.showInformationMessage(l10n('user.passwordChanged', { name: node.label }));
  });

  sub('dbclient.grantPrivilege', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    UserForm.openGrant(deps, node);
  });

  sub('dbclient.revokePrivilege', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const priv = await vscode.window.showInputBox({ prompt: l10n('user.privPrompt'), value: 'ALL PRIVILEGES' });
    if (!priv) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'manageUsers')) return;
    const parts = node.label.split('@');
    await session.table.revokePrivilege(parts[0], priv, node.database, parts[1] || '%');
    AuditLogger.tryLog({ action: 'user_manage', connName: node.conn.name || node.conn.host, database: node.database, sql: `REVOKE ${priv} FROM ${node.label}` });
    vscode.window.showInformationMessage(l10n('user.revoked', { priv, name: node.label }));
  });
}
