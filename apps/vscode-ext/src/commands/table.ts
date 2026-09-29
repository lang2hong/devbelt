import * as vscode from 'vscode';
import { DialectRegistry, type DatabaseType } from '@devbelt/db-core';
import { DbTreeNode, NodeKind } from '../tree/dbTreeNode';
import { wrapIdentForConn, qualifiedIdentForConn } from '../utils/sql';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm, openSqlDoc, openSqlDocEditor, recordBulkHistory, requireCapability } from './shared';
import { ensureWritable } from '../utils/sqlSafety';
import { TableQueryView } from '../result/tableQueryView';
import { TableDesignView } from '../result/tableDesignView';

export function registerTableCommands(deps: Deps, sub: Sub): void {
  const { manager, treeProvider, executor, connCtx } = deps;

  // ── 外键跳转 ──
  sub('devbelt.jumpToRefTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node.refTable) return;
    // 外键指向的表可能位于另一个 schema：用节点携带的 refSchema 打开，绝不回退 conn.database。
    TableQueryView.open(node.conn, node.refTable, node.database ?? node.conn.database ?? '', manager, {
      objectType: 'table',
      schema: node.refSchema,
    });
  });

  // ── 表 ──
  sub('devbelt.newTable', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    connCtx.setLast(node.conn, node.database);
    // 模板由方言给出：自增主键的写法三家不同，过去统一发 MySQL 语法，
    // PG/SQLite 用户拿到的模板直接执行会报错。
    const dialect = DialectRegistry.get(node.conn.dbType as DatabaseType);
    const table = qualifiedIdentForConn(node.conn, 'new_table', node.schema);
    const body = dialect
      ? dialect.createTableTemplate(table)
      : `CREATE TABLE IF NOT EXISTS ${table} (\n  id INT PRIMARY KEY,\n  name VARCHAR(255)\n);`;
    // MySQL 才有 USE 语句；PG 用 schema、SQLite 单库，加了会报语法错
    const useDb = node.database && node.conn.dbType === 'MYSQL'
      ? `USE ${wrapIdentForConn(node.conn, node.database)};\n`
      : '';
    const editor = await openSqlDocEditor(useDb + body);
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  sub('devbelt.dropTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!ensureWritable(node.conn)) return;
    if (!(await confirm('table.dropConfirm', 'table.delete', node.label))) return;
    const session = await manager.connectSql(node.conn, node.database);
    await session.table.dropTable(node.label, node.database, node.schema);
    treeProvider.refresh();
  });

  sub('devbelt.renameTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!ensureWritable(node.conn)) return;
    const newName = await vscode.window.showInputBox({ prompt: l10n('table.renamePrompt'), value: node.label, valueSelection: [0, node.label.length] });
    if (!newName || newName === node.label) return;
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'renameTable')) return;
    await session.table.renameTable(node.label, newName, node.database, node.schema);
    treeProvider.refresh();
  });

  sub('devbelt.renameView', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!ensureWritable(node.conn)) return;
    const newName = await vscode.window.showInputBox({ prompt: l10n('view.renamePrompt'), value: node.label, valueSelection: [0, node.label.length] });
    if (!newName || newName === node.label) return;
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'renameView')) return;
    await session.table.renameView(node.label, newName, node.database, node.schema);
    treeProvider.refresh();
  });

  sub('devbelt.truncateTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!ensureWritable(node.conn)) return;
    if (!(await confirm('table.truncateConfirm', 'table.truncate', node.label))) return;
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'truncateTable')) return;
    await session.table.truncateTable(node.label, node.database, node.schema);
  });

  sub('devbelt.dupTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!ensureWritable(node.conn)) return;
    const newName = await vscode.window.showInputBox({ prompt: l10n('table.dupPrompt', { name: node.label }), value: `${node.label}_copy` });
    if (!newName) return;
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'duplicateTable')) return;
    await session.table.dupTable(node.label, newName, node.database, false, node.schema);
    treeProvider.refresh();
  });

  /**
   * 复制表：先问「只要结构」还是「结构 + 数据」。
   *
   * 与 Duplicate Table 的区别就在这个选择上 —— 后者只复制结构。
   * SQLite 走 `CREATE TABLE AS SELECT`，不保留主键/索引/约束，需要提前说明。
   */
  sub('devbelt.copyTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'duplicateTable') || !ensureWritable(node.conn)) return;
    const isSqlite = node.conn.dbType === 'SQLITE';
    const scope = await vscode.window.showQuickPick(
      [
        {
          label: l10n('table.copyStructureData'),
          description: isSqlite ? l10n('table.copySqliteCaveat') : undefined,
          value: true,
        },
        {
          label: l10n('table.copyStructureOnly'),
          description: isSqlite ? l10n('table.copySqliteCaveat') : undefined,
          value: false,
        },
      ],
      { placeHolder: l10n('table.copyScope', { name: node.label }) },
    );
    if (!scope) return;
    const newName = await vscode.window.showInputBox({
      prompt: l10n('table.copyPrompt', { name: node.label }),
      value: `${node.label}_copy`,
    });
    if (!newName) return;
    try {
      await session.table.dupTable(node.label, newName, node.database, scope.value, node.schema);
      treeProvider.refresh();
      vscode.window.showInformationMessage(l10n('table.copyDone', { name: newName }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  sub('devbelt.viewTableStructure', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    connCtx.setLast(node.conn, node.database);
    const session = await manager.connectSql(node.conn, node.database);
    const columns = await session.metadata.getColumns(node.label, node.database, node.schema);
    // 直接展示元数据，不再执行 `DESCRIBE`（MySQL 专有语句，PG/SQLite 会报语法错）
    executor.openStructure(node.conn, node.label, node.database, columns as any[], node.schema);
  });

  sub('devbelt.viewTableSource', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'getTableDefinition')) return;
    const ddl = await session.table.getCreateSql(node.label, node.database, node.schema);
    await openSqlDoc(ddl || '-- No DDL found');
  });

  sub('devbelt.mockData', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!ensureWritable(node.conn)) return;
    const input = await vscode.window.showInputBox({
      prompt: l10n('mock.prompt'), value: '10',
      validateInput: (v) => /^\d+$/.test(v) ? undefined : l10n('mock.invalid'),
    });
    if (!input) return;
    const count = parseInt(input, 10);
    const session = await manager.connectSql(node.conn, node.database);
    const inserted = await session.table.generateMockData(node.label, node.database, count, undefined, node.schema);
    await recordBulkHistory(
      deps, node.conn,
      l10n('history.mockData', { table: node.label, count: inserted }),
      node.database, inserted,
    );
    vscode.window.showInformationMessage(l10n('mock.done', { count: inserted }));
    treeProvider.refresh();
  });

  // ── 视图/函数/事件 ──
  sub('devbelt.dropView', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!ensureWritable(node.conn)) return;
    if (!(await confirm('view.deleteConfirm', 'view.delete', node.label))) return;
    const session = await manager.connectSql(node.conn, node.database);
    await session.table.dropView(node.label, node.database, node.schema);
    treeProvider.refresh();
  });

  sub('devbelt.newView', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    connCtx.setLast(node.conn, node.database);
    // USE 是 MySQL 专有；PG 用 schema 限定对象名。
    const useDb = node.database && node.conn.dbType === 'MYSQL'
      ? `USE ${wrapIdentForConn(node.conn, node.database)};\n\n`
      : '';
    const tpl = useDb + `CREATE VIEW ${qualifiedIdentForConn(node.conn, 'new_view', node.schema)} AS\n  SELECT * FROM some_table;`;
    const editor = await openSqlDocEditor(tpl);
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  sub('devbelt.modifyView', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    connCtx.setLast(node.conn, node.database);
    const session = await manager.connectSql(node.conn, node.database);
    // 拿「可编辑可执行」的 CREATE OR REPLACE VIEW 语句（SQLite 为 DROP+CREATE），
    // 用可编辑编辑器打开并绑定连接：用户改完 SELECT 直接 Run 重建视图。
    // 此前用 openSqlDoc 只读 + 原始定义（带 DEFINER、是 CREATE VIEW），既不能改也不能直接重跑。
    const sql = await session.metadata.getViewAlterSql(node.label, node.database, node.schema);
    const editor = await openSqlDocEditor(sql || '-- No definition found');
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  sub('devbelt.openRoutine', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connectSql(node.conn, node.database);
    const def = await session.metadata.getRoutineDefinition(node.label, node.routineType || 'FUNCTION', node.database, node.schema);
    await openSqlDoc(def || '-- No definition found');
  });

  sub('devbelt.dropRoutine', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!ensureWritable(node.conn)) return;
    if (!(await confirm('routine.deleteConfirm', 'routine.delete', node.label))) return;
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'manageRoutines')) return;
    await session.table.dropRoutine(node.label, node.routineType || 'FUNCTION', node.database, node.schema, node.routineArgs);
    treeProvider.refresh();
  });

  sub('devbelt.openEvent', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connectSql(node.conn, node.database);
    const def = await session.metadata.getEventDefinition(node.label, node.database, node.schema);
    await openSqlDoc(def || '-- No definition found');
  });

  sub('devbelt.dropEvent', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!ensureWritable(node.conn)) return;
    if (!(await confirm('event.deleteConfirm', 'event.delete', node.label))) return;
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'manageEvents')) return;
    await session.table.dropEvent(node.label, node.database, node.schema);
    treeProvider.refresh();
  });

  // ── 函数/事件 新建与修改（SQL 编辑器模板，可编辑可运行） ──
  sub('devbelt.newRoutine', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    connCtx.setLast(node.conn, node.database);
    // 例程模板由方言给出：`DELIMITER` 是 MySQL 客户端命令，PG 不认它，
    // 而 PG 需要 `$$ ... $$ LANGUAGE plpgsql`。
    const dialect = DialectRegistry.get(node.conn.dbType as DatabaseType);
    // PG 下用 schema 限定例程名（否则会写进/覆盖 search_path 下的同名函数）。
    const routineName = node.schema ? qualifiedIdentForConn(node.conn, 'new_routine', node.schema) : 'new_routine';
    const body = dialect?.createRoutineTemplate(routineName) ?? '';
    if (!body) {
      vscode.window.showWarningMessage(l10n('cmd.routinesUnsupported'));
      return;
    }
    connCtx.setLast(node.conn, node.database);
    const useDb = node.database && node.conn.dbType === 'MYSQL'
      ? `USE ${wrapIdentForConn(node.conn, node.database)};\n\n`
      : '';
    const editor = await openSqlDocEditor(useDb + body);
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  sub('devbelt.modifyRoutine', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connectSql(node.conn, node.database);
    const def = await session.metadata.getRoutineDefinition(node.label, node.routineType || 'FUNCTION', node.database, node.schema);
    const useDb = node.conn.dbType === 'MYSQL' ? `USE ${wrapIdentForConn(node.conn, node.database)};\n\n` : '';
    const editor = await openSqlDocEditor(useDb + (def || '-- No definition found'));
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  sub('devbelt.newEvent', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    connCtx.setLast(node.conn, node.database);
    const useDb = node.database && node.conn.dbType === 'MYSQL'
      ? `USE ${wrapIdentForConn(node.conn, node.database)};\n\n`
      : '';
    const tpl = useDb + `CREATE EVENT new_event\n  ON SCHEDULE EVERY 1 DAY\n  DO\n    -- event action`;
    const editor = await openSqlDocEditor(tpl);
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  sub('devbelt.modifyEvent', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connectSql(node.conn, node.database);
    const def = await session.metadata.getEventDefinition(node.label, node.database, node.schema);
    const useDb = node.conn.dbType === 'MYSQL' ? `USE ${wrapIdentForConn(node.conn, node.database)};\n\n` : '';
    const editor = await openSqlDocEditor(useDb + (def || '-- No definition found'));
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  // ── 列（字段） ──

  /**
   * 列所属的表节点。
   *
   * 「添加字段」既挂在字段节点上，也挂在表节点上（两处行为一致），
   * 因此不能假定 node 一定是 Column。
   */
  const columnTable = (node: DbTreeNode): string | undefined => (
    node.kind === NodeKind.Column ? node.parent?.label : node.label
  );

  /** 刷新列所在的表节点，而不是整棵树（整树刷新会把所有节点折叠回去）。 */
  const refreshColumnParent = (node: DbTreeNode): void => {
    const target = node.kind === NodeKind.Column ? node.parent : node;
    if (target) treeProvider.refreshNode(target);
    else treeProvider.refresh();
  };

  sub('devbelt.addColumn', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const table = columnTable(node);
    if (!table) return;
    if (!ensureWritable(node.conn)) return;
    // 打开表设计器：新加列在可视化表单里完成，而不是 inputBox 顺序问答。
    TableDesignView.open(node.conn, table, node.database, manager, () => refreshColumnParent(node), node.schema);
  });

  sub('devbelt.addColumnSql', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const table = columnTable(node);
    if (!table) return;
    connCtx.setLast(node.conn, node.database);
    const dialect = DialectRegistry.get(node.conn.dbType as DatabaseType);
    const wrapped = qualifiedIdentForConn(node.conn, table, node.schema);
    const body = dialect
      ? dialect.addColumnTemplate(wrapped)
      : `ALTER TABLE ${wrapped} ADD COLUMN new_column INT;`;
    const useDb = node.database && node.conn.dbType === 'MYSQL'
      ? `USE ${wrapIdentForConn(node.conn, node.database)};\n`
      : '';
    const editor = await openSqlDocEditor(useDb + body);
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  sub('devbelt.modifyColumn', async (node: DbTreeNode) => {
    if (!node?.conn || node.kind !== NodeKind.Column || !node.parent || !node.database) return;
    if (!ensureWritable(node.conn)) return;
    TableDesignView.open(node.conn, node.parent.label, node.database, manager, () => refreshColumnParent(node), node.schema);
  });

  sub('devbelt.modifyColumnSql', async (node: DbTreeNode) => {
    if (!node?.conn || node.kind !== NodeKind.Column || !node.parent || !node.database) return;
    const table = node.parent.label;
    connCtx.setLast(node.conn, node.database);
    const session = await manager.connectSql(node.conn, node.database);
    // 预填当前定义：MySQL 从 DDL 解析全量定义（含 NOT NULL/DEFAULT/注释），
    // 否则改一次类型会把约束静默抹掉；非 MySQL 退回列元数据里的类型。
    let definition: string | undefined;
    try {
      definition = await session.table.getColumnDefinition(table, node.label, node.database, node.schema);
    } catch {
      const cols = await session.metadata.getColumns(table, node.database, node.schema);
      const col = cols.find((c: any) => c.name === node.label);
      definition = col?.type || col?.simpleType;
    }
    if (!definition) definition = 'INT';
    const dialect = DialectRegistry.get(node.conn.dbType as DatabaseType);
    const wrapped = qualifiedIdentForConn(node.conn, table, node.schema);
    const body = dialect
      ? dialect.modifyColumnTemplate(wrapped, node.label, definition)
      : `ALTER TABLE ${wrapped} ALTER COLUMN ${wrapIdentForConn(node.conn, node.label)} TYPE ${definition};`;
    const useDb = node.database && node.conn.dbType === 'MYSQL'
      ? `USE ${wrapIdentForConn(node.conn, node.database)};\n`
      : '';
    const editor = await openSqlDocEditor(useDb + body);
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  sub('devbelt.renameColumn', async (node: DbTreeNode) => {
    if (!node?.conn || node.kind !== NodeKind.Column || !node.parent) return;
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'alterTable') || !ensureWritable(node.conn)) return;
    const newName = await vscode.window.showInputBox({
      prompt: l10n('column.renamePrompt'),
      value: node.label,
      valueSelection: [0, node.label.length],
      validateInput: (v) => (v.trim() ? undefined : l10n('column.nameRequired')),
    });
    if (!newName?.trim() || newName.trim() === node.label) return;
    try {
      await session.table.renameColumn(node.parent.label, node.label, newName.trim(), node.database, node.schema);
      refreshColumnParent(node);
      vscode.window.showInformationMessage(l10n('column.renamed', { name: newName.trim() }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  /**
   * 删字段：确认后**直接执行**。
   *
   * 过去只是把 `ALTER TABLE ... DROP COLUMN` 丢到编辑器里，用户还得自己去点运行，
   * 而树已经先刷新了一遍，看起来像「删了但没删掉」。
   */
  sub('devbelt.dropColumn', async (node: DbTreeNode) => {
    if (!node?.conn || node.kind !== NodeKind.Column || !node.parent) return;
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'alterTable') || !ensureWritable(node.conn)) return;
    if (!(await confirm('column.dropConfirm', 'common.delete', node.label))) return;
    try {
      await session.table.dropColumn(node.parent.label, node.label, node.database, node.schema);
      refreshColumnParent(node);
      vscode.window.showInformationMessage(l10n('column.dropped', { name: node.label }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  sub('devbelt.copyNodeName', async (node: DbTreeNode) => {
    if (!node?.label) return;
    await vscode.env.clipboard.writeText(node.label);
    vscode.window.showInformationMessage(l10n('common.copied', { name: node.label }));
  });
}
