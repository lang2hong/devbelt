import * as vscode from 'vscode';
import { DbTreeNode } from '../tree/dbTreeNode';
import { confirmSqlExecution, ensureWritable } from '../utils/sqlSafety';
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

  /**
   * 只刷新对象所在的分类节点。
   *
   * 整树刷新会把所有连接/库/表折叠回去，用户还得一路点回来才能看到结果，
   * 「操作完好像什么都没发生」多半是这个原因。
   */
  const refreshParent = (node: DbTreeNode): void => {
    if (node.parent) treeProvider.refreshNode(node.parent);
    else treeProvider.refresh();
  };

  // 新建索引（从 index 分类节点触发，父为表）
  sub('dbclient.addIndex', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn || !ctx.table) return;
    const session = await manager.connect(ctx.conn);
    if (!requireCapability(session, 'manageIndexes') || !ensureWritable(ctx.conn)) return;
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
    try {
      await session.table.createIndex(name, ctx.table, columns, ctx.database, unique);
      // 从 index 分类节点触发时，node 就是分类节点本身
      treeProvider.refreshNode(node);
      vscode.window.showInformationMessage(l10n('ddl.indexCreated', { name }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  /**
   * 修改索引：改名 / 改列 / 改唯一性。
   *
   * 索引没有 ALTER 语法，只能先删再建；主键走 `DROP PRIMARY KEY, ADD PRIMARY KEY`
   * 的单语句形式，避免中间态没有主键。
   */
  sub('dbclient.modifyIndex', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn || !ctx.table) return;
    const session = await manager.connect(ctx.conn);
    if (!requireCapability(session, 'manageIndexes') || !ensureWritable(ctx.conn)) return;
    const indexes = await session.metadata.getIndexes(ctx.table, ctx.database);
    const current = indexes.find((i: any) => i.name === node.label);
    const cols = await session.metadata.getColumns(ctx.table, ctx.database);
    if (!cols.length) { vscode.window.showWarningMessage(l10n('ddl.noColumns')); return; }

    const picked = await vscode.window.showQuickPick(
      cols.map((c: any) => ({
        label: c.name,
        description: c.simpleType || c.type,
        picked: (current?.columns || []).includes(c.name),
      })),
      { canPickMany: true, placeHolder: l10n('ddl.selectColumns') },
    );
    if (!picked?.length) return;
    const columns = picked.map((p) => p.label);
    const isPrimary = node.label.toUpperCase() === 'PRIMARY';

    let name = node.label;
    let unique = !!current?.isUnique;
    if (!isPrimary) {
      const input = await vscode.window.showInputBox({ prompt: l10n('ddl.indexName'), value: node.label });
      if (!input?.trim()) return;
      name = input.trim();
      const uniquePick = await vscode.window.showQuickPick(
        [
          { label: 'No', value: false, picked: !unique },
          { label: 'Yes', value: true, picked: unique },
        ],
        { placeHolder: l10n('ddl.uniqueIndex') },
      );
      if (!uniquePick) return;
      unique = uniquePick.value;
    }

    try {
      if (isPrimary) {
        await session.table.recreatePrimaryKey(ctx.table, columns, ctx.database);
      } else {
        await session.table.dropIndex(node.label, ctx.table, ctx.database);
        await session.table.createIndex(name, ctx.table, columns, ctx.database, unique);
      }
      refreshParent(node);
      vscode.window.showInformationMessage(l10n('ddl.indexUpdated', { name }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  // 删除索引
  sub('dbclient.dropIndex', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn || !ctx.table) return;
    if (!(await confirm('ddl.dropIndexConfirm', 'common.delete', node.label))) return;
    const session = await manager.connect(ctx.conn);
    if (!requireCapability(session, 'manageIndexes') || !ensureWritable(ctx.conn)) return;
    try {
      await session.table.dropIndex(node.label, ctx.table, ctx.database);
      refreshParent(node);
      vscode.window.showInformationMessage(l10n('ddl.indexDropped', { name: node.label }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
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
    if (!(await confirm('ddl.dropTriggerConfirm', 'common.delete', node.label))) return;
    const session = await manager.connect(ctx.conn);
    const sql = session.metadata.dropTriggerSql(node.label, ctx.table, ctx.database);
    if (!(await confirmSqlExecution(ctx.conn, sql))) return;
    await session.query.query(sql);
    refreshParent(node);
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

  /**
   * 新增外键。
   *
   * 关联表用 QuickPick 从库里现有表中选（可输入过滤），而不是让用户手打表名 ——
   * 打错一个字母只会换来一句「表不存在」。
   * 建完刷新外键分类节点并给出结果提示：过去成功与失败都毫无反馈，
   * 加上整树刷新会折叠所有节点，看起来就是「操作完没有创建外键」。
   */
  sub('dbclient.addForeignKey', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn || !ctx.table) return;
    const session = await manager.connect(ctx.conn);
    if (!requireCapability(session, 'alterTable') || !ensureWritable(ctx.conn)) return;
    const cols = await session.metadata.getColumns(ctx.table, ctx.database);
    if (!cols.length) { vscode.window.showWarningMessage(l10n('ddl.noColumns')); return; }
    const picked = await vscode.window.showQuickPick(
      cols.map((c: any) => ({ label: c.name, description: c.simpleType || c.type })),
      { canPickMany: true, placeHolder: l10n('ddl.fkSelectColumns') },
    );
    if (!picked || picked.length === 0) return;
    const columns = picked.map((p) => p.label);

    const tables = await session.metadata.getTables(ctx.database);
    if (!tables.length) { vscode.window.showWarningMessage(l10n('ddl.fkNoTables')); return; }
    const refPick = await vscode.window.showQuickPick(
      tables.map((t: any) => ({ label: t.name, description: t.comment || undefined })),
      { placeHolder: l10n('ddl.fkRefTablePrompt'), matchOnDescription: true },
    );
    if (!refPick) return;
    const refTable = refPick.label;

    const refCols = await session.metadata.getColumns(refTable, ctx.database);
    if (!refCols.length) { vscode.window.showErrorMessage(l10n('ddl.fkRefTableNotFound', { table: refTable })); return; }
    const refPicked = await vscode.window.showQuickPick(
      refCols.map((c: any) => ({
        label: c.name,
        description: c.simpleType || c.type,
        // 外键通常指向主键，默认勾上省一步
        picked: !!c.isPrimary,
      })),
      { canPickMany: true, placeHolder: l10n('ddl.fkSelectRefColumns') },
    );
    if (!refPicked || refPicked.length === 0) return;
    const refColumns = refPicked.map((p) => p.label);
    if (refColumns.length !== columns.length) {
      vscode.window.showErrorMessage(l10n('ddl.fkColumnCountMismatch'));
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: l10n('ddl.fkNamePrompt'),
      value: `fk_${ctx.table}_${columns.join('_')}`,
    });
    if (!name) return;
    try {
      await session.table.addForeignKey(ctx.table, name, columns, refTable, refColumns, ctx.database);
      treeProvider.refreshNode(node);
      vscode.window.showInformationMessage(l10n('ddl.fkCreated', { name }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  // 删除外键
  sub('dbclient.dropForeignKey', async (node: DbTreeNode) => {
    const ctx = DbTreeNode.tableContext(node);
    if (!ctx?.conn || !ctx.table) return;
    if (!node.constraintName) { vscode.window.showErrorMessage(l10n('ddl.fkNoConstraintName')); return; }
    if (!ensureWritable(ctx.conn)) return;
    if (!(await confirm('ddl.dropFkConfirm', 'common.delete', node.label))) return;
    const session = await manager.connect(ctx.conn);
    try {
      await session.table.dropForeignKey(node.constraintName, ctx.table, ctx.database);
      refreshParent(node);
      vscode.window.showInformationMessage(l10n('ddl.fkDropped', { name: node.constraintName }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });
}
