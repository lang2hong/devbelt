import * as vscode from 'vscode';
import { DbTreeNode } from '../tree/dbTreeNode';
import { TableQueryView } from '../result/tableQueryView';
import { formatSql } from '../format/sqlFormatter';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { openQueryFile, openSqlDocEditor, pickConnection } from './shared';
import { confirmSqlExecution, ensureWritable } from '../utils/sqlSafety';
import { statementTextAt } from '../utils/sql';
import { dialectScanOptions } from '../utils/sqlDialectOptions';
import { SlowQueryPanel } from '../insights/slowQueryPanel';
import { ExplainPanel } from '../explain/explainPanel';
import { clampHistoryLimit } from '../history/historyStore';

export function registerQueryCommands(deps: Deps, sub: Sub): void {
  const { store, manager, executor, history, connCtx, treeProvider } = deps;

  const runActiveQuery = async (mode: import('../result/queryExecutor').QueryExecutionMode, scope: 'statement' | 'all' = 'statement') => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage(l10n('cmd.openEditorFirst'));
      return;
    }
    const ctx = connCtx.getForDoc(editor.document.uri.toString());
    const conn = ctx?.conn || await pickConnection(store);
    if (!conn) return;
    if (!ctx) connCtx.setForDoc(editor.document.uri.toString(), conn);
    // 有选区 → 执行选区；否则默认执行光标所在语句（Ctrl+Enter 的直觉语义）。
    // 「执行整篇」是独立命令 runAllQueries。光标不在任何语句内（空行/分号后）时
    // 绝不能回退到整篇文档：用户停在空行上会意外执行整个脚本（含破坏性语句）。
    const sql = !editor.selection.isEmpty
      ? editor.document.getText(editor.selection)
      : scope === 'all'
        ? editor.document.getText()
        : statementTextAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active), dialectScanOptions(ctx?.conn.dbType));
    if (!sql || !sql.trim()) {
      vscode.window.showInformationMessage(l10n('cmd.placeCursorInStatement'));
      return;
    }
    await executor.run(conn, sql, ctx?.db, mode);
  };

  sub('devbelt.runStatement', async (sql: string) => {
    if (!sql) return;
    const editor = vscode.window.activeTextEditor;
    const ctx = editor ? connCtx.getForDoc(editor.document.uri.toString()) : undefined;
    const conn = ctx?.conn || await pickConnection(store);
    if (!conn) return;
    await executor.run(conn, sql, ctx?.db);
  });

  sub('devbelt.runQuery', async () => {
    await runActiveQuery('reuse');
  });

  sub('devbelt.runQueryInNewPanel', async () => {
    await runActiveQuery('new');
  });

  sub('devbelt.runAllQueries', async () => {
    await runActiveQuery('reuse', 'all');
  });

  sub('devbelt.explainQuery', async () => {
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

  sub('devbelt.runSqlFile', async (uri: vscode.Uri) => {
    if (!uri) return;
    const conn = await pickConnection(store);
    if (!conn) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    connCtx.setForDoc(doc.uri.toString(), conn);
    await executor.run(conn, doc.getText());
  });

  sub('devbelt.previewTable', (node: DbTreeNode) => {
    if (node?.conn && node?.database) {
      connCtx.setLast(node.conn, node.database);
      TableQueryView.open(node.conn, node.label, node.database, manager, { objectType: 'table', schema: node.schema });
    }
  });

  sub('devbelt.refreshNode', (node: DbTreeNode) => {
    if (node) treeProvider.refreshNode(node);
  });

  sub('devbelt.previewView', (node: DbTreeNode) => {
    if (node?.conn && node?.database) {
      connCtx.setLast(node.conn, node.database);
      // 视图只读：objectType 'view' 会关闭单元格编辑、插入行与复制 INSERT
      TableQueryView.open(node.conn, node.label, node.database, manager, { objectType: 'view', schema: node.schema });
    }
  });

  sub('devbelt.formatSql', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const ctx = connCtx.getForDoc(editor.document.uri.toString());
    // 整篇格式化：结束点取最后一行的真实行尾，`(lineCount-1, 0)` 会漏掉最后一行。
    const range = editor.selection.isEmpty
      ? new vscode.Range(editor.document.positionAt(0), editor.document.lineAt(editor.document.lineCount - 1).range.end)
      : editor.selection;
    await editor.edit((edit) => edit.replace(range, formatSql(editor.document.getText(range), ctx?.conn.dbType)));
  });

  sub('devbelt.slowQueries', () => {
    SlowQueryPanel.open({
      history,
      connections: () => store.list(),
      historyLimit: () => clampHistoryLimit(vscode.workspace.getConfiguration().get<number>('devbelt.insights.historyLimit')),
      openSql: async (sql, conn, database) => {
        const editor = await openSqlDocEditor(sql);
        if (editor && conn) connCtx.setForDoc(editor.document.uri.toString(), conn, database);
      },
      explain: (sql, conn, database) => ExplainPanel.open(manager, conn, sql, database),
    });
  });

  sub('devbelt.showHistory', async () => {
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
      { placeHolder: l10n('query.historyPlaceholder'), matchOnDetail: true },
    );
    if (picked) {
      const doc = await openSqlDocEditor(picked.value.sql);
      if (doc && picked.value.connectionId) {
        const conn = store.get(picked.value.connectionId);
        if (conn) connCtx.setForDoc(doc.document.uri.toString(), conn, picked.value.database);
      }
    }
  });

  /**
   * 单元格更新的命令入口。
   *
   * 这是个**已注册命令**，不只有结果面板会用：任何 `executeCommand('devbelt.updateCell', ...)`
   * 的调用方（其他扩展、webview 消息、按键绑定）都能直接触发，且连接对象由调用方
   * 整个传进来。所以只读拦截与危险语句确认必须在这里做 —— 不能依赖
   * RowEditor.updateCell 那条路径上的守卫，那条路径可以被绕开。
   *
   * 守卫顺序与 RowEditor 一致：先确认，再连接。反过来的话，即使用户点了取消，
   * 连接也已经建立了。
   */
  sub('devbelt.updateCell', async (args: {
    conn: import('@devbelt/db-host/connection/connectionStore').SavedConnection;
    table: string; pkColumns: string[]; pkValues: any[]; column: string; value: any; schema?: string; database?: string;
  }) => {
    try {
      if (!args?.conn || !args.table || !args.pkColumns?.length) return;
      if (!ensureWritable(args.conn)) return;
      const preview = `UPDATE ${args.table} SET ${args.column} = ? WHERE ${args.pkColumns.join(', ')} = ?`;
      if (!(await confirmSqlExecution(args.conn, preview, manager.scanOptionsFor?.(args.conn), { database: args.database, schema: args.schema }))) return;
      const session = await manager.connectSql(args.conn, args.database);
      await session.data.updateCell(args.table, args.pkColumns, args.pkValues, args.column, args.value, undefined, args.schema);
      vscode.window.showInformationMessage(l10n('cmd.updated', { table: args.table, column: args.column }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  sub('devbelt.newQueryFromConn', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('query.namePrompt') });
    if (!name) return;
    connCtx.setLast(node.conn, node.database);
    const queryId = await store.saveQuery({ name, sql: '', connId: node.conn.id, database: node.database });
    treeProvider.refresh();
    await openQueryFile(deps, node.conn, node.database, queryId);
  });

  sub('devbelt.newQueryForDb', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    connCtx.setLast(node.conn, node.database);
    const editor = await openSqlDocEditor('');
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });
}
