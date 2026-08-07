import * as vscode from 'vscode';
import { DatabaseType } from '@db-client/core';
import { ConnectionStore, SavedConnection } from './connection/connectionStore';
import { ConnectionManager } from './connection/connectionManager';
import { ConnectionForm } from './connection/connectionForm';
import { DbTreeDataProvider } from './tree/dbTreeDataProvider';
import { DbTreeNode, NodeKind } from './tree/dbTreeNode';
import { QueryExecutor } from './result/queryExecutor';
import { AuthService } from './sync/authService';
import { SyncManager } from './sync/syncManager';
import { HistoryStore } from './history/historyStore';
import { formatSql } from './format/sqlFormatter';
import { l10n, invalidateLanguage, LANGUAGE_CONFIG_KEY } from './i18n';

/**
 * 扩展激活入口。
 * 注册连接树视图、新增连接、运行查询、表预览、同步与格式化命令。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new ConnectionStore(context.globalState);
  const manager = new ConnectionManager();
  const treeProvider = new DbTreeDataProvider(store, manager);
  const history = new HistoryStore(context.globalState);
  const executor = new QueryExecutor(manager, history);

  // 同步服务
  const serverUrl = AuthService.getServerUrl(vscode.workspace.getConfiguration());
  const auth = new AuthService(context.secrets, serverUrl);
  await auth.init();
  const sync = new SyncManager(auth, store);
  const syncBar = new SyncStatusBar(auth);

  // 语言设置变更时失效缓存
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(LANGUAGE_CONFIG_KEY)) {
        invalidateLanguage();
      }
    }),
  );

  // 注册连接树视图
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dbclient.explorer', treeProvider),
  );

  // 新增连接命令：打开连接表单 webview
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.addConnection', () => {
      ConnectionForm.open(store);
    }),
  );

  // 连接树下拉菜单：汇聚其余操作
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.explorerMenu', async () => {
      await explorerMenu(auth, sync, treeProvider, store, syncBar);
    }),
  );

  // 刷新命令
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.refresh', () => treeProvider.refresh()),
  );

  // 运行查询命令：在活动编辑器里执行（选中或整段）SQL
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.runQuery', async () => {
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
    }),
  );

  // 表节点双击：预览前 100 行数据
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.previewTable', async (node) => {
      if (!node?.conn) return;
      const sql = `SELECT * FROM ${node.conn.dbType === DatabaseType.MYSQL ? '`' + node.label + '`' : '"' + node.label + '"'} LIMIT 100`;
      await executor.run(node.conn, sql);
    }),
  );

  // 格式化 SQL：替换活动编辑器选中/整段内容
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.formatSql', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const range = editor.selection.isEmpty
        ? new vscode.Range(0, 0, editor.document.lineCount - 1, 0)
        : editor.selection;
      const sql = editor.document.getText(range);
      const formatted = formatSql(sql);
      await editor.edit((edit) => edit.replace(range, formatted));
    }),
  );

  // 查看查询历史
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.showHistory', async () => {
      const list = history.list();
      if (list.length === 0) {
        vscode.window.showInformationMessage(l10n('cmd.noHistory'));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        list.map((h) => ({
          label: h.sql.replace(/\s+/g, ' ').slice(0, 60),
          detail: `${h.connection} · ${h.rowCount ?? 0} rows · ${h.costTime}ms`,
          value: h,
        })),
        { placeHolder: 'Query history (click to reopen)' },
      );
      if (picked) {
        const doc = await vscode.workspace.openTextDocument({
          content: picked.value.sql,
          language: 'sql',
        });
        await vscode.window.showTextDocument(doc);
      }
    }),
  );

  // 单元格编辑：更新指定表某行某列
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dbclient.updateCell',
      async (args: {
        conn: SavedConnection;
        table: string;
        primaryKey: string;
        rowId: any;
        column: string;
        value: any;
      }) => {
        try {
          const session = await manager.connect(args.conn);
          await session.data.updateCell(
            args.table,
            args.primaryKey,
            args.rowId,
            args.column,
            args.value,
          );
          vscode.window.showInformationMessage(l10n('cmd.updated', { table: args.table, column: args.column }));
        } catch (err) {
          vscode.window.showErrorMessage((err as Error).message);
        }
      },
    ),
  );

  // 新建分组成员组
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dbclient.addGroup',
      async (node?: DbTreeNode) => {
        const name = await vscode.window.showInputBox({ prompt: l10n('tree.addGroup') });
        if (!name) return;
        const parentId =
          node?.kind === NodeKind.Group ? node.groupId : undefined;
        await store.addGroup(name, parentId);
        treeProvider.refresh();
      },
    ),
  );

  // 重命名分组
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dbclient.renameGroup',
      async (node: DbTreeNode) => {
        const name = await vscode.window.showInputBox({
          prompt: 'Group name',
          value: node.label,
        });
        if (!name || name === node.label) return;
        await store.renameGroup(node.groupId!, name);
        treeProvider.refresh();
      },
    ),
  );

  // 删除分组
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dbclient.removeGroup',
      async (node: DbTreeNode) => {
        const ok = await vscode.window.showWarningMessage(
          l10n('tree.deleteGroupTitle', { name: node.label }),
          { modal: true },
          l10n('tree.deleteGroupConfirm'),
        );
        if (ok !== l10n('tree.deleteGroupConfirm')) return;
        await store.removeGroup(node.groupId!);
        treeProvider.refresh();
      },
    ),
  );

  // 将连接移动到指定分组
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dbclient.moveToGroup',
      async (node: DbTreeNode) => {
        if (!node?.conn) return;
        const data = store.getTreeData();
        const choices = [
          { label: '$(close) ' + l10n('tree.ungroup'), target: undefined as string | undefined },
          ...data.groups.map((g) => ({ label: g.name, target: g.id })),
        ];
        const picked = await vscode.window.showQuickPick(choices, {
          placeHolder: 'Move connection to group',
        });
        if (picked === undefined) return;
        await store.moveToGroup(node.conn.id, picked.target);
        treeProvider.refresh();
      },
    ),
  );

  // 注册退出清理
  context.subscriptions.push({ dispose: () => manager.disposeAll() });

  // ===== 同步命令 =====
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.login', async () => {
      await loginOrRegister(auth, sync, treeProvider, syncBar);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.logout', async () => {
      await auth.logout();
      syncBar.update();
      vscode.window.showInformationMessage(l10n('cmd.loggedOut'));
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.syncPull', async () => {
      const masterPassword = await promptMasterPassword();
      if (!masterPassword) return;
      await sync.pull(masterPassword);
      treeProvider.refresh();
      vscode.window.showInformationMessage(l10n('cmd.pullDone'));
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.syncPush', async () => {
      const masterPassword = await promptMasterPassword();
      if (!masterPassword) return;
      await sync.push(masterPassword);
      vscode.window.showInformationMessage(l10n('cmd.pushDone'));
    }),
  );
}

/**
 * 登录或注册流程。
 */
