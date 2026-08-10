import * as vscode from 'vscode';
import { DbTreeNode } from '../tree/dbTreeNode';
import { wrapIdent } from '../utils/sql';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm, openSqlDoc, openSqlDocEditor, requireCapability } from './shared';
import { runExportWizard } from './database';

export function registerTableCommands(deps: Deps, sub: Sub): void {
  const { manager, treeProvider, executor, connCtx } = deps;

  // ── 表 ──
  sub('dbclient.newTable', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    connCtx.setLast(node.conn, node.database);
    const useDb = node.database ? `USE ${wrapIdent(node.conn, node.database)};\n` : '';
    const tpl = useDb + `CREATE TABLE IF NOT EXISTS ${wrapIdent(node.conn, 'new_table')} (\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  name VARCHAR(255)\n);`;
    const editor = await openSqlDocEditor(tpl);
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
      sql: `DESCRIBE ${wrapIdent(node.conn, node.label)}`,
      costTime: 0,
      rows: columns as any[],
      fields: Object.keys(columns[0] || {}).map((name) => ({ name })),
      truncated: false,
    } as any;
    await executor.run(node.conn, `DESCRIBE ${wrapIdent(node.conn, node.label)};`, node.database);
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
}
