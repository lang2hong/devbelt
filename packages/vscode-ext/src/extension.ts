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
import { HistoryStore } from './history/historyStore';
import { AuthService } from './sync/authService';
import { requireFeature, Feature } from './sync/features';
import { SyncManager } from './sync/syncManager';
import { MasterPasswordStore } from './sync/masterPasswordStore';
import { AutoSyncService, type AutoSyncMode } from './sync/autoSyncService';
import type { Event } from './utils/event';
import { eventBus, ConnectionChangedEvent } from './utils/event';
import { invalidateLanguage, LANGUAGE_CONFIG_KEY, l10n } from './i18n';
import { registerCommands, SyncStatusBar } from './commands';
import { DialectRegistry } from '@db-client/core';
import { SqlCompletionProvider } from './completion/sqlCompletionProvider';
import { SqlCodeLensProvider } from './completion/sqlCodeLensProvider';
import { TerminalService } from './terminal/terminalService';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new ConnectionStore(context.globalState, context.secrets);
  await store.init();
  const manager = new ConnectionManager();
  const treeProvider = new DbTreeDataProvider(store, manager);
  const history = new HistoryStore(context.globalState);
  const executor = new QueryExecutor(manager, history);
  const connCtx = new ConnectionContext(context, store);

  BaseWebView.init(context.extensionUri);
  TableQueryView.init(context.extensionUri);

  // 同步服务
  const serverUrl = AuthService.getServerUrl(vscode.workspace.getConfiguration());
  const auth = new AuthService(context.secrets, serverUrl);
  await auth.init();
  const masterPasswordStore = new MasterPasswordStore(context.secrets);
  const sync = new SyncManager(auth, store, history, context.globalState, masterPasswordStore);
  const syncBar = new SyncStatusBar(auth, () => sync.getLastSyncAt());

  // 自动同步：合并连接/查询 与 历史 的变更事件
  const storeChanged: Event<void> = (listener) => {
    const d1 = store.onChanged(listener);
    const d2 = history.onChanged(listener);
    return { dispose: () => { d1.dispose(); d2.dispose(); } };
  };
  const autoSync = new AutoSyncService(
    sync,
    () => vscode.workspace.getConfiguration('dbclient.sync').get<AutoSyncMode>('auto', 'off'),
    () => vscode.workspace.getConfiguration('dbclient.sync').get<number>('intervalMin', 0),
    storeChanged,
    () => {
      void vscode.window
        .showInformationMessage(l10n('cmd.syncPending'), l10n('cmd.syncNow'))
        .then((ch) => {
          if (ch === l10n('cmd.syncNow')) void vscode.commands.executeCommand('dbclient.syncPush');
        });
    },
    () => syncBar.update(),
    () => auth.isLoggedIn(),
  );
  autoSync.start();
  context.subscriptions.push(autoSync);

  // 事件总线：连接/分组变更时自动刷新树（同步 pull 等无命令处理器的场景）
  context.subscriptions.push(
    eventBus.subscribe(ConnectionChangedEvent, () => treeProvider.refresh()),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dbclient.sync')) autoSync.restart();
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
  treeView.onDidChangeSelection((e) => {
    const node = e.selection[0];
    const dbType = node?.conn?.dbType;
    if (dbType) {
      void vscode.commands.executeCommand('setContext', 'dbclient.dbType', dbType);
      const caps = DialectRegistry.get(dbType).capabilities;
      void vscode.commands.executeCommand('setContext', 'dbclient.hasRoutines', caps.routines);
      void vscode.commands.executeCommand('setContext', 'dbclient.hasEvents', caps.events);
      void vscode.commands.executeCommand('setContext', 'dbclient.hasUsers', caps.users);
      void vscode.commands.executeCommand('setContext', 'dbclient.hasViews', caps.views);
      void vscode.commands.executeCommand('setContext', 'dbclient.hasMultiDatabase', caps.multiDatabaseExplorer);
    }
  });
  context.subscriptions.push(treeView);
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
    // Server 状态面板
    vscode.commands.registerCommand('dbclient.serverStatus', (node: any) => {
      if (node?.conn) {
        StatusView.open(node.conn, manager);
      }
    }),
    // ER 图
    vscode.commands.registerCommand('dbclient.showERDiagram', async (node: any) => {
      if (node?.conn && node?.database) {
        if (!await requireFeature(auth, Feature.er_export)) return;
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
  );

  // 表结构变更时清除补全缓存
  const origRefresh = treeProvider.refresh.bind(treeProvider);
  treeProvider.refresh = () => {
    completionProvider.invalidate();
    origRefresh();
  };

  registerCommands({ context, store, manager, treeProvider, executor, history, auth, sync, syncBar, connCtx });
}

export function deactivate(): void {}
