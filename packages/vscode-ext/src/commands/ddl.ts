import * as vscode from 'vscode';
import { DbTreeNode } from '../tree/dbTreeNode';
import { confirmSqlExecution } from '../utils/sqlSafety';
import { wrapIdentForConn } from '../utils/sql';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm, openSqlDoc, openSqlDocEditor, requireCapability } from './shared';

/**
 * 索引 / 触发器 DDL 命令。
 * 建索引用 QuickPick（列多选 + 唯一开关）；触发器新建用 SQL 编辑器模板；
 * 删除前经 confirmSqlExecution（只读连接拦截 + 生产环境二次确认）。
 */
export function registerDdlCommands(deps: Deps, sub: Sub): void {
  const { manager, treeProvider, connCtx } = deps;

  // 新建索引（从 index 分类节点触发，父为表）
  sub('dbclient.addIndex', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn || !ctx.table) return;
    const session = await manager.connect(ctx.conn);
    if (!requireCapability(session, 'manageIndexes')) return;
    const cols = await session.metadata.getColumns(ctx.table, ctx.database);
    if (!cols.length) { vscode.window.showWarningMessage(l10n('ddl.noColumns')); return; }
    const picked = await vscode.window.showQuickPick(
      cols.map((c: any) => ({ label: c.name, description: c.simpleType || c.type, picked: c.isPrimary })),
      { canPickMany: true, placeHolder: l10n('ddl.selectColumns') },
    );
    if (!picked || picked.length === 0) return;
    const columns = picked.map((p) => p.label);
    const name = await vscode.window.showInputBox({
      prompt: l10n('ddl.indexName'),
      value: `idx_${ctx.table}_${columns.join('_')}`,
    });
    if (!name) return;
    const uniquePick = await vscode.window.showQuickPick(
      [{ label: 'No' }, { label: 'Yes' }],
      { placeHolder: l10n('ddl.uniqueIndex') },
    );
    const unique = uniquePick?.label === 'Yes';
    const sql = session.metadata.createIndexSql(name, ctx.table, columns, unique, ctx.database);
    if (!(await confirmSqlExecution(ctx.conn, sql))) return;
    await session.query.query(sql);
    treeProvider.refresh();
  });

  // 删除索引
  sub('dbclient.dropIndex', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn || !ctx.table) return;
    if (!(await confirm('ddl.dropIndexConfirm', 'common.ok', node.label))) return;
    const session = await manager.connect(ctx.conn);
    const sql = session.metadata.dropIndexSql(node.label, ctx.table, ctx.database);
    if (!(await confirmSqlExecution(ctx.conn, sql))) return;
    await session.query.query(sql);
    treeProvider.refresh();
  });

  // 查看触发器定义
  sub('dbclient.viewTrigger', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn) return;
    const session = await manager.connect(ctx.conn);
    const def = await session.metadata.getTriggerDefinition(node.label, ctx.database);
    await openSqlDoc(def || '-- No trigger definition found');
  });

  // 删除触发器
  sub('dbclient.dropTrigger', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn || !ctx.table) return;
    if (!(await confirm('ddl.dropTriggerConfirm', 'common.ok', node.label))) return;
    const session = await manager.connect(ctx.conn);
    const sql = session.metadata.dropTriggerSql(node.label, ctx.table, ctx.database);
    if (!(await confirmSqlExecution(ctx.conn, sql))) return;
    await session.query.query(sql);
    treeProvider.refresh();
  });

  // 新建触发器（SQL 编辑器模板，可运行）
  sub('dbclient.addTrigger', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn || !ctx.table) return;
    const useDb = ctx.database ? `USE ${wrapIdentForConn(ctx.conn, ctx.database)};\n\n` : '';
    const tpl = useDb + `CREATE TRIGGER trg_${ctx.table}\n  BEFORE INSERT ON ${wrapIdentForConn(ctx.conn, ctx.table)}\n  FOR EACH ROW\nBEGIN\n  -- trigger body\nEND;`;
    const editor = await openSqlDocEditor(tpl);
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), ctx.conn, ctx.database);
  });

  // 修改触发器（打开定义到 SQL 编辑器，可改可运行）
  sub('dbclient.modifyTrigger', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn) return;
    const session = await manager.connect(ctx.conn);
    const def = await session.metadata.getTriggerDefinition(node.label, ctx.database);
    const useDb = ctx.database ? `USE ${wrapIdentForConn(ctx.conn, ctx.database)};\n\n` : '';
    const editor = await openSqlDocEditor(useDb + (def || '-- No definition found'));
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), ctx.conn, ctx.database);
  });

  // 新增外键
  sub('dbclient.addForeignKey', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn || !ctx.table) return;
    const session = await manager.connect(ctx.conn);
    if (!requireCapability(session, 'alterTable')) return;
    const cols = await session.metadata.getColumns(ctx.table, ctx.database);
    if (!cols.length) { vscode.window.showWarningMessage(l10n('ddl.noColumns')); return; }
    const picked = await vscode.window.showQuickPick(
      cols.map((c: any) => ({ label: c.name, description: c.simpleType || c.type })),
      { canPickMany: true, placeHolder: l10n('ddl.fkSelectColumns') },
    );
    if (!picked || picked.length === 0) return;
    const columns = picked.map((p) => p.label);
    const refTable = await vscode.window.showInputBox({ prompt: l10n('ddl.fkRefTablePrompt') });
    if (!refTable) return;
    const refCols = await session.metadata.getColumns(refTable, ctx.database);
    if (!refCols.length) { vscode.window.showErrorMessage(l10n('ddl.fkRefTableNotFound', { table: refTable })); return; }
    const refPicked = await vscode.window.showQuickPick(
      refCols.map((c: any) => ({ label: c.name, description: c.simpleType || c.type })),
      { canPickMany: true, placeHolder: l10n('ddl.fkSelectRefColumns') },
    );
    if (!refPicked || refPicked.length === 0) return;
    const refColumns = refPicked.map((p) => p.label);
    const name = await vscode.window.showInputBox({
      prompt: l10n('ddl.fkNamePrompt'),
      value: `fk_${ctx.table}_${columns.join('_')}`,
    });
    if (!name) return;
    const sql = session.metadata.createForeignKeySql(name, ctx.table, columns, refTable, refColumns, ctx.database);
    if (!(await confirmSqlExecution(ctx.conn, sql))) return;
    await session.query.query(sql);
    treeProvider.refresh();
  });

  // 删除外键
  sub('dbclient.dropForeignKey', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn || !ctx.table) return;
    if (!node.constraintName) { vscode.window.showErrorMessage(l10n('ddl.fkNoConstraintName')); return; }
    if (!(await confirm('ddl.dropFkConfirm', 'common.ok', node.label))) return;
    const session = await manager.connect(ctx.conn);
    const sql = session.metadata.dropForeignKeySql(node.constraintName, ctx.table, ctx.database);
    if (!(await confirmSqlExecution(ctx.conn, sql))) return;
    await session.query.query(sql);
    treeProvider.refresh();
  });
}
