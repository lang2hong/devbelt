import * as vscode from 'vscode';
import { ConnectionStore } from './connection/connectionStore';
import { ConnectionManager } from './connection/connectionManager';
import { ConnectionContext } from './connection/connectionContext';
import { DbTreeDataProvider } from './tree/dbTreeDataProvider';
import { QueryExecutor } from './result/queryExecutor';
import { TableQueryView } from './result/tableQueryView';
import { TableDesignView } from './result/tableDesignView';
import { StatusView } from './result/statusView';
import { ERDiagramView } from './result/erDiagramView';
import { HistoryStore } from './history/historyStore';
import { AuthService } from './sync/authService';
import { SyncManager } from './sync/syncManager';
import { invalidateLanguage, LANGUAGE_CONFIG_KEY } from './i18n';
import { registerCommands, SyncStatusBar } from './commands';
import { SqlCompletionProvider } from './completion/sqlCompletionProvider';
import { SqlCodeLensProvider } from './completion/sqlCodeLensProvider';
import { TerminalService } from './terminal/terminalService';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new ConnectionStore(context.globalState);
  const manager = new ConnectionManager();
  const treeProvider = new DbTreeDataProvider(store, manager);
  const history = new HistoryStore(context.globalState);
  const executor = new QueryExecutor(manager, history);
  const connCtx = new ConnectionContext(context, store);

  // Vue webview 初始化
  TableQueryView.init(context.extensionUri);
  TableDesignView.init(context.extensionUri);
  StatusView.init(context.extensionUri);
  ERDiagramView.init(context.extensionUri);

  // 同步服务
  const serverUrl = AuthService.getServerUrl(vscode.workspace.getConfiguration());
  const auth = new AuthService(context.secrets, serverUrl);
  await auth.init();
  const sync = new SyncManager(auth, store);
  const syncBar = new SyncStatusBar(auth);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(LANGUAGE_CONFIG_KEY)) invalidateLanguage();
    }),
    vscode.window.registerTreeDataProvider('dbclient.explorer', treeProvider),
    vscode.languages.registerCompletionItemProvider(
      { language: 'sql' },
      new SqlCompletionProvider(store, manager),
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
    vscode.commands.registerCommand('dbclient.designTable', (node: any) => {
      if (node?.conn && node?.database) {
        void TableDesignView.open(node.conn, node.label, node.database, manager);
      }
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
  );

  registerCommands({ context, store, manager, treeProvider, executor, history, auth, sync, syncBar, connCtx });
}

export function deactivate(): void {}
