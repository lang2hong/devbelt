import * as vscode from 'vscode';
import { ConnectionStore } from './connection/connectionStore';
import { ConnectionManager } from './connection/connectionManager';
import { ConnectionContext } from './connection/connectionContext';
import { DbTreeDataProvider } from './tree/dbTreeDataProvider';
import { QueryExecutor } from './result/queryExecutor';
import { BaseWebView } from './result/baseWebView';
import { TableQueryView } from './result/tableQueryView';
import { TableDesignView } from './result/tableDesignView';
import { StatusView } from './result/statusView';
import { ERDiagramView } from './result/erDiagramView';
import { DataDiffView } from './result/dataDiffView';
import { DashboardView } from './result/dashboardView';
import { AuditLogView } from './result/auditLogView';
import { PoolStatusView } from './result/poolStatusView';
import { AuditLogger } from './utils/auditLogger';
import { BackupScheduler } from './schedule/backupScheduler';
import { HistoryStore } from './history/historyStore';
import { AuthService, DEFAULT_SERVER_URL } from './sync/authService';
import { eventBus, ConnectionChangedEvent, DataChangeEvent, AuthEvent } from './utils/event';
import { invalidateLanguage, LANGUAGE_CONFIG_KEY } from './i18n';
import { registerCommands } from './commands';
import { SqlCompletionProvider } from './completion/sqlCompletionProvider';
import { SqlCodeLensProvider } from './completion/sqlCodeLensProvider';
import { TerminalService } from './terminal/terminalService';
import { OrgClient } from './org/client';
import { CredentialVault } from './org/credentialVault';
import { OrgWorkspace } from './org/workspace';
import { OrgTreeDataProvider } from './tree/orgTreeDataProvider';
import { registerOrgCommands } from './commands/org';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new ConnectionStore(context.globalState, context.secrets);
  await store.init();
  const serverUrl = DEFAULT_SERVER_URL;
  const auth = new AuthService(context.secrets, serverUrl, context.globalState);
  const history = new HistoryStore(context.globalState);
  // history 注入管理器：所有会话的修改性语句由此自动进历史，
  // 不再依赖各命令自行调用 history.add（漏一个就少一段痕迹）。
  const manager = new ConnectionManager(undefined, history);
  const treeProvider = new DbTreeDataProvider(store, manager);
  const auditLogger = AuditLogger.init(context.globalState);
  const executor = new QueryExecutor(manager, history, auditLogger);
  const connCtx = new ConnectionContext(context, store);

  // 定时备份：从 globalState 恢复已保存的计划
  const backupScheduler = new BackupScheduler(manager, store, context.globalState);
  backupScheduler.start();
  context.subscriptions.push(backupScheduler);

  BaseWebView.init(context.extensionUri);
  TableQueryView.init(context.extensionUri);

  // AuthService 订阅了 SecretStorage 变更（多窗口 token 同步），必须随扩展一起释放
  context.subscriptions.push(auth);
  await auth.init();
  // package.json 的 commandPalette 用 dbclient.loggedIn 控制 login/logout/account/sessions
  // 的可见性。此前从未及时 setContext，导致 logout/account/sessions 永久不可见、login 永久可见；
  // AuthEvent 订阅（下方）在登录/登出后刷新此上下文保持同步。
  void syncLoggedInContext(auth);

  // 事件总线：连接/分组变更时自动刷新树
  context.subscriptions.push(
    eventBus.subscribe(ConnectionChangedEvent, () => treeProvider.refresh()),
  );
  // DDL（CREATE/ALTER/DROP/TRUNCATE 等）后刷新树：表结构变化，表列表需要重拉。
  // 只响应 ddl，rowEditor 的 insert/update/delete 不触发整树刷新。
  context.subscriptions.push(
    eventBus.subscribe(DataChangeEvent, (e) => {
      if (e.operation === 'ddl') treeProvider.refresh();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(LANGUAGE_CONFIG_KEY)) invalidateLanguage();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const queryId = connCtx.getSavedQueryForDoc(document);
      if (!queryId) return;
      void store.updateQuery(queryId, { sql: document.getText() });
    }),
    vscode.workspace.onDidCloseTextDocument((document) => connCtx.clearForDoc(document.uri.toString())),
  );

  const treeView = vscode.window.createTreeView('dbclient.explorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // 组织 Workspace 使用独立数据源，与个人连接树和同步完全分离。
  const orgClient = new OrgClient(auth.client);
  const orgVault = new CredentialVault(context.secrets);
  const orgWorkspace = new OrgWorkspace(orgClient, orgVault);
  const orgTreeProvider = new OrgTreeDataProvider(orgWorkspace);
  const orgTreeView = vscode.window.createTreeView('dbclient.explorer.organization', {
    treeDataProvider: orgTreeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(
    orgTreeView,
    // 登录/登出 → 刷新 dbclient.loggedIn 上下文；登出 → 清组织缓存
    eventBus.subscribe(AuthEvent, (e) => {
      if (e.kind === 'logout') orgWorkspace.clearAuth();
      void syncLoggedInContext(auth);
    }),
  );
  registerOrgCommands({ context, workspace: orgWorkspace, manager, executor, tree: orgTreeProvider });
  // 这里原先用 onDidChangeSelection 往 `dbclient.dbType` / `dbclient.has*` 写
  // context key，供菜单 when 判断数据库类型。那是竞态的：右键未选中项、或右键
  // 与当前选中项不同时，键里还是上一个节点的值 —— 在 SQLite 表上会看到 MySQL
  // 专属命令，该出现的命令反而不出现。
  // 现在数据库类型编码进节点自己的 contextValue（`<base>.<DBTYPE>`，见
  // DbTreeNode），菜单 when 直接匹配 viewItem，不再有任何时序依赖。
  const completionProvider = new SqlCompletionProvider(connCtx, manager);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'sql' },
      completionProvider,
      '.', ' ',
    ),
    vscode.languages.registerCodeLensProvider(
      { language: 'sql' },
      new SqlCodeLensProvider(),
    ),
    // Terminal 集成
    vscode.commands.registerCommand('dbclient.openTerminal', (node: any) => {
      if (node?.conn) TerminalService.open(node.conn, node.database);
    }),
    // 表设计视图
    vscode.commands.registerCommand('dbclient.designTable', async (node: any) => {
      if (node?.conn && node?.database) {
        const session = await manager.connect(node.conn);
        if (!session.capabilities.operations.includes('getTableDefinition')) {
          vscode.window.showWarningMessage('Table design is not supported for this database yet.');
          return;
        }
        void TableDesignView.open(node.conn, node.label, node.database, manager, () => treeProvider.refreshNode(node));
      }
    }),
    // 新建表（webview 表单）：比丢一段 CREATE TABLE 模板到编辑器更直接，
    // 且建完可以接着在同一面板里加列/加索引。
    vscode.commands.registerCommand('dbclient.newTableDesigner', async (node: any) => {
      const database = node?.database ?? node?.conn?.database;
      if (!node?.conn || !database) return;
      void TableDesignView.openNew(node.conn, database, manager, () => treeProvider.refreshNode(node));
    }),
    // Server 状态面板
    vscode.commands.registerCommand('dbclient.serverStatus', (node: any) => {
      if (node?.conn) {
        StatusView.open(node.conn, manager);
      }
    }),
    // ER 图
    vscode.commands.registerCommand('dbclient.showERDiagram', (node: any) => {
      if (node?.conn && node?.database) {
        ERDiagramView.open(node.conn, node.database, manager);
      }
    }),
    // 数据对比
    vscode.commands.registerCommand('dbclient.compareData', async (node: any) => {
      if (!node?.conn || !node?.database) return;
      const session = await manager.connect(node.conn);
      const targetDbs = (await session.metadata.getDatabases()).filter((d: string) => d !== node.database);
      if (!targetDbs.length) {
        vscode.window.showWarningMessage('No other databases to compare.');
        return;
      }
      const target = await vscode.window.showQuickPick(
        targetDbs.map((d: string) => ({ label: d, value: d })),
        { placeHolder: `Compare data of "${node.database}" with which database?` },
      );
      if (!target) return;
      void DataDiffView.open(node.conn, node.database, node.conn, target.value, manager);
    }),
    // 性能仪表盘
    vscode.commands.registerCommand('dbclient.dashboard', (node: any) => {
      if (node?.conn) {
        DashboardView.open(node.conn, manager);
      }
    }),
    // 审计日志
    vscode.commands.registerCommand('dbclient.showAuditLog', () => {
      AuditLogView.open(auditLogger);
    }),
    // 连接池状态
    vscode.commands.registerCommand('dbclient.showPoolStatus', () => {
      PoolStatusView.open(manager);
    }),
    // 定时备份
    vscode.commands.registerCommand('dbclient.scheduleBackup', async (node: any) => {
      if (!node?.conn || !node?.database) return;
      await configureBackupSchedule(backupScheduler, node.conn.id, node.database);
    }),
  );

  // 表结构变更时清除补全缓存
  const origRefresh = treeProvider.refresh.bind(treeProvider);
  treeProvider.refresh = () => {
    completionProvider.invalidate();
    origRefresh();
  };

  registerCommands({ context, store, manager, treeProvider, executor, history, auth, connCtx });
}

