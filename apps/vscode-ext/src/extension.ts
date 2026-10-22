import * as vscode from 'vscode';
import { ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import { applyQueryTimeoutFromConfig } from './utils/sqlTimeout';
import { ConnectionManager } from './connection/connectionManager';
import { ConnectionPathOverrideStore } from './connection/connectionPathOverrideStore';
import { ConnectionContext } from './connection/connectionContext';
import { DbTreeDataProvider } from './tree/dbTreeDataProvider';
import type { DbTreeNode } from './tree/dbTreeNode';
import { ConnectionDecorationProvider } from './tree/connectionDecorationProvider';
import { QueryExecutor } from './result/queryExecutor';
import { BaseWebView } from './result/baseWebView';
import { TableQueryView } from './result/tableQueryView';
import { AuditLogger } from './utils/auditLogger';
import { ElasticsearchView } from './result/elasticsearchView';
import { clearEsRequestLog } from './result/esRequestLogStore';
import { EsDslStore } from './result/esDslStore';
import { diagDispose, diagInfo, diagWarn, diagError } from './utils/diagnostics';
import { installUnhandledRejectionGuard } from './utils/unhandledRejectionGuard';
import { createUnmappedNodeReporter, type UnmappedNodeReporter } from './connection/redisTopology';
import { purgeLegacyOrgCredentials } from './utils/legacyOrgCleanup';
import { ToolsViewProvider } from './tools/toolsView';
import { FeedbackViewProvider } from './feedback/feedbackView';
import { BackupScheduler } from './schedule/backupScheduler';
import { registerViewCommands } from './commands/viewCommands';
import { AiKeyStore } from './ai/aiKeyStore';
import { AiContextStore } from './ai/aiContextStore';
import { AiSessionStore } from './ai/aiSessionStore';
import { AiService } from './ai/aiService';
import { AiChatView, type AiChatViewDeps } from './result/aiChatView';
import { registerAiCommands } from './commands/aiChat';
import { registerAiEditorCommands } from './commands/aiEditor';
import { AiSchemaContextBuilder } from './ai/schemaContext';
import { AiStatusBar } from './ai/aiStatusBar';
import { AiSqlRegistry } from './ai/aiSqlRegistry';
import { AiBridge } from './ai/aiBridge';
import { registerAiInlineProvider } from './completion/aiInlineProvider';
import { createSyncStatusBar } from './sync/syncStatusBar';
import { createAuthStatusBar } from './sync/authStatusBar';
import { HistoryStore, clampHistoryLimit } from './history/historyStore';
import { SqlDiagnosticsProvider } from './diagnostics/sqlDiagnosticsProvider';
import { AuthService, DEFAULT_SERVER_URL } from './sync/authService';
import { PersonalSyncClient } from '@devbelt/db-host/sync/e2e/client';
import { eventBus, ConnectionChangedEvent, DataChangeEvent, AuthEvent } from '@devbelt/db-host/utils/event';
import { invalidateLanguage, l10n, LANGUAGE_CONFIG_KEY } from './i18n';
import { registerCommands } from './commands';
import { setTreeSelectionProvider } from './commands/shared';
import { SqlCompletionProvider } from './completion/sqlCompletionProvider';
import { SqlCodeLensProvider } from './completion/sqlCodeLensProvider';
import { SyncSessionFactory } from '@devbelt/db-host/sync/sessionFactory';
import type { SyncEntityType } from '@devbelt/db-host/sync/e2e/syncEntity';
import { DekStore } from '@devbelt/db-host/sync/crypto/keyStore';

import { registerPersonalSyncCommands } from './commands/personalSync';
import { SyncDoctorView } from './sync/syncDoctorView';
import { registerSyncLifecycleCommands, registerSyncResetUriHandler } from './commands/syncLifecycle';
import { SshTunnel } from './connection/sshTunnel';
import { AuthenticatorStore } from './authenticator/store';
import { AuthenticatorView } from './authenticator/authenticatorView';
import { AuthenticatorChangedEvent } from './authenticator/events';
import { AuthenticatorSyncBackend } from './authenticator/syncBackend';
import { SchemaNotesSyncBackend } from './ai/schemaNotesSyncBackend';
import { AiModelAccessStore } from './ai/aiModelAccessStore';
import { ModelAccessSyncBackend } from './ai/modelAccessSyncBackend';
import { readSyncItems, typeEnabledOf } from './sync/syncItems';
import { ProviderCatalog } from './ai/providerCatalog';
import { applyModelAccessRuntime } from './ai/modelAccessRuntime';

/** 自动同步开关（按机器）：默认关闭，仅显式开启后才自动同步。 */
const SYNC_AUTO_SYNC_KEY = 'devbelt.sync.autoSync';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 宿主级兜底：忽略已知库内部（ioredis 关闭类）未处理拒绝，其它记错误但不崩宿主。
  installUnhandledRejectionGuard();
  try {
    await activateImpl(context);
  } catch (err) {
    // 激活失败会让所有命令缺失（表现为 "command ... not found"）：把真实原因落诊断通道，
    // 不再让它在扩展宿主日志里一闪而过。
    diagError('extension activate failed', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
    throw err;
  }
}

async function activateImpl(context: vscode.ExtensionContext): Promise<void> {
  const store = new ConnectionStore(context.globalState, context.secrets);
  context.subscriptions.push({ dispose: () => store.dispose() });
  await store.init();
  const syncHasConnections = (): void => {
    void vscode.commands.executeCommand('setContext', 'devbelt.hasConnections', store.list().length > 0);
  };
  syncHasConnections();
  const serverUrl = DEFAULT_SERVER_URL;
  const auth = new AuthService(context.secrets, serverUrl, context.globalState);
  const history = new HistoryStore(
    context.globalState,
    () => clampHistoryLimit(vscode.workspace.getConfiguration().get<number>('devbelt.insights.historyLimit')),
  );
  // 本机路径覆盖（B3）：仅存本机 globalState、不回传、不产生 mutation/同步事件。
  const overrideStore = new ConnectionPathOverrideStore(context.globalState);
  // history 注入管理器：所有会话的修改性语句由此自动进历史，
  // 不再依赖各命令自行调用 history.add（漏一个就少一段痕迹）。
  // resolveEffective 是建连/路径校验的单一有效配置入口（覆盖优先）。
  const manager = new ConnectionManager(undefined, history, (c) => overrideStore.applyOverrides(c));
  // cluster over SSH 未映射节点（扩容/resharding 后拓扑变化）：记诊断，并**按连接只提示一次**。
  const unmappedReporters = new Map<string, UnmappedNodeReporter>();
  manager.onRedisNodeUnmapped = (connId, address) => {
    let rep = unmappedReporters.get(connId);
    if (!rep) {
      rep = createUnmappedNodeReporter(
        (a) => diagWarn('redis cluster node unmapped (topology changed? reconnect to refresh SSH tunnels)', a),
        (a) => void vscode.window.showWarningMessage(l10n('redis.cluster.nodeUnmapped', { address: a })),
      );
      unmappedReporters.set(connId, rep);
    }
    rep.log(address);
    rep.notifyOnce(address);
  };
  // 连接关闭/重连时重置上报器：重连后拓扑可能已刷新，未映射提示与诊断限流应重新开始。
  manager.onConnectionClosed = (connId) => {
    unmappedReporters.delete(connId);
    clearEsRequestLog(connId); // M2：连接关闭后回收 ES 请求日志缓冲。
    AiChatView.notifyConnectionState(connId);
  };
  const treeProvider = new DbTreeDataProvider(store, manager, overrideStore, context.extensionUri);
  // 连接节点装饰（环境/自定义色徽标）：图标已改用数据库类型 logo，颜色信号改由此承载。
  const connDecoration = new ConnectionDecorationProvider(store);
  context.subscriptions.push(connDecoration, vscode.window.registerFileDecorationProvider(connDecoration));
  const auditLogger = AuditLogger.init(context.globalState);
  // P8 S4：ES DSL 保存查询（Memento；不进同步数据）。
  ElasticsearchView.configureDslStore(new EsDslStore(context.globalState));
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

  // 组织功能已移除：清理其遗留在 SecretStorage 的凭据（幂等；index 为空时 no-op）。
  try {
    await purgeLegacyOrgCredentials(context.globalState, context.secrets);
  } catch (err) {
    diagWarn('legacy org credential cleanup failed', String(err));
  }

  // P5：TOTP 验证器——store 先 await init() 完成 secretCache 预热，再注册命令；视图按需打开。
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
  // 条目/分组/标签变更 → 已打开的验证器面板重发快照（面板未打开时 no-op）。
  context.subscriptions.push(
    eventBus.subscribe(AuthenticatorChangedEvent, () => AuthenticatorView.refreshCurrent()),
    { dispose: () => AuthenticatorView.disposeCurrent() },
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

  // 侧边栏「工具」视图（竖向工具列表；首项 = 验证器）。
  context.subscriptions.push(ToolsViewProvider.register());

  // 侧边栏「反馈」视图：Bug 反馈、功能建议、文档、评价入口。
  context.subscriptions.push(FeedbackViewProvider.register());

  // 受控同步 session 工厂（阶段 A 无 UI）：activation/locked 态零请求，仅经工厂懒建。
  // 阶段 B 才接入初始化/解锁命令；此处只挂生命周期：logout → 丢弃 session，dispose → 清理。
  // ===== B2：状态栏 + 立即同步命令 + 窗口聚焦触发 =====
  // 自动同步开关按机器生效（读配置，实时判定）；关闭时不自动同步（含解锁首同步），仅显式命令触发。
  const isAutoSyncEnabled = (): boolean =>
    vscode.workspace.getConfiguration().get<boolean>(SYNC_AUTO_SYNC_KEY, false);

  // SQL 语句执行超时（全局默认，秒）：QueryService 每次查询读取静态值 → 改动实时生效（无需重连）；
  // 连接表单的 requestTimeout（毫秒）按连接覆盖本值；0 = 不超时。
  applyQueryTimeoutFromConfig((key) => vscode.workspace.getConfiguration('devbelt').get<number>(key));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devbelt.sql.queryTimeoutSeconds')) {
        applyQueryTimeoutFromConfig((key) => vscode.workspace.getConfiguration('devbelt').get<number>(key));
      }
    }),
  );

  // 选择性同步项（按机器生效，实时读取）：关闭的类型本机不推送、入站暂存不应用（重开后 drain 重放）、
  // 体检不计为缺失；依赖级联（关连接 → 查询/注记随停）在 typeEnabledOf 内强制。
  const syncTypeEnabled = (type: SyncEntityType): boolean =>
    typeEnabledOf(readSyncItems(vscode.workspace.getConfiguration('devbelt')), type);

  const syncStatusBar = createSyncStatusBar(context, auth, () => syncFactory.current, isAutoSyncEnabled);
  const authStatusBar = createAuthStatusBar(context, auth);

  // P9 S7f：AI 上下文的连接级存储在同步工厂之前建好（schemaNotes 实体后端与 AI 面板共用同一实例）。
  const aiContextStore = new AiContextStore(context.globalState);
  // 模型接入：Key 面与同步工厂共用同一实例（aiModelAccess 实体后端出站需读缓存 Key）。
  const aiKeyStore = new AiKeyStore(context.secrets);
  const aiModelAccessStore = new AiModelAccessStore(context.globalState);
  const providerCatalog = new ProviderCatalog(context.globalState, serverUrl);

  const syncFactory = new SyncSessionFactory({
    connectionStore: store,
    dekStore: new DekStore(context.secrets),
    memento: context.globalState,
    getUserId: async () => (auth.isLoggedIn() ? auth.getUserId() : undefined),
    entitlement: () => auth.getCachedEntitlement(),
    autoSyncEnabled: isAutoSyncEnabled,
    onSyncStart: (phase) => syncStatusBar.setSyncing({ phase }),
    onSyncProgress: (p) => syncStatusBar.setSyncing({ phase: p.phase, applied: p.applied, pushed: p.pushed }),
    onSyncResult: (result) => {
      syncStatusBar.setSyncing(null);
      // 同步可观测：每轮结果落诊断通道，便于确认「是否真的同步了 / 结果如何」。
      diagInfo('sync run', {
        stage: result?.stage,
        reason: result?.reason,
        applied: result?.applied,
        pushed: result?.pushed,
        changes: result?.changes,
        ignoredTombstone: result?.ignoredTombstone,
        skippedRemote: result?.skippedRemote,
        skippedEntitlement: result?.skippedEntitlement,
        skippedUnsupported: result?.skippedUnsupported,
        skippedDisabled: result?.skippedDisabled,
        skippedOutbound: result?.skippedOutbound,
      });
      // 入站 pull 应用了变更才刷树（避免每次空同步都整树刷新），并重算路径 warning；
      // 其余情况仅刷新状态栏。
      if (result && result.applied > 0) void treeProvider.refreshPathIssues();
      syncStatusBar.refresh();
    },
    onSessionState: () => syncStatusBar.refresh(),
    createClient: () => new PersonalSyncClient(auth.client),
    authenticatorBackend: new AuthenticatorSyncBackend(authStore),
    schemaNotesBackend: new SchemaNotesSyncBackend(aiContextStore),
    typeEnabled: syncTypeEnabled,
    aiModelAccessBackend: new ModelAccessSyncBackend(aiModelAccessStore, aiKeyStore, {
      applyRuntime: (fields) => applyModelAccessRuntime(fields),
      // 配置已从其他设备同步、但本机尚无 Key（或对端未同步 Key）→ 引导输入。
      onNeedsKey: () => void vscode.window.showInformationMessage(l10n('ai.ma.needsKey')),
    }),
    // P6 §六：按类型配额拒绝 → 标 localOnly/quota；推送成功 → 清除标记。
    onQuotaRejected: async (ref) => {
      if (ref.type === 'authenticatorEntry') await authStore.markSyncError(ref.localId, 'quota');
    },
    onEntityPushed: async (ref) => {
      if (ref.type === 'authenticatorEntry') await authStore.clearSyncError(ref.localId);
    },
  });
  context.subscriptions.push({ dispose: () => syncFactory.dispose() });
  const onAuthChange = eventBus.subscribe(AuthEvent, (e) => {
    if (e.kind === 'logout') syncFactory.invalidate();
    syncStatusBar.refresh();
    authStatusBar.refresh();
    void syncLoggedInContext(auth);
  });
  context.subscriptions.push(onAuthChange);
  // 同步可观测：本地用户改动（连接/分组/查询）后是否会自动排同步（取决于自动同步开关）。
  context.subscriptions.push(store.onChanged((source) => {
    syncHasConnections();
    if (source !== 'user') return;
    diagInfo('sync trigger', { trigger: 'store-change', autoSync: isAutoSyncEnabled() });
  }));
  // 窗口聚焦补同步（后台、无提示）。显式「立即同步」命令在 personalSync 注册并反馈结果。
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (!e.focused) return;
      // 自动同步关闭时不因切窗触发同步（手动命令仍可用）。
      if (!isAutoSyncEnabled()) return;
      diagInfo('sync trigger', { trigger: 'focus', autoSync: true });
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
      diagInfo('sync trigger', { trigger: 'config-enable', autoSync: true });
      const session = syncFactory.current;
      if (session?.isUnlocked && !session.stalled) session.scheduleNow();
    }),
  );
  // B1 是用户显式入口；注册本身不建 session，命令执行前才刷新权益并懒建。
  registerPersonalSyncCommands(context, auth, syncFactory);
  // S7k.8「数据体检」面板（发现 → 用户选择修复；conflict 阶段与通知按钮都进这个面板）。
  SyncDoctorView.register(context, syncFactory);
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

  // P10 S7：SQL 静态诊断（不连库；方言规则仅在文档绑定连接时启用）。
  context.subscriptions.push(new SqlDiagnosticsProvider({
    resolveDbType: (uri) => connCtx.getForDoc(uri)?.conn.dbType,
    resolveScanOptions: (uri) => {
      const conn = connCtx.getForDoc(uri)?.conn;
      return conn ? manager.scanOptionsFor?.(conn) : undefined;
    },
  }));

  registerViewCommands({ context, manager, treeProvider, auth, backupScheduler, auditLogger });

  // ===== P9 S3：AI 能力（Chat 面板骨架）=====
  // 独立 WebviewPanel（devbelt.ai + aiChat.html），不走 QueryView/DesignView 的 WebviewMode；
  // apiKey 只落 SecretStorage；面板单例由 AiChatView 管理（关闭即释放，在途流 abort）。
  const aiSessions = new AiSessionStore(context.globalState);
  const aiService = new AiService({ keyStore: aiKeyStore, auth, serverUrl, audit: auditLogger });
  const aiSchemaBuilder = new AiSchemaContextBuilder();
  AiSqlRegistry.init();
  const aiStatusBar = new AiStatusBar();
  const aiChatDeps: AiChatViewDeps = {
    service: aiService,
    sessions: aiSessions,
    contextStore: aiContextStore,
    keyStore: aiKeyStore,
    manager,
    connectionStore: store,
    memento: context.globalState,
    auth,
    executor,
    schemaBuilder: aiSchemaBuilder,
    modelAccessStore: aiModelAccessStore,
    providerCatalog,
  };
  // 叶子视图（结果面板/表设计器）经桥发起 Chat 请求；未初始化时调用方给明确提示。
  AiBridge.init({
    requestChat: (request) => {
      void AiChatView.open(aiChatDeps).requestExternal(request);
    },
  });
  context.subscriptions.push(
    aiKeyStore,
    aiStatusBar,
    { dispose: () => AiChatView.closeAll() },
    { dispose: () => AiBridge.reset() },
    { dispose: () => AiSqlRegistry.reset() },
    // P9 S5：Inline 补全（默认关；配置变更即时重建 provider）。
    registerAiInlineProvider({ service: aiService, manager, connCtx }),
  );
  registerAiCommands({
    context,
    connectionStore: store,
    contextStore: aiContextStore,
    keyStore: aiKeyStore,
    service: aiService,
    openChat: () => {
      AiChatView.open(aiChatDeps);
    },
  });
  registerAiEditorCommands({
    context,
    connCtx,
    manager,
    service: aiService,
    contextStore: aiContextStore,
    schemaBuilder: aiSchemaBuilder,
    statusBar: aiStatusBar,
    requestChat: (request) => {
      void AiChatView.open(aiChatDeps).requestExternal(request);
    },
    openChatRefine: (payload) => {
      AiChatView.openRefine(aiChatDeps, payload);
    },
  });

  // 表结构变更时清除补全缓存（事件订阅，替代对 treeProvider.refresh 的猴补丁）。
  context.subscriptions.push(treeProvider.onDidRefresh(() => completionProvider.invalidate()));

  // 树视图在**所有命令注册之后**才创建：树节点上的 command（如 devbelt.openConnection）
  // 必须在视图可见前就已注册，否则点击节点会报 "command ... not found"。
  // treeViewRef 要在注册命令前声明：命令不带 arguments，处理器从当前选中节点解析。
  let treeViewRef: vscode.TreeView<DbTreeNode> | undefined;
  registerCommands({
    context, store, manager, treeProvider, overrideStore, executor, history, auth, connCtx, syncFactory, authStore,
    getSelectedNode: () => treeViewRef?.selection[0],
  });

  const treeView = vscode.window.createTreeView('devbelt.explorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  treeViewRef = treeView;
  setTreeSelectionProvider(() => treeView.selection[0]);
  context.subscriptions.push(treeView, treeProvider);
  // 当前选中的连接（选中其子节点时归属该连接）显示绿点。
  // 空选择（刷新/失焦引发的瞬时清空）不更新——否则绿点会一闪而过。
  context.subscriptions.push(treeView.onDidChangeSelection((e) => {
    const sel = e.selection[0];
    if (!sel) return;
    treeProvider.setActiveConnection(sel.conn?.id);
  }));

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
