import * as vscode from 'vscode';
import { DialectRegistry, type DatabaseType } from '@db-client/core';
import { DbTreeNode, NodeKind } from '../tree/dbTreeNode';
import { wrapIdentForConn } from '../utils/sql';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm, openSqlDoc, openSqlDocEditor, recordBulkHistory, requireCapability } from './shared';
import { ensureWritable } from '../utils/sqlSafety';
import { TableQueryView } from '../result/tableQueryView';

export function registerTableCommands(deps: Deps, sub: Sub): void {
  const { manager, treeProvider, executor, connCtx } = deps;

  // ── 外键跳转 ──
  sub('dbclient.jumpToRefTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node.refTable) return;
    TableQueryView.open(node.conn, node.refTable, node.database ?? node.conn.database ?? '', manager, {
      objectType: 'table',
    });
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

  /**
   * 复制表：先问「只要结构」还是「结构 + 数据」。
   *
   * 与 Duplicate Table 的区别就在这个选择上 —— 后者只复制结构。
   * SQLite 走 `CREATE TABLE AS SELECT`，不保留主键/索引/约束，需要提前说明。
   */
  sub('dbclient.copyTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
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
      await session.table.dupTable(node.label, newName, node.database, scope.value);
      treeProvider.refresh();
      vscode.window.showInformationMessage(l10n('table.copyDone', { name: newName }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  sub('dbclient.viewTableStructure', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    connCtx.setLast(node.conn, node.database);
    const session = await manager.connect(node.conn);
    const columns = await session.metadata.getColumns(node.label, node.database);
    // 直接展示元数据，不再执行 `DESCRIBE`（MySQL 专有语句，PG/SQLite 会报语法错）
    executor.openStructure(node.conn, node.label, node.database, columns as any[]);
  });

  sub('dbclient.viewTableSource', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'getTableDefinition')) return;
    const ddl = await session.table.getCreateSql(node.label, node.database);
    await openSqlDoc(ddl || '-- No DDL found');
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
    await recordBulkHistory(
      deps, node.conn,
      l10n('history.mockData', { table: node.label, count: inserted }),
      node.database, inserted,
    );
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

  /**
   * 列所属的表节点。
   *
   * 「添加字段」既挂在字段节点上，也挂在表节点上（两处行为一致），
   * 因此不能假定 node 一定是 Column。
   */
  const columnTable = (node: DbTreeNode): string | undefined => (
    node.kind === NodeKind.Column ? node.parent?.label : node.label
  );

  /** 列类型输入：候选来自方言，也允许手输（长度/精度千变万化）。 */
  const askColumnType = async (
    conn: import('../connection/connectionStore').SavedConnection,
    value?: string,
  ): Promise<string | undefined> => {
    const dialect = DialectRegistry.get(conn.dbType as DatabaseType);
    const types = dialect ? [...dialect.columnTypes] : [];
    const input = await vscode.window.showInputBox({
      prompt: l10n('column.typePrompt'),
      value: value ?? types.find((t) => /^(VARCHAR|CHARACTER VARYING|TEXT)/i.test(t)) ?? '',
      placeHolder: types.slice(0, 6).join(', '),
      validateInput: (v) => (v.trim() ? undefined : l10n('column.typeRequired')),
    });
    return input?.trim() || undefined;
  };

  /** 刷新列所在的表节点，而不是整棵树（整树刷新会把所有节点折叠回去）。 */
  const refreshColumnParent = (node: DbTreeNode): void => {
    const target = node.kind === NodeKind.Column ? node.parent : node;
    if (target) treeProvider.refreshNode(target);
    else treeProvider.refresh();
  };

  sub('dbclient.addColumn', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const table = columnTable(node);
    if (!table) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'alterTable') || !ensureWritable(node.conn)) return;
    const name = await vscode.window.showInputBox({
      prompt: l10n('column.namePrompt'),
      validateInput: (v) => (v.trim() ? undefined : l10n('column.nameRequired')),
    });
    if (!name?.trim()) return;
    const type = await askColumnType(node.conn);
    if (!type) return;
    const nullable = await vscode.window.showQuickPick(
      [{ label: l10n('column.nullable'), value: false }, { label: l10n('column.notNull'), value: true }],
      { placeHolder: l10n('column.nullPrompt') },
    );
    if (!nullable) return;
    try {
      await session.table.addColumn(
        table, name.trim(), `${type}${nullable.value ? ' NOT NULL' : ' NULL'}`, node.database,
      );
      refreshColumnParent(node);
      vscode.window.showInformationMessage(l10n('column.added', { name: name.trim() }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  /**
   * 改字段。
   *
   * MySQL 必须用 `CHANGE COLUMN`：`MODIFY COLUMN` 改不了列名，而改名是最常见的诉求。
   * 当前定义会预填进输入框（MySQL 从 DDL 解析全量定义），
   * 否则 NOT NULL / DEFAULT / 注释会在一次「改类型」里被静默抹掉。
   */
  sub('dbclient.modifyColumn', async (node: DbTreeNode) => {
    if (!node?.conn || node.kind !== NodeKind.Column || !node.parent) return;
    const table = node.parent.label;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'alterTable') || !ensureWritable(node.conn)) return;
    const newName = await vscode.window.showInputBox({
      prompt: l10n('column.renamePrompt'),
      value: node.label,
      validateInput: (v) => (v.trim() ? undefined : l10n('column.nameRequired')),
    });
    if (!newName?.trim()) return;

    let current: string | undefined;
    try {
      current = await session.table.getColumnDefinition(table, node.label, node.database);
    } catch {
      // 非 MySQL 或解析失败：退回列元数据里的类型
      const cols = await session.metadata.getColumns(table, node.database);
      const col = cols.find((c: any) => c.name === node.label);
      current = col?.type || col?.simpleType;
    }
    const definition = await askColumnType(node.conn, current);
    if (!definition) return;
    try {
      await session.table.changeColumn(table, node.label, newName.trim(), definition, node.database);
      refreshColumnParent(node);
      vscode.window.showInformationMessage(l10n('column.modified', { name: newName.trim() }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  sub('dbclient.renameColumn', async (node: DbTreeNode) => {
    if (!node?.conn || node.kind !== NodeKind.Column || !node.parent) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'alterTable') || !ensureWritable(node.conn)) return;
    const newName = await vscode.window.showInputBox({
      prompt: l10n('column.renamePrompt'),
      value: node.label,
      validateInput: (v) => (v.trim() ? undefined : l10n('column.nameRequired')),
    });
    if (!newName?.trim() || newName.trim() === node.label) return;
    try {
      await session.table.renameColumn(node.parent.label, node.label, newName.trim(), node.database);
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
  sub('dbclient.dropColumn', async (node: DbTreeNode) => {
    if (!node?.conn || node.kind !== NodeKind.Column || !node.parent) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'alterTable') || !ensureWritable(node.conn)) return;
    if (!(await confirm('column.dropConfirm', 'common.delete', node.label))) return;
    try {
      await session.table.dropColumn(node.parent.label, node.label, node.database);
      refreshColumnParent(node);
      vscode.window.showInformationMessage(l10n('column.dropped', { name: node.label }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  sub('dbclient.copyNodeName', async (node: DbTreeNode) => {
    if (!node?.label) return;
    await vscode.env.clipboard.writeText(node.label);
    vscode.window.showInformationMessage(`Copied "${node.label}"`);
  });
}
