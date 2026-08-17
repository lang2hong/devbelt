import * as vscode from 'vscode';
import { DbTreeNode, NodeKind } from '../tree/dbTreeNode';
import { l10n } from '../i18n';
import { flattenGroups } from '../utils/groupTree';
import type { Deps, Sub } from './shared';
import { confirm, openQueryFile } from './shared';

export function registerSavedQueryCommands(deps: Deps, sub: Sub): void {
  const { store, treeProvider } = deps;

  sub('dbclient.newQuery', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('query.namePrompt') });
    if (!name) return;
    const id = await store.saveQuery({
      name, sql: '', connId: node.conn.id, database: node.database,
      folderId: node.kind === NodeKind.QueryFolder ? node.queryFolderId : undefined,
    });
    treeProvider.refresh();
    await openQueryFile(deps, node.conn, node.database, id);
  });

  sub('dbclient.openQuery', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.queryId) return;
    await openQueryFile(deps, node.conn, node.database, node.queryId);
  });

  sub('dbclient.editQuery', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.queryId) return;
    const q = store.getQueries(node.conn.id, node.database).find((x) => x.id === node.queryId);
    if (!q) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('query.namePrompt'), value: q.name });
    if (!name) return;
    const sql = await vscode.window.showInputBox({ prompt: l10n('query.sqlPrompt'), value: q.sql });
    if (sql === undefined) return;
    await store.updateQuery(q.id, { name, sql });
    treeProvider.refresh();
  });

  sub('dbclient.deleteQuery', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.queryId) return;
    const q = store.getQueries(node.conn.id, node.database).find((x) => x.id === node.queryId);
    if (!q) return;
    if (!(await confirm('query.deleteConfirm', 'query.delete', q.name))) return;
    await store.removeQuery(q.id);
    treeProvider.refresh();
  });
}

export function registerQueryFolderCommands(deps: Deps, sub: Sub): void {
  const { store, treeProvider } = deps;

  sub('dbclient.newQueryFolder', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'Query folder name' });
    if (!name) return;
    await store.addQueryFolder(name);
    treeProvider.refresh();
  });

  sub('dbclient.renameQueryFolder', async (node: DbTreeNode) => {
    if (!node?.queryFolderId) return;
    const name = await vscode.window.showInputBox({ prompt: 'Query folder name', value: node.label, valueSelection: [0, node.label.length] });
    if (!name || name === node.label) return;
    await store.renameQueryFolder(node.queryFolderId, name);
    treeProvider.refresh();
  });

  sub('dbclient.deleteQueryFolder', async (node: DbTreeNode) => {
    if (!node?.queryFolderId) return;
    if (!(await confirm('query.deleteFolderConfirm', 'query.delete', node.label))) return;
    await store.removeQueryFolder(node.queryFolderId);
    treeProvider.refresh();
  });
}

export function registerGroupCommands(deps: Deps, sub: Sub): void {
  const { store, treeProvider } = deps;

  sub('dbclient.addGroup', async (node?: DbTreeNode) => {
    const name = await vscode.window.showInputBox({ prompt: l10n('tree.addGroup') });
    if (!name) return;
    await store.addGroup(name, node?.kind === NodeKind.Group ? node.groupId : undefined);
    treeProvider.refresh();
  });

  sub('dbclient.renameGroup', async (node: DbTreeNode) => {
    if (!node?.groupId) return;
    const name = await vscode.window.showInputBox({ prompt: 'Group name', value: node.label, valueSelection: [0, node.label.length] });
    if (!name || name === node.label) return;
    await store.renameGroup(node.groupId, name);
    treeProvider.refresh();
  });

  sub('dbclient.removeGroup', async (node: DbTreeNode) => {
    if (!node?.groupId) return;
    if (!(await confirm('tree.deleteGroupTitle', 'tree.deleteGroupConfirm', node.label))) return;
    await store.removeGroup(node.groupId);
    treeProvider.refresh();
  });

  sub('dbclient.moveToGroup', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const items: { label: string; target: string | undefined }[] = [
      { label: '$(close) ' + l10n('tree.ungroup'), target: undefined },
      ...flattenGroups(store.getGroups()).map(({ group, path }) => ({
        label: path,
        target: group.id,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: l10n('tree.moveGroup') });
    if (!picked) return;
    await store.moveToGroup(node.conn.id, picked.target);
    treeProvider.refresh();
  });
}
