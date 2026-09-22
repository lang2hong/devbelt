import * as vscode from 'vscode';
import { ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import { ConnectionManager } from './connection/connectionManager';
import { ConnectionPathOverrideStore } from './connection/connectionPathOverrideStore';
import { ConnectionContext } from './connection/connectionContext';
import { DbTreeDataProvider } from './tree/dbTreeDataProvider';
import { QueryExecutor } from './result/queryExecutor';
import { BaseWebView } from './result/baseWebView';
import { TableQueryView } from './result/tableQueryView';
import { AuditLogger } from './utils/auditLogger';
import { diagDispose, diagInfo, diagWarn, diagError } from './utils/diagnostics';
import { BackupScheduler } from './schedule/backupScheduler';
import { registerViewCommands } from './commands/viewCommands';
import { createSyncStatusBar } from './sync/syncStatusBar';
import { HistoryStore } from './history/historyStore';
import { AuthService, DEFAULT_SERVER_URL } from './sync/authService';
import { PersonalSyncClient } from '@devbelt/db-host/sync/e2e/client';
import { eventBus, ConnectionChangedEvent, DataChangeEvent, AuthEvent } from '@devbelt/db-host/utils/event';
import { invalidateLanguage, l10n, LANGUAGE_CONFIG_KEY } from './i18n';
import { registerCommands } from './commands';
import { SqlCompletionProvider } from './completion/sqlCompletionProvider';
import { SqlCodeLensProvider } from './completion/sqlCodeLensProvider';
import { OrgClient } from './org/client';
import { CredentialVault } from './org/credentialVault';
import { OrgWorkspace } from './org/workspace';
import { OrgTreeDataProvider } from './tree/orgTreeDataProvider';
import { registerOrgCommands } from './commands/org';
import { SyncSessionFactory } from '@devbelt/db-host/sync/sessionFactory';
import { DekStore } from '@devbelt/db-host/sync/crypto/keyStore';

import { registerPersonalSyncCommands } from './commands/personalSync';
import { registerConflictCommands } from './commands/syncConflicts';
import { registerSyncLifecycleCommands, registerSyncResetUriHandler } from './commands/syncLifecycle';
import { SshTunnel } from './connection/sshTunnel';
import { AuthenticatorStore } from './authenticator/store';
import { AuthenticatorViewProvider } from './authenticator/authenticatorViewProvider';
import { AuthenticatorChangedEvent } from './authenticator/events';

/** 自动同步开关（按机器）：默认关闭，仅显式开启后才自动同步。 */
const SYNC_AUTO_SYNC_KEY = 'devbelt.sync.autoSync';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new ConnectionStore(context.globalState, context.secrets);
  context.subscriptions.push({ dispose: () => store.dispose() });
  await store.init();
  const serverUrl = DEFAULT_SERVER_URL;
  const auth = new AuthService(context.secrets, serverUrl, context.globalState);
  const history = new HistoryStore(context.globalState);
  // 本机路径覆盖（B3）：仅存本机 globalState、不回传、不产生 mutation/同步事件。
  const overrideStore = new ConnectionPathOverrideStore(context.globalState);
  // history 注入管理器：所有会话的修改性语句由此自动进历史，
  // 不再依赖各命令自行调用 history.add（漏一个就少一段痕迹）。
  // resolveEffective 是建连/路径校验的单一有效配置入口（覆盖优先）。
  const manager = new ConnectionManager(undefined, history, (c) => overrideStore.applyOverrides(c));
  const treeProvider = new DbTreeDataProvider(store, manager, overrideStore);
  const auditLogger = AuditLogger.init(context.globalState);
  const executor = new QueryExecutor(manager, history, auditLogger);
  const connCtx = new ConnectionContext(context, store);

  // SSH 主机密钥裁决：tofu（默认）对未知主机弹指纹确认并写入插件自管 known_hosts；
  // strict 只信任既有 known_hosts。密钥不匹配/revoked 由 gate 硬失败。
  SshTunnel.configureHostKeyGate({
    policy: () => (vscode.workspace.getConfiguration('devbelt').get<string>('ssh.hostKeyPolicy') === 'strict' ? 'strict' : 'tofu'),
    storeFile: vscode.Uri.joinPath(context.globalStorageUri, 'ssh_known_hosts').fsPath,
    prompt: async (host, port, fingerprint, keyType) => {
      const target = port === 22 ? host : `${host}:${port}`;
      const trust = l10n('ssh.hostKey.trust');
      const trustOnce = l10n('ssh.hostKey.trustOnce');
      const answer = await vscode.window.showWarningMessage(
        l10n('ssh.hostKey.unknown', { host: target, keyType, fingerprint }),
        { modal: true },
        trust,
        trustOnce,
      );
      if (answer === trust) return true;
      if (answer === trustOnce) return 'once';
      return false;
    },
  });

  // 定时备份：从 globalState 恢复已保存的计划
  const backupScheduler = new BackupScheduler(manager, store, context.globalState);
  backupScheduler.start();
  context.subscriptions.push(backupScheduler);

  BaseWebView.init(context.extensionUri);
  TableQueryView.init(context.extensionUri);

  // AuthService 订阅了 SecretStorage 变更（多窗口 token 同步），必须随扩展一起释放
  context.subscriptions.push(auth);
  await auth.init();
  // package.json 的 commandPalette 用 devbelt.loggedIn 控制 login/logout/account/sessions
  // 的可见性。此前从未及时 setContext，导致 logout/account/sessions 永久不可见、login 永久可见；
  // AuthEvent 订阅（下方）在登录/登出后刷新此上下文保持同步。
  void syncLoggedInContext(auth);

  // P5：TOTP 验证器——store 先 await init() 完成 secretCache 预热，再建 provider / 注册命令。
  const authStore = new AuthenticatorStore(context.globalState, context.secrets, auth, {
    info: diagInfo, warn: diagWarn, error: diagError,
  });
  context.subscriptions.push({ dispose: () => authStore.dispose() });
  // init 设计为不抛（逐条失败只标记 missingSecrets）；这里兜底，避免极端异常导致整个扩展激活失败。
  try {
    await authStore.init();
  } catch (err) {
    diagError('authenticator store init failed', String(err));
  }
  // store 先于 provider push：反序 dispose 时 provider 先销毁，避免 tick 回调访问已 dispose 的 store。
  const authViewProvider = new AuthenticatorViewProvider(context.extensionUri, authStore);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('devbelt.tools.authenticator', authViewProvider),
    { dispose: () => authViewProvider.dispose() },
    // 条目/分组/标签变更 → 重发快照给侧边栏。
    eventBus.subscribe(AuthenticatorChangedEvent, () => void authViewProvider.refresh()),
  );

  // 事件总线：连接/分组变更时自动刷新树 + 重算路径 warning
  context.subscriptions.push(
    eventBus.subscribe(ConnectionChangedEvent, () => void treeProvider.refreshPathIssues()),
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

  const treeView = vscode.window.createTreeView('devbelt.explorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView, treeProvider);

  // 组织 Workspace 使用独立数据源，与个人连接树和同步完全分离。
  const orgClient = new OrgClient(auth.client);
  const orgVault = new CredentialVault(context.secrets, context.globalState);
  const orgWorkspace = new OrgWorkspace(orgClient, orgVault);
  const orgTreeProvider = new OrgTreeDataProvider(orgWorkspace);
  context.subscriptions.push(orgTreeProvider);
  const orgTreeView = vscode.window.createTreeView('devbelt.explorer.organization', {
    treeDataProvider: orgTreeProvider,
    showCollapseAll: true,
  });

  // 当前 workspace 角色 → devbelt.orgRole context（驱动 commandPalette / view-title 门控）。
  const syncOrgRoleContext = (): void => {
    const ws = orgWorkspace.workspace;
    const role = ws.kind === 'organization' ? ws.role : undefined;
    void vscode.commands.executeCommand('setContext', 'devbelt.orgRole', role);
  };

  context.subscriptions.push(
    orgTreeView,
    // 登录/登出 → 刷新 devbelt.loggedIn；登录 → 选默认组织；登出 → 清认证/凭据/role。
    eventBus.subscribe(AuthEvent, async (e) => {
      if (e.kind === 'login') {
        await orgWorkspace.selectDefaultOrg();
      } else {
        // 登出：等待凭据清理完成后才宣告完成，保证「登出即清空」。
        await orgWorkspace.clearAuth();
        void vscode.commands.executeCommand('setContext', 'devbelt.orgRole', undefined);
        orgTreeProvider.refresh();
      }
      void syncLoggedInContext(auth);
    }),
    // workspace 变更（登录默认组织/成员角色变更/登出）→ 同步 role context。
    orgWorkspace.onDidChange(() => syncOrgRoleContext()),
    // 树选择仅同步角色（silent，不触发缓存失效），需单独订阅 onRoleChanged 同步 role context。
    orgWorkspace.onRoleChanged(() => syncOrgRoleContext()),
    // 会话过期：弹「登录已过期」并清 role context（主动 logout 不经此路径）。
    orgWorkspace.onAuthFailure(() => {
      vscode.window.showErrorMessage(l10n('org.error.authExpired'));
      void vscode.commands.executeCommand('setContext', 'devbelt.orgRole', undefined);
    }),
    // 点击树中任一带 orgId+role 的节点 → 以 silent 方式同步该组织为当前工作组织，
    // 使 commandPalette/view-title 的 role 与当前工作组织一致；不触发 changed（避免全树
    // 刷新导致展开状态塌缩）。右键菜单仍只依赖节点自身 viewItem role。
    orgTreeView.onDidChangeSelection((e) => {
      const node = e.selection[0];
      if (node && node.orgId && node.role && node.kind !== 'info') {
        orgWorkspace.select({ kind: 'organization', organizationId: node.orgId, role: node.role }, { silent: true });
      }
    }),
  );
  registerOrgCommands({ context, workspace: orgWorkspace, manager, executor, tree: orgTreeProvider });
  // 扩展重启后仍处于登录态：恢复默认组织选择（AuthService.init 不会重发 login 事件）。
  if (auth.isLoggedIn()) void orgWorkspace.selectDefaultOrg();

  // 受控同步 session 工厂（阶段 A 无 UI）：activation/locked 态零请求，仅经工厂懒建。
  // 阶段 B 才接入初始化/解锁命令；此处只挂生命周期：logout → 丢弃 session，dispose → 清理。
  // ===== B2：状态栏 + 立即同步命令 + 窗口聚焦触发 =====
  // 自动同步开关按机器生效（读配置，实时判定）；关闭时不自动同步（含解锁首同步），仅显式命令触发。
  const isAutoSyncEnabled = (): boolean =>
    vscode.workspace.getConfiguration().get<boolean>(SYNC_AUTO_SYNC_KEY, false);

  const syncStatusBar = createSyncStatusBar(context, auth, () => syncFactory.current, isAutoSyncEnabled);

  const syncFactory = new SyncSessionFactory({
    connectionStore: store,
    dekStore: new DekStore(context.secrets),
    memento: context.globalState,
    getUserId: async () => (auth.isLoggedIn() ? auth.getUserId() : undefined),
    entitlement: () => auth.getCachedEntitlement(),
    autoSyncEnabled: isAutoSyncEnabled,
    onSyncResult: (result) => {
      // 入站 pull 应用了变更才刷树（避免每次空同步都整树刷新），并重算路径 warning；
      // 其余情况仅刷新状态栏。
      if (result && result.applied > 0) void treeProvider.refreshPathIssues();
      syncStatusBar.refresh();
    },
    onSessionState: () => syncStatusBar.refresh(),
    createClient: () => new PersonalSyncClient(auth.client),
  });
  context.subscriptions.push({ dispose: () => syncFactory.dispose() });
  const onAuthChange = eventBus.subscribe(AuthEvent, (e) => {
    if (e.kind === 'logout') syncFactory.invalidate();
    syncStatusBar.refresh();
  });
  context.subscriptions.push(onAuthChange);
  // 窗口聚焦补同步（后台、无提示）。显式「立即同步」命令在 personalSync 注册并反馈结果。
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (!e.focused) return;
      // 自动同步关闭时不因切窗触发同步（手动命令仍可用）。
      if (!isAutoSyncEnabled()) return;
      const session = syncFactory.current;
      // stalled 后跳过自动聚焦同步，避免冲突/终止性错误在切窗时被反复自动重发；
      // 用户仍可通过 devbelt.syncNow 手动重试。
      if (!session?.isUnlocked || session.stalled) return;
      session.scheduleNow();
    }),
  );
  // 自动同步开关：命令切换 + 配置变更即时生效（开启时补一次，关闭时停止自动触发）。
  context.subscriptions.push(
    vscode.commands.registerCommand('devbelt.toggleAutoSync', async () => {
      const config = vscode.workspace.getConfiguration();
      const next = !config.get<boolean>(SYNC_AUTO_SYNC_KEY, false);
      await config.update(SYNC_AUTO_SYNC_KEY, next, vscode.ConfigurationTarget.Global);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SYNC_AUTO_SYNC_KEY)) return;
      syncStatusBar.refresh();
      if (!isAutoSyncEnabled()) return;
      const session = syncFactory.current;
      if (session?.isUnlocked && !session.stalled) session.scheduleNow();
    }),
  );
  // B1 是用户显式入口；注册本身不建 session，命令执行前才刷新权益并懒建。
  registerPersonalSyncCommands(context, auth, syncFactory);
  // B4 冲突面板。
  registerConflictCommands(context, syncFactory);
  // B5 生命周期：换钥 / 恢复 / 销毁 / 重置。
  registerSyncLifecycleCommands(context, auth, syncFactory);
  // 切片 5：sync-reset 深链 UriHandler（浏览器 handoff → 扩展最终 reset）。
  registerSyncResetUriHandler(context, auth, syncFactory);
  // 这里原先用 onDidChangeSelection 往 `devbelt.dbType` / `devbelt.has*` 写
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
      new SqlCodeLensProvider(
        (uri) => connCtx.getForDoc(uri)?.conn.dbType,
        (uri) => {
          const conn = connCtx.getForDoc(uri)?.conn;
          return conn ? manager.scanOptionsFor?.(conn) : undefined;
        },
      ),
    ),
  );

  registerViewCommands({ context, manager, treeProvider, auth, backupScheduler, auditLogger });

  // 表结构变更时清除补全缓存（事件订阅，替代对 treeProvider.refresh 的猴补丁）。
  context.subscriptions.push(treeProvider.onDidRefresh(() => completionProvider.invalidate()));

  registerCommands({ context, store, manager, treeProvider, overrideStore, executor, history, auth, connCtx, syncFactory, authStore, authViewProvider });

  // 首次加载即异步重算路径 warning（仅本地 fs 校验，无同步/网络请求）。
  void treeProvider.refreshPathIssues();
}

/**
 * 把登录态同步到 `devbelt.loggedIn` 上下文键。
 *
 * package.json 的 commandPalette 靠它控制 login / logout / account / sessions
 * 四条命令的可见性，登录/登出后必须重新调用，否则命令面板显示的是旧状态。
 */
export async function syncLoggedInContext(auth: { isLoggedIn(): boolean }): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'devbelt.loggedIn', auth.isLoggedIn());
}

export function deactivate(): void {
  // 释放诊断输出通道（否则扩展卸载/重载后旧的 OutputChannel 句柄不会回收）。
  diagDispose();
}