async function loginOrRegister(
  auth: AuthService,
  sync: SyncManager,
  treeProvider: DbTreeDataProvider,
  syncBar: SyncStatusBar,
): Promise<void> {
  const mode = await vscode.window.showQuickPick(
    [
      { label: 'Login', value: 'login' },
      { label: 'Register', value: 'register' },
    ],
    { placeHolder: 'Login or register new account' },
  );
  if (!mode) return;

  const email = await vscode.window.showInputBox({ prompt: 'Email' });
  if (!email) return;
  const password = await vscode.window.showInputBox({
    prompt: 'Password (min 8 chars)',
    password: true,
  });
  if (!password) return;

  try {
    if (mode.value === 'register') {
      await auth.register(email, password);
      vscode.window.showInformationMessage(l10n('cmd.registered'));
    } else {
      await auth.login(email, password);
      vscode.window.showInformationMessage(l10n('cmd.loggedIn'));
    }
    syncBar.update();
    // 登录后提示可选拉取
    const doPull = await vscode.window.showQuickPick(
      [ { label: l10n('cmd.yes'), value: true }, { label: l10n('cmd.no'), value: false } ],
      { placeHolder: l10n('cmd.pullNow') },
    );
    if (doPull?.value) {
      const mp = await promptMasterPassword();
      if (mp) {
        await sync.pull(mp);
        treeProvider.refresh();
      }
    }
  } catch (err) {
    vscode.window.showErrorMessage((err as Error).message);
  }
}