/**
 * 把登录态同步到 `dbclient.loggedIn` 上下文键。
 *
 * package.json 的 commandPalette 靠它控制 login / logout / account / sessions
 * 四条命令的可见性，登录/登出后必须重新调用，否则命令面板显示的是旧状态。
 */
export async function syncLoggedInContext(auth: { isLoggedIn(): boolean }): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'dbclient.loggedIn', auth.isLoggedIn());
}

/** 定时备份配置向导：已有计划则提供运行/修改/删除，否则询问周期与输出目录 */
async function configureBackupSchedule(
  scheduler: BackupScheduler,
  connId: string,
  database: string,
): Promise<void> {
  const existing = scheduler.getSchedules().find((s) => s.connId === connId && s.database === database);
  if (existing) {
    const action = await vscode.window.showQuickPick(
      [
        { label: 'Run Backup Now', value: 'run' },
        { label: 'Change Schedule', value: 'change' },
        { label: 'Remove Schedule', value: 'remove' },
      ],
      { placeHolder: `"${database}" backs up every ${Math.round(existing.intervalMs / 3600000)}h to ${existing.outputDir}` },
    );
    if (!action) return;
    if (action.value === 'run') {
      await scheduler.runNow(connId, database);
      return;
    }
    if (action.value === 'remove') {
      scheduler.removeSchedule(connId, database);
      vscode.window.showInformationMessage(`Backup schedule removed for "${database}".`);
      return;
    }
  }

  const interval = await vscode.window.showQuickPick(
    [
      { label: 'Every hour', value: 3600000 },
      { label: 'Every 6 hours', value: 6 * 3600000 },
      { label: 'Every day', value: 24 * 3600000 },
      { label: 'Every week', value: 7 * 24 * 3600000 },
    ],
    { placeHolder: `How often should "${database}" be backed up?` },
  );
  if (!interval) return;

  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select backup folder',
    defaultUri: existing ? vscode.Uri.file(existing.outputDir) : undefined,
  });
  if (!folders?.length) return;

  const includeData = await vscode.window.showQuickPick(
    [
      { label: 'Schema and data', value: true },
      { label: 'Schema only', value: false },
    ],
    { placeHolder: 'What should the dump contain?' },
  );
  if (!includeData) return;

  scheduler.addSchedule(connId, database, interval.value, folders[0].fsPath, includeData.value);
  vscode.window.showInformationMessage(
    `"${database}" will be backed up ${interval.label.toLowerCase()} to ${folders[0].fsPath}.`,
  );
}

export function deactivate(): void {
  // cleanup handled by context.subscriptions; empty body is safe
}
