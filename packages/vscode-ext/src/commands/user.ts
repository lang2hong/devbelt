import * as vscode from 'vscode';
import { DbTreeNode } from '../tree/dbTreeNode';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm } from './shared';

export function registerUserCommands(deps: Deps, sub: Sub): void {
  const { manager, treeProvider } = deps;

  sub('dbclient.createUser', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('user.namePrompt') });
    if (!name) return;
    const password = await vscode.window.showInputBox({ prompt: l10n('user.passwordPrompt'), password: true });
    if (password === undefined) return;
    const host = await vscode.window.showInputBox({ prompt: l10n('user.hostPrompt'), value: '%' }) || '%';
    const session = await manager.connect(node.conn);
    await session.table.createUser(name, password, host);
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('user.created', { name }));
  });

  sub('dbclient.dropUser', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (!(await confirm('user.dropConfirm', 'user.drop', node.label))) return;
    const session = await manager.connect(node.conn);
    const parts = node.label.split('@');
    await session.table.dropUser(parts[0], parts[1] || '%');
    treeProvider.refresh();
  });

  sub('dbclient.changePassword', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const password = await vscode.window.showInputBox({ prompt: l10n('user.passwordPrompt'), password: true });
    if (!password) return;
    const session = await manager.connect(node.conn);
    const parts = node.label.split('@');
    await session.table.alterUserPassword(parts[0], password, parts[1] || '%');
    vscode.window.showInformationMessage(l10n('user.passwordChanged', { name: node.label }));
  });

  sub('dbclient.grantPrivilege', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const priv = await vscode.window.showInputBox({ prompt: l10n('user.privPrompt'), value: 'ALL PRIVILEGES' });
    if (!priv) return;
    const session = await manager.connect(node.conn);
    const parts = node.label.split('@');
    await session.table.grantPrivilege(parts[0], priv, node.database, parts[1] || '%');
    vscode.window.showInformationMessage(l10n('user.granted', { priv, name: node.label }));
  });

  sub('dbclient.revokePrivilege', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const priv = await vscode.window.showInputBox({ prompt: l10n('user.privPrompt'), value: 'ALL PRIVILEGES' });
    if (!priv) return;
    const session = await manager.connect(node.conn);
    const parts = node.label.split('@');
    await session.table.revokePrivilege(parts[0], priv, node.database, parts[1] || '%');
    vscode.window.showInformationMessage(l10n('user.revoked', { priv, name: node.label }));
  });
}
