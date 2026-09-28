import * as vscode from 'vscode';
import { DbTreeNode, NodeKind } from '../tree/dbTreeNode';
import { l10n } from '../i18n';
import { diagInfo } from '../utils/diagnostics';
import { flattenGroups } from '../utils/groupTree';
import type { Deps, Sub } from './shared';
import { confirm, openQueryFile } from './shared';

export function registerSavedQueryCommands(deps: Deps, sub: Sub): void {
  const { store, treeProvider } = deps;

  sub('devbelt.newQuery', async (node: DbTreeNode) => {
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

  sub('devbelt.openQuery', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.queryId) return;
    await openQueryFile(deps, node.conn, node.database, node.queryId);
  });

  sub('devbelt.editQuery', async (node: DbTreeNode) => {
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

  sub('devbelt.deleteQuery', async (node: DbTreeNode) => {
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

  sub('devbelt.newQueryFolder', async (node?: DbTreeNode) => {
    const name = await vscode.window.showInputBox({ prompt: l10n('group.folderNamePrompt') });
    if (!name) return;
    // v2：文件夹跟随连接，需在连接上下文触发；阶段 A 命令口径暂以节点连接为准。
    const connId = node?.conn?.id;
    if (!connId) {
      const conns = store.list().filter((c) => !c.deleted);
      if (conns.length === 0) {
        void vscode.window.showWarningMessage(l10n('group.noConnection'));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        conns.map((c) => ({ label: c.name, value: c.id })),
        { placeHolder: 'Attach folder to connection' },
      );
      if (!picked) return;
      await store.addQueryFolder(name, picked.value);
    } else {
      await store.addQueryFolder(name, connId);
    }
    treeProvider.refresh();
  });

  sub('devbelt.renameQueryFolder', async (node: DbTreeNode) => {
    if (!node?.queryFolderId) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('group.folderNamePrompt'), value: node.label, valueSelection: [0, node.label.length] });
    if (!name || name === node.label) return;
    await store.renameQueryFolder(node.queryFolderId, name);
    treeProvider.refresh();
  });

  sub('devbelt.deleteQueryFolder', async (node: DbTreeNode) => {
    if (!node?.queryFolderId) return;
    if (!(await confirm('query.deleteFolderConfirm', 'query.delete', node.label))) return;
    await store.removeQueryFolder(node.queryFolderId);
    treeProvider.refresh();
  });
}

export function registerGroupCommands(deps: Deps, sub: Sub): void {
  const { store, manager, treeProvider } = deps;

  sub('devbelt.addGroup', async (node?: DbTreeNode) => {
    const name = await vscode.window.showInputBox({ prompt: l10n('tree.addGroup') });
    if (!name) return;
    await store.addGroup(name, node?.kind === NodeKind.Group ? node.groupId : undefined);
    treeProvider.refresh();
  });

  sub('devbelt.renameGroup', async (node: DbTreeNode) => {
    if (!node?.groupId) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('group.groupNamePrompt'), value: node.label, valueSelection: [0, node.label.length] });
    if (!name || name === node.label) return;
    await store.renameGroup(node.groupId, name);
    treeProvider.refresh();
  });

  sub('devbelt.removeGroup', async (node: DbTreeNode) => {
    if (!node?.groupId) return;
    const { groups, connections } = store.getGroupRemovalStats(node.groupId);
    if (connections === 0) {
      // 无连接：只需确认（有子分组时在文案里点明），无「连接去留」可问。
      const message = groups > 0
        ? l10n('tree.deleteGroupWithSubgroups', { name: node.label, groups })
        : l10n('tree.deleteGroupEmpty', { name: node.label });
      const confirmLabel = l10n('tree.deleteGroupConfirm');
      if ((await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel)) !== confirmLabel) return;
      await store.removeGroup(node.groupId);
      diagInfo('group remove', { id: node.groupId, cascadeConnections: 0 });
      treeProvider.refresh();
      return;
    }
    // 有连接：让用户明确决定组内连接的去留，按钮文案即结果（不静默保留或删除）。
    const keep = l10n('tree.deleteGroupKeepConnections');
    const removeAll = l10n('tree.deleteGroupDeleteConnections');
    const picked = await vscode.window.showWarningMessage(
      l10n('tree.deleteGroupNonEmpty', { name: node.label, groups, connections }),
      { modal: true },
      keep,
      removeAll,
    );
    if (picked === keep) {
      await store.removeGroup(node.groupId);
      diagInfo('group remove', { id: node.groupId, cascadeConnections: 0 });
    } else if (picked === removeAll) {
      // 与 deleteConnection 一致：关闭被级联删除连接的运行时会话（连接池/SSH 隧道）。
      const deleted = await store.removeGroupWithConnections(node.groupId);
      diagInfo('group remove', { id: node.groupId, cascadeConnections: deleted.length });
      for (const connId of deleted) manager.disposeConn(connId);
    } else {
      return; // 取消/关闭
    }
    treeProvider.refresh();
  });

  sub('devbelt.moveToGroup', async (node: DbTreeNode) => {
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
    diagInfo('connection move', { id: node.conn.id, toGroup: picked.target ?? null });
    treeProvider.refresh();
  });
}
