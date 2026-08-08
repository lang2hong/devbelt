import * as vscode from 'vscode';
import { DbTreeNode, NodeKind } from '../tree/dbTreeNode';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm } from './shared';

export function registerSavedQueryCommands(deps: Deps, sub: Sub): void {
  const { store, treeProvider } = deps;

  sub('dbclient.newQuery', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('query.namePrompt') });
    if (!name) return;
    const sql = await vscode.window.showInputBox({ prompt: l10n('query.sqlPrompt') });
    if (sql === undefined) return;
    await store.saveQuery({ name, sql: sql || '', connId: node.conn.id, database: node.database });
    treeProvider.refresh();
  });

  sub('dbclient.openQuery', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const q = store.getQueries(node.conn.id, node.database).find((x) => x.name === node.label);
    if (q) {
      const doc = await vscode.workspace.openTextDocument({ content: q.sql, language: 'sql' });
      await vscode.window.showTextDocument(doc);
    }
  });

  sub('dbclient.editQuery', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const q = store.getQueries(node.conn.id, node.database).find((x) => x.name === node.label);
    if (!q) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('query.namePrompt'), value: q.name });
    if (!name) return;
    const sql = await vscode.window.showInputBox({ prompt: l10n('query.sqlPrompt'), value: q.sql });
    if (sql === undefined) return;
    await store.updateQuery(q.id, { name, sql });
    treeProvider.refresh();
  });

  sub('dbclient.deleteQuery', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const q = store.getQueries(node.conn.id, node.database).find((x) => x.name === node.label);
    if (!q) return;
    if (!(await confirm('query.deleteConfirm', 'query.delete', q.name))) return;
    await store.removeQuery(q.id);
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
    const name = await vscode.window.showInputBox({ prompt: 'Group name', value: node.label });
    if (!name || name === node.label) return;
    await store.renameGroup(node.groupId!, name);
    treeProvider.refresh();
  });

  sub('dbclient.removeGroup', async (node: DbTreeNode) => {
    if (!(await confirm('tree.deleteGroupTitle', 'tree.deleteGroupConfirm', node.label))) return;
    await store.removeGroup(node.groupId!);
    treeProvider.refresh();
  });

  sub('dbclient.moveToGroup', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const data = store.getTreeData();
    const picked = await vscode.window.showQuickPick(
      [{ label: '$(close) ' + l10n('tree.ungroup'), target: undefined as string | undefined },
        ...data.groups.map((g) => ({ label: g.name, target: g.id as string | undefined }))],
      { placeHolder: l10n('tree.moveGroup') },
    );
    if (!picked) return;
    await store.moveToGroup(node.conn.id, picked.target);
    treeProvider.refresh();
  });
}
