import * as vscode from 'vscode';
import { SchemaDiffService } from '@db-client/core';
import type { SavedConnection } from './connection/connectionStore';
import { ConnectionStore } from './connection/connectionStore';
import { ConnectionManager } from './connection/connectionManager';
import { ConnectionForm } from './connection/connectionForm';
import { DbTreeDataProvider } from './tree/dbTreeDataProvider';
import { DbTreeNode, NodeKind } from './tree/dbTreeNode';
import { QueryExecutor } from './result/queryExecutor';
import { TableQueryView } from './result/tableQueryView';
import { AuthService } from './sync/authService';
import { LoginForm } from './sync/loginForm';
import { SyncManager } from './sync/syncManager';
import { HistoryStore } from './history/historyStore';
import { formatSql } from './format/sqlFormatter';
import { l10n } from './i18n';
import { wrapIdent } from './utils/sql';

interface Deps {
  context: vscode.ExtensionContext;
  store: ConnectionStore;
  manager: ConnectionManager;
  treeProvider: DbTreeDataProvider;
  executor: QueryExecutor;
  history: HistoryStore;
  auth: AuthService;
  sync: SyncManager;
  syncBar: SyncStatusBar;
}

export function registerCommands(deps: Deps): void {
  const { context, store, manager, treeProvider, executor, history, auth, sync, syncBar } = deps;
  const sub = (cmd: string, handler: (...args: any[]) => any): void => {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));
  };

  // ── 连接 ──
  sub('dbclient.addConnection', (node?: DbTreeNode) => {
    const gid = node?.kind === NodeKind.Group ? node.groupId : undefined;
    ConnectionForm.open(store, () => treeProvider.refresh(), gid);
  });
  sub('dbclient.editConnection', (node: DbTreeNode) => {
    if (node?.conn) ConnectionForm.open(store, () => treeProvider.refresh(), undefined, node.conn);
  });
  sub('dbclient.deleteConnection', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const ok = await vscode.window.showWarningMessage(
      l10n('conn.deleteConfirm', { name: node.conn.name || node.conn.host }),
      { modal: true }, l10n('table.delete'));
    if (ok !== l10n('table.delete')) return;
    await store.remove(node.conn.id);
    manager.disposeConn(node.conn.id);
    treeProvider.refresh();
  });
  sub('dbclient.closeConnection', (node: DbTreeNode) => {
    if (!node?.conn) return;
    manager.disposeConn(node.conn.id);
    treeProvider.markClosed(node.conn.id);
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('conn.closed', { name: node.conn.name || node.conn.host }));
  });
  sub('dbclient.openConnection', (conn: SavedConnection) => {
    if (!conn?.id) return;
    treeProvider.markOpen(conn.id);
    treeProvider.refresh();
  });
  sub('dbclient.refresh', () => treeProvider.refresh());

  // Code Lens: 运行单条 SQL 语句
  sub('dbclient.runStatement', async (sql: string) => {
    if (!sql) return;
    const conn = await pickConnection(store);
    if (!conn) return;
    await executor.run(conn, sql);
  });

  // ── 查询 ──
  sub('dbclient.runQuery', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage(l10n('cmd.openEditorFirst'));
      return;
    }
    const conn = await pickConnection(store);
    if (!conn) return;
    const sql = editor.selection.isEmpty
      ? editor.document.getText()
      : editor.document.getText(editor.selection);
    await executor.run(conn, sql);
  });
  // 从文件资源管理器右键运行 SQL 文件
  sub('dbclient.runSqlFile', async (uri: vscode.Uri) => {
    if (!uri) return;
    const conn = await pickConnection(store);
    if (!conn) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    await executor.run(conn, doc.getText());
  });
  sub('dbclient.previewTable', (node: DbTreeNode) => {
    if (node?.conn && node?.database) {
      TableQueryView.open(node.conn, node.label, node.database, manager);
    }
  });
  sub('dbclient.previewView', (node: DbTreeNode) => {
    if (node?.conn && node?.database) {
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
      await openSqlDoc(picked.value.sql);
    }
  });
  sub('dbclient.updateCell', async (args: {
    conn: SavedConnection; table: string; primaryKey: string; rowId: any; column: string; value: any;
  }) => {
    try {
      const session = await manager.connect(args.conn);
      await session.data.updateCell(args.table, args.primaryKey, args.rowId, args.column, args.value);
      vscode.window.showInformationMessage(l10n('cmd.updated', { table: args.table, column: args.column }));
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  // ── 表 ──
  sub('dbclient.newTable', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const tpl = [
      `CREATE TABLE IF NOT EXISTS ${wrapIdent(node.conn, 'new_table')} (`,
      '  id INT AUTO_INCREMENT PRIMARY KEY,',
      '  name VARCHAR(255)',
      ');',
    ].join('\n');
    await openSqlDoc(tpl);
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
    await session.table.renameTable(node.label, newName, node.database);
    treeProvider.refresh();
  });
  sub('dbclient.truncateTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (!(await confirm('table.truncateConfirm', 'table.truncate', node.label))) return;
    const session = await manager.connect(node.conn);
    await session.table.truncateTable(node.label, node.database);
  });
  sub('dbclient.dupTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const newName = await vscode.window.showInputBox({ prompt: l10n('table.dupPrompt', { name: node.label }), value: `${node.label}_copy` });
    if (!newName) return;
    const session = await manager.connect(node.conn);
    await session.table.dupTable(node.label, newName, node.database);
    treeProvider.refresh();
  });
  sub('dbclient.viewTableStructure', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    const columns = await session.metadata.getColumns(node.label, node.database);
    executor.renderExternal({
      sql: `DESCRIBE ${wrapIdent(node.conn, node.label)}`,
      costTime: 0,
      rows: columns,
      fields: Object.keys(columns[0] || {}).map((name) => ({ name })),
    } as any);
  });
  sub('dbclient.viewTableSource', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    const ddl = await session.table.getCreateSql(node.label, node.database);
    await openSqlDoc(ddl || '-- No DDL found');
  });

  // 表结构+数据导出（mysqldump 风格）
  sub('dbclient.dumpTable', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Structure + Data', value: true as boolean },
        { label: 'Structure Only', value: false as boolean },
      ],
      { placeHolder: 'Export table dump' },
    );
    if (!choice) return;
    const session = await manager.connect(node.conn);
    const dump = await session.table.dumpSql(node.label, node.database, choice.value);
    await openSqlDoc(dump);
  });

  // Mock 数据生成
  sub('dbclient.mockData', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const input = await vscode.window.showInputBox({
      prompt: l10n('mock.prompt'),
      value: '10',
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
    await session.table.dropEvent(node.label, node.database);
    treeProvider.refresh();
  });

  // ── 数据库 ──
  sub('dbclient.createDatabase', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('db.createPrompt') });
    if (!name) return;
    const session = await manager.connect(node.conn);
    await session.query.query(`CREATE DATABASE ${wrapIdent(node.conn, name)}`);
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('db.created', { name }));
  });
  sub('dbclient.dropDatabase', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (!(await confirm('db.dropConfirm', 'db.drop', node.label))) return;
    const session = await manager.connect(node.conn);
    await session.query.query(`DROP DATABASE ${wrapIdent(node.conn, node.label)}`);
    manager.disposeConn(node.conn.id);
    treeProvider.refresh();
  });

  // 结构差异/同步：比对两个数据库结构，生成 ALTER SQL
  sub('dbclient.compareSchema', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    // 选目标库
    const targetDbs = (await session.metadata.getDatabases()).filter((d) => d !== node.database);
    if (!targetDbs.length) {
      vscode.window.showWarningMessage('No other databases to compare.');
      return;
    }
    const target = await vscode.window.showQuickPick(
      targetDbs.map((d) => ({ label: d, value: d })),
      { placeHolder: `Compare "${node.database}" with which database?` },
    );
    if (!target) return;

    const diffs = await SchemaDiffService.diff(
      session.metadata, node.database,
      session.metadata, target.value,
    );
    const syncSql = await SchemaDiffService.generateSyncSql(
      diffs, target.value, session.table, node.database,
    );

    // 统计差异
    const added = diffs.filter((d) => d.status === 'added').length;
    const removed = diffs.filter((d) => d.status === 'removed').length;
    const changed = diffs.filter((d) => d.status === 'changed').length;
    const header = `-- Diff: ${node.database} → ${target.value} (${added} added, ${removed} removed, ${changed} changed)\n\n`;

    await openSqlDoc(header + syncSql);
  });

  // ── 用户管理 ──
  sub('dbclient.createUser', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('user.namePrompt') });
    if (!name) return;
    const password = await vscode.window.showInputBox({ prompt: l10n('user.passwordPrompt'), password: true });
    if (password === undefined) return;
    const host = await vscode.window.showInputBox({ prompt: l10n('user.hostPrompt'), value: '%' }) || '%';
    const session = await manager.connect(node.conn);
    await session.table.createUser(name, password, host);
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('user.created', { name }));
  });
  sub('dbclient.dropUser', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (!(await confirm('user.dropConfirm', 'user.drop', node.label))) return;
    const session = await manager.connect(node.conn);
    const parts = node.label.split('@');
    await session.table.dropUser(parts[0], parts[1] || '%');
    treeProvider.refresh();
  });
  sub('dbclient.changePassword', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const password = await vscode.window.showInputBox({ prompt: l10n('user.passwordPrompt'), password: true });
    if (!password) return;
    const session = await manager.connect(node.conn);
    const parts = node.label.split('@');
    await session.table.alterUserPassword(parts[0], password, parts[1] || '%');
    vscode.window.showInformationMessage(l10n('user.passwordChanged', { name: node.label }));
  });
  sub('dbclient.grantPrivilege', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const priv = await vscode.window.showInputBox({ prompt: l10n('user.privPrompt'), value: 'ALL PRIVILEGES' });
    if (!priv) return;
    const session = await manager.connect(node.conn);
    const parts = node.label.split('@');
    await session.table.grantPrivilege(parts[0], priv, node.database, parts[1] || '%');
    vscode.window.showInformationMessage(l10n('user.granted', { priv, name: node.label }));
  });
  sub('dbclient.revokePrivilege', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const priv = await vscode.window.showInputBox({ prompt: l10n('user.privPrompt'), value: 'ALL PRIVILEGES' });
    if (!priv) return;
    const session = await manager.connect(node.conn);
    const parts = node.label.split('@');
    await session.table.revokePrivilege(parts[0], priv, node.database, parts[1] || '%');
    vscode.window.showInformationMessage(l10n('user.revoked', { priv, name: node.label }));
  });

  // ── 保存的查询 ──
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
    if (q) await openSqlDoc(q.sql);
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

  // ── 分组 ──
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

  // ── 同步 ──
  sub('dbclient.login', () => LoginForm.open(auth, () => syncBar.update()));
  sub('dbclient.logout', async () => {
    await auth.logout();
    syncBar.update();
    vscode.window.showInformationMessage(l10n('cmd.loggedOut'));
  });
  sub('dbclient.syncPull', async () => {
    const mp = await promptMasterPassword();
    if (!mp) return;
    await sync.pull(mp);
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('cmd.pullDone'));
  });
  sub('dbclient.syncPush', async () => {
    const mp = await promptMasterPassword();
    if (!mp) return;
    await sync.push(mp);
    vscode.window.showInformationMessage(l10n('cmd.pushDone'));
  });

  // ── 下拉菜单（executeCommand 复用已注册命令） ──
  sub('dbclient.explorerMenu', async () => {
    const loggedIn = auth.isLoggedIn();
    const items: (vscode.QuickPickItem & { value: string })[] = [
      { label: '$(add) New Group', description: 'Create a connection group', value: 'addGroup' },
      { label: '$(history) Query History', description: 'View recent queries', value: 'showHistory' },
      { label: '$(cloud-download) Pull from Cloud', description: 'Download & merge', value: 'syncPull' },
      { label: '$(cloud-upload) Push to Cloud', description: 'Upload local data', value: 'syncPush' },
      loggedIn
        ? { label: '$(sign-out) Logout', value: 'logout' }
        : { label: '$(sign-in) Login', value: 'login' },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'DB Client actions' });
    if (picked) {
      await vscode.commands.executeCommand(`dbclient.${picked.value}`);
    }
  });

  context.subscriptions.push({ dispose: () => manager.disposeAll() });
}

