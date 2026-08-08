import * as vscode from 'vscode';
import { DbTreeNode, NodeKind } from '../tree/dbTreeNode';
import { ConnectionForm } from '../connection/connectionForm';
import type { SavedConnection } from '../connection/connectionStore';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm } from './shared';

export function registerConnectionCommands(deps: Deps, sub: Sub): void {
  const { store, manager, treeProvider, connCtx } = deps;

  sub('dbclient.addConnection', (node?: DbTreeNode) => {
    const gid = node?.kind === NodeKind.Group ? node.groupId : undefined;
    ConnectionForm.open(store, () => treeProvider.refresh(), gid);
  });

  sub('dbclient.editConnection', (node: DbTreeNode) => {
    if (node?.conn) ConnectionForm.open(store, () => treeProvider.refresh(), undefined, node.conn);
  });

  sub('dbclient.deleteConnection', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (!(await confirm('conn.deleteConfirm', 'table.delete', node.conn.name || node.conn.host))) return;
    await store.remove(node.conn.id);
    manager.disposeConn(node.conn.id);
    treeProvider.refresh();
  });

  sub('dbclient.openConnection', (conn: SavedConnection) => {
    if (!conn?.id) return;
    treeProvider.markOpen(conn.id);
    connCtx.setLast(conn);
    treeProvider.refresh();
  });

  sub('dbclient.closeConnection', (node: DbTreeNode) => {
    if (!node?.conn) return;
    manager.disposeConn(node.conn.id);
    treeProvider.markClosed(node.conn.id);
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('conn.closed', { name: node.conn.name || node.conn.host }));
  });

  sub('dbclient.refreshConnection', (node: DbTreeNode) => {
    if (node?.conn) manager.disposeConn(node.conn.id);
    treeProvider.refresh();
  });

  sub('dbclient.refresh', () => treeProvider.refresh());
}
