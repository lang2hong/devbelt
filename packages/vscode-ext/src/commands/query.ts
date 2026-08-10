import * as vscode from 'vscode';
import { DbTreeNode } from '../tree/dbTreeNode';
import { TableQueryView } from '../result/tableQueryView';
import { formatSql } from '../format/sqlFormatter';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { openQueryFile, openSqlDocEditor, pickConnection } from './shared';

export function registerQueryCommands(deps: Deps, sub: Sub): void {
  const { store, manager, executor, history, connCtx, treeProvider } = deps;

  const runActiveQuery = async (mode: import('../result/queryExecutor').QueryExecutionMode) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage(l10n('cmd.openEditorFirst'));
      return;
    }
    const ctx = connCtx.getForDoc(editor.document.uri.toString());
    const conn = ctx?.conn || await pickConnection(store);
    if (!conn) return;
    if (!ctx) connCtx.setForDoc(editor.document.uri.toString(), conn);
    const sql = editor.selection.isEmpty
      ? editor.document.getText()
      : editor.document.getText(editor.selection);
    await executor.run(conn, sql, ctx?.db, mode);
  };

  sub('dbclient.runStatement', async (sql: string) => {
    if (!sql) return;
    const editor = vscode.window.activeTextEditor;
    const ctx = editor ? connCtx.getForDoc(editor.document.uri.toString()) : undefined;
    const conn = ctx?.conn || await pickConnection(store);
    if (!conn) return;
    await executor.run(conn, sql, ctx?.db);
  });

  sub('dbclient.runQuery', async () => {
    await runActiveQuery('reuse');
  });

  sub('dbclient.runQueryInNewPanel', async () => {
    await runActiveQuery('new');
  });

  sub('dbclient.explainQuery', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const ctx = connCtx.getForDoc(editor.document.uri.toString());
    const conn = ctx?.conn || await pickConnection(store);
    if (!conn) return;
    const sql = editor.selection.isEmpty
      ? editor.document.getText()
      : editor.document.getText(editor.selection);
    await executor.explain(conn, sql, ctx?.db);
  });

  sub('dbclient.runSqlFile', async (uri: vscode.Uri) => {
    if (!uri) return;
    const conn = await pickConnection(store);
    if (!conn) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    connCtx.setForDoc(doc.uri.toString(), conn);
    await executor.run(conn, doc.getText());
  });

  sub('dbclient.previewTable', (node: DbTreeNode) => {
    if (node?.conn && node?.database) {
      connCtx.setLast(node.conn, node.database);
      TableQueryView.open(node.conn, node.label, node.database, manager);
    }
  });

  sub('dbclient.previewView', (node: DbTreeNode) => {
    if (node?.conn && node?.database) {
      connCtx.setLast(node.conn, node.database);
      TableQueryView.open(node.conn, node.label, node.database, manager);
    }
  });

  sub('dbclient.formatSql', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const range = editor.selection.isEmpty
      ? new vscode.Range(0, 0, editor.document.lineCount - 1, 0)
      : editor.selection;
    await editor.edit((edit) => edit.replace(range, formatSql(editor.document.getText(range))));
  });

  sub('dbclient.showHistory', async () => {
    const list = history.list();
    if (!list.length) {
      vscode.window.showInformationMessage(l10n('cmd.noHistory'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      list.map((h) => ({
        label: h.sql.replace(/\s+/g, ' ').slice(0, 60),
        detail: `${h.connection} · ${h.rowCount ?? 0} rows · ${h.costTime}ms`,
        value: h,
      })),
      { placeHolder: 'Query history' },
    );
    if (picked) {
      const doc = await openSqlDocEditor(picked.value.sql);
      if (doc && picked.value.connectionId) {
        const conn = store.get(picked.value.connectionId);
        if (conn) connCtx.setForDoc(doc.document.uri.toString(), conn, picked.value.database);
      }
    }
  });

  sub('dbclient.updateCell', async (args: {
    conn: import('../connection/connectionStore').SavedConnection;
    table: string; primaryKey: string; rowId: any; column: string; value: any;
  }) => {
    try {
      const session = await manager.connect(args.conn);
      await session.data.updateCell(args.table, args.primaryKey, args.rowId, args.column, args.value);
      vscode.window.showInformationMessage(l10n('cmd.updated', { table: args.table, column: args.column }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  sub('dbclient.newQueryFromConn', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('query.namePrompt') });
    if (!name) return;
    connCtx.setLast(node.conn, node.database);
    const queryId = await store.saveQuery({ name, sql: '', connId: node.conn.id, database: node.database });
    treeProvider.refresh();
    await openQueryFile(deps, node.conn, node.database, queryId);
  });
}
