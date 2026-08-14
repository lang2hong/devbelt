import * as vscode from 'vscode';
import { DialectRegistry, type DatabaseType } from '@db-client/core';
import { DbTreeNode, NodeKind } from '../tree/dbTreeNode';
import { wrapIdentForConn } from '../utils/sql';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm, openSqlDoc, openSqlDocEditor, requireCapability } from './shared';
import { runExportWizard } from './database';
import { TableQueryView } from '../result/tableQueryView';

export function registerTableCommands(deps: Deps, sub: Sub): void {
  const { manager, treeProvider, executor, connCtx } = deps;

  // ── 外键跳转 ──
  sub('dbclient.jumpToRefTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node.refTable) return;
    TableQueryView.open(node.conn, node.refTable, node.database ?? node.conn.database ?? '', manager);
  });

  // ── 表 ──
  sub('dbclient.newTable', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    connCtx.setLast(node.conn, node.database);
    // 模板由方言给出：自增主键的写法三家不同，过去统一发 MySQL 语法，
    // PG/SQLite 用户拿到的模板直接执行会报错。
    const dialect = DialectRegistry.get(node.conn.dbType as DatabaseType);
    const table = wrapIdentForConn(node.conn, 'new_table');
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

  sub('dbclient.dropTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!(await confirm('table.dropConfirm', 'table.delete', node.label))) return;
    const session = await manager.connect(node.conn);
    await session.table.dropTable(node.label, node.database);
    treeProvider.refresh();
  });

  sub('dbclient.renameTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const newName = await vscode.window.showInputBox({ prompt: l10n('table.renamePrompt'), value: node.label });
    if (!newName || newName === node.label) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'renameTable')) return;
    await session.table.renameTable(node.label, newName, node.database);
    treeProvider.refresh();
  });

  sub('dbclient.renameView', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const newName = await vscode.window.showInputBox({ prompt: l10n('view.renamePrompt'), value: node.label });
    if (!newName || newName === node.label) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'renameView')) return;
    await session.table.renameView(node.label, newName, node.database);
    treeProvider.refresh();
  });

  sub('dbclient.truncateTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!(await confirm('table.truncateConfirm', 'table.truncate', node.label))) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'truncateTable')) return;
    await session.table.truncateTable(node.label, node.database);
  });

  sub('dbclient.dupTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const newName = await vscode.window.showInputBox({ prompt: l10n('table.dupPrompt', { name: node.label }), value: `${node.label}_copy` });
    if (!newName) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'duplicateTable')) return;
    await session.table.dupTable(node.label, newName, node.database);
    treeProvider.refresh();
  });

  sub('dbclient.viewTableStructure', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    connCtx.setLast(node.conn, node.database);
    const session = await manager.connect(node.conn);
    const columns = await session.metadata.getColumns(node.label, node.database);
    const result = {
      sql: `DESCRIBE ${wrapIdentForConn(node.conn, node.label)}`,
      costTime: 0,
      rows: columns as any[],
      fields: Object.keys(columns[0] || {}).map((name) => ({ name })),
      truncated: false,
    } as any;
    await executor.run(node.conn, `DESCRIBE ${wrapIdentForConn(node.conn, node.label)};`, node.database);
    // run 创建视图后，在 ready 回调中由 execute 渲染；这里用 renderExternal 直接推送结构结果
    executor.renderExternal(result);
  });

  sub('dbclient.viewTableSource', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'getTableDefinition')) return;
    const ddl = await session.table.getCreateSql(node.label, node.database);
    await openSqlDoc(ddl || '-- No DDL found');
  });

  sub('dbclient.dumpTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    await runExportWizard(node, manager, deps.connCtx, node.label);
  });

  sub('dbclient.mockData', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const input = await vscode.window.showInputBox({
      prompt: l10n('mock.prompt'), value: '10',
      validateInput: (v) => /^\d+$/.test(v) ? undefined : l10n('mock.invalid'),
    });
    if (!input) return;
    const count = parseInt(input, 10);
    const session = await manager.connect(node.conn);
    const inserted = await session.table.generateMockData(node.label, node.database, count);
    vscode.window.showInformationMessage(l10n('mock.done', { count: inserted }));
    treeProvider.refresh();
  });

  // ── 视图/函数/事件 ──
  sub('dbclient.dropView', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!(await confirm('view.deleteConfirm', 'view.delete', node.label))) return;
    const session = await manager.connect(node.conn);
    await session.table.dropView(node.label, node.database);
    treeProvider.refresh();
  });

  sub('dbclient.newView', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    connCtx.setLast(node.conn, node.database);
    const useDb = node.database ? `USE ${wrapIdentForConn(node.conn, node.database)};\n\n` : '';
    const tpl = useDb + `CREATE VIEW new_view AS\n  SELECT * FROM some_table;`;
    const editor = await openSqlDocEditor(tpl);
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  sub('dbclient.modifyView', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    const def = await session.metadata.getViewDefinition(node.label, node.database);
    await openSqlDoc(def || '-- No definition found');
  });

  sub('dbclient.openRoutine', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    const def = await session.metadata.getRoutineDefinition(node.label, node.routineType || 'FUNCTION', node.database);
    await openSqlDoc(def || '-- No definition found');
  });

  sub('dbclient.dropRoutine', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!(await confirm('routine.deleteConfirm', 'routine.delete', node.label))) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'manageRoutines')) return;
    await session.table.dropRoutine(node.label, node.routineType || 'FUNCTION', node.database);
    treeProvider.refresh();
  });

  sub('dbclient.openEvent', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    const def = await session.metadata.getEventDefinition(node.label, node.database);
    await openSqlDoc(def || '-- No definition found');
  });

  sub('dbclient.dropEvent', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!(await confirm('event.deleteConfirm', 'event.delete', node.label))) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'manageEvents')) return;
    await session.table.dropEvent(node.label, node.database);
    treeProvider.refresh();
  });

  // ── 函数/事件 新建与修改（SQL 编辑器模板，可编辑可运行） ──
  sub('dbclient.newRoutine', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    connCtx.setLast(node.conn, node.database);
    // 例程模板由方言给出：`DELIMITER` 是 MySQL 客户端命令，PG 不认它，
    // 而 PG 需要 `$$ ... $$ LANGUAGE plpgsql`。
    const dialect = DialectRegistry.get(node.conn.dbType as DatabaseType);
    const body = dialect?.createRoutineTemplate('new_routine') ?? '';
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

  sub('dbclient.modifyRoutine', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    const def = await session.metadata.getRoutineDefinition(node.label, node.routineType || 'FUNCTION', node.database);
    const useDb = `USE ${wrapIdentForConn(node.conn, node.database)};\n\n`;
    const editor = await openSqlDocEditor(useDb + (def || '-- No definition found'));
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  sub('dbclient.newEvent', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    connCtx.setLast(node.conn, node.database);
    const useDb = node.database ? `USE ${wrapIdentForConn(node.conn, node.database)};\n\n` : '';
    const tpl = useDb + `CREATE EVENT new_event\n  ON SCHEDULE EVERY 1 DAY\n  DO\n    -- event action`;
    const editor = await openSqlDocEditor(tpl);
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  sub('dbclient.modifyEvent', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    const def = await session.metadata.getEventDefinition(node.label, node.database);
    const useDb = `USE ${wrapIdentForConn(node.conn, node.database)};\n\n`;
    const editor = await openSqlDocEditor(useDb + (def || '-- No definition found'));
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), node.conn, node.database);
  });

  // ── 列（字段） ──
  const columnSqlEditor = async (conn: import('../connection/connectionStore').SavedConnection, database: string | undefined, sql: string) => {
    const useDb = database ? `USE ${wrapIdentForConn(conn, database)};\n\n` : '';
    const editor = await openSqlDocEditor(useDb + sql);
    if (editor) connCtx.setForDoc(editor.document.uri.toString(), conn, database);
    treeProvider.refresh();
  };

  sub('dbclient.addColumn', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const parent = node.kind === NodeKind.Column ? node.parent : node;
    const table = parent?.label;
    if (!table) return;
    await columnSqlEditor(node.conn, node.database, `ALTER TABLE ${wrapIdentForConn(node.conn, table)}\n  ADD COLUMN new_column VARCHAR(255) NOT NULL;`);
  });

  sub('dbclient.modifyColumn', async (node: DbTreeNode) => {
    if (!node?.conn || node.kind !== NodeKind.Column || !node.parent) return;
    await columnSqlEditor(node.conn, node.database, `ALTER TABLE ${wrapIdentForConn(node.conn, node.parent.label)}\n  MODIFY COLUMN ${wrapIdentForConn(node.conn, node.label)} VARCHAR(255) NOT NULL;`);
  });

  sub('dbclient.dropColumn', async (node: DbTreeNode) => {
    if (!node?.conn || node.kind !== NodeKind.Column || !node.parent) return;
    await columnSqlEditor(node.conn, node.database, `ALTER TABLE ${wrapIdentForConn(node.conn, node.parent.label)}\n  DROP COLUMN ${wrapIdentForConn(node.conn, node.label)};`);
  });

  sub('dbclient.copyNodeName', async (node: DbTreeNode) => {
    if (!node?.label) return;
    await vscode.env.clipboard.writeText(node.label);
    vscode.window.showInformationMessage(`Copied "${node.label}"`);
  });
}