// ── 辅助函数 ──

async function confirm(msgKey: string, btnKey: string, name: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(l10n(msgKey, { name }), { modal: true }, l10n(btnKey))) === l10n(btnKey);
}

async function openSqlDoc(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'sql' });
  await vscode.window.showTextDocument(doc);
}

async function pickConnection(store: ConnectionStore): Promise<SavedConnection | undefined> {
  const list = store.list();
  if (!list.length) {
    vscode.window.showInformationMessage(l10n('cmd.noConnection'));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.name || c.host, detail: c.host, value: c })),
    { placeHolder: l10n('cmd.selectConnection') },
  );
  return picked?.value;
}

async function promptMasterPassword(): Promise<string | undefined> {
  return vscode.window.showInputBox({ prompt: l10n('cmd.masterPassword'), password: true });
}

export class SyncStatusBar {
  private readonly item: vscode.StatusBarItem;
  constructor(private readonly auth: AuthService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'dbclient.login';
    this.update();
    this.item.show();
  }
  update(): void {
    if (this.auth.isLoggedIn()) {
      void this.auth.getEmail().then((email) => {
        this.item.text = '$(cloud) ' + (email || 'synced');
        this.item.command = 'dbclient.logout';
      });
    } else {
      this.item.text = '$(cloud) Not logged in';
      this.item.command = 'dbclient.login';
    }
  }
}