/** 输入主密码（用于加密/解密同步数据） */
async function promptMasterPassword(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: l10n('cmd.masterPassword'),
    password: true,
  });
}

/**
 * 状态栏指示器：显示登录状态。
 */
class SyncStatusBar {
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
        this.item.text = `$(cloud) ${email || 'synced'}`;
        this.item.tooltip = 'Click to logout';
        this.item.command = 'dbclient.logout';
      });
    } else {
      this.item.text = '$(cloud) Not logged in';
      this.item.tooltip = 'Click to login';
      this.item.command = 'dbclient.login';
    }
  }
}

/** 连接树下拉菜单：汇聚添加分组、同步、历史等操作 */
async function explorerMenu(
  auth: AuthService,
  sync: SyncManager,
  treeProvider: DbTreeDataProvider,
  store: ConnectionStore,
  syncBar: SyncStatusBar,
): Promise<void> {
  const loggedIn = auth.isLoggedIn();
  const items: (vscode.QuickPickItem & { value: string })[] = [
    { label: '$(add) New Group', description: 'Create a connection group', value: 'addGroup' },
    { label: '$(cloud-download) Pull from Cloud', description: 'Download & merge remote data', value: 'pull' },
    { label: '$(cloud-upload) Push to Cloud', description: 'Upload local data', value: 'push' },
    { label: '$(history) Query History', description: 'View recent queries', value: 'history' },
    loggedIn
      ? { label: '$(sign-out) Logout', description: 'Sign out', value: 'logout' }
      : { label: '$(sign-in) Login / Register', description: 'Sign in to sync', value: 'login' },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'DB Client actions',
  });
  if (!picked) return;

  switch (picked.value) {
    case 'addGroup': {
      const name = await vscode.window.showInputBox({ prompt: l10n('tree.addGroup') });
      if (name) {
        await store.addGroup(name);
        treeProvider.refresh();
      }
      break;
    }
    case 'pull': {
      const mp = await promptMasterPassword();
      if (mp) {
        await sync.pull(mp);
        treeProvider.refresh();
        vscode.window.showInformationMessage(l10n('cmd.pullDone'));
      }
      break;
    }
    case 'push': {
      const mp = await promptMasterPassword();
      if (mp) {
        await sync.push(mp);
        vscode.window.showInformationMessage(l10n('cmd.pushDone'));
      }
      break;
    }
    case 'history':
      await vscode.commands.executeCommand('dbclient.showHistory');
      break;
    case 'login':
      await loginOrRegister(auth, sync, treeProvider, syncBar);
      break;
    case 'logout':
      await auth.logout();
      syncBar.update();
      vscode.window.showInformationMessage(l10n('cmd.loggedOut'));
      break;
  }
}

/** 弹出已保存连接供选择 */
async function pickConnection(store: ConnectionStore): Promise<SavedConnection | undefined> {
  const list = store.list();
  if (list.length === 0) {
    vscode.window.showInformationMessage(l10n('cmd.noConnection'));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.name || c.host, detail: c.host, value: c })),
    { placeHolder: l10n('cmd.selectConnection') },
  );
  return picked?.value;
}

/**
 * 收集连接配置并保存。
 * 目前仅支持 MySQL 完整表单，其余类型后续扩展。
 */
/** 扩展退出入口 */
export function deactivate(): void {}