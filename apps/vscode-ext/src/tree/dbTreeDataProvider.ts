import { Event, EventEmitter, TreeDataProvider, TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, Uri, window } from 'vscode';
import type { CancellationToken } from 'vscode';
import { DatabaseType, DialectRegistry, redisKeyspace } from '@devbelt/db-core';
import { connectionColorToken } from '../utils/connectionColor';
import { ConnectionStore, type SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { ConnectionPathOverrideStore } from '../connection/connectionPathOverrideStore';
import { validateConnectionPaths, type PathValidationResult, type PathValidationIssue } from '../connection/connectionPathValidator';
import { DbTreeNode, NodeKind, type CategoryType } from './dbTreeNode';
import { dbTypeIconFile, type ConnIconState } from './dbTypeIcon';
import { connectionResource } from './connectionDecoration';
import { MetadataNodeBuilder } from './metadataNodeBuilder';
import { RedisKeyTreeState } from './redisKeyTreeState';
import { l10n } from '../i18n';
import { diagError } from '../utils/diagnostics';

/** D*：Redis 键树硬上限（转发自 `redisKeyTreeState`，保持既有导入路径）。 */
export { REDIS_TREE_HARD_CAP } from './redisKeyTreeState';

/**
 * 连接树数据提供者。
 *
 * 层级（参考 Navicat）：
 *  - 根：分组 + 未分组连接
 *  - 分组：子分组 + 组内连接（支持任意层级）
 *  - 连接：数据库列表
 *  - 数据库：分类列表（表/视图/函数/事件/查询）
 *  - 分类：具体对象列表（表/视图/函数/事件/保存的查询）
 *
 * 懒加载：仅当节点被展开时才查询子节点。
 */
export class DbTreeDataProvider implements TreeDataProvider<DbTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new EventEmitter<DbTreeNode | undefined>();
  readonly onDidChangeTreeData: Event<DbTreeNode | undefined> =
    this.onDidChangeTreeDataEmitter.event;

  /** 整树刷新事件：供外部（如补全缓存）订阅，替代对 refresh 的猴补丁。 */
  private readonly refreshEmitter = new EventEmitter<void>();
  readonly onDidRefresh: Event<void> = this.refreshEmitter.event;

  /** 已打开的连接 id 集合（默认全部未打开，需右键"打开连接"） */
  private readonly openConns = new Set<string>();

  /** 已打开连接的服务器类型+版本摘要（连接名右侧 description） */
  private readonly connVersions = new Map<string, string>();

  /** 当前在资源管理器中选中的连接 id（含选中其子节点时归属的连接）；用于绿点。 */
  private activeConnId?: string;

  /** 各连接的连接节点引用（每次 makeConnectionNode 覆盖），供选中变化时定向刷新图标。 */
  private readonly connNodes = new Map<string, DbTreeNode>();

  /** 有效配置的路径校验结果缓存（按 connId，异步填充，供同步渲染读）。 */
  private readonly pathIssues = new Map<string, PathValidationResult>();

  /** Redis 只读键导航状态机（P7 S5-3 / C-1）：SCAN 分页/折叠/搜索/快照/代际。 */
  private readonly redisTree: RedisKeyTreeState;

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly overrideStore?: ConnectionPathOverrideStore,
    /** 扩展根 Uri，用于拼 `resources/icons/*` 路径；缺省时连接节点回退 codicon。 */
    private readonly extensionUri?: Uri,
  ) {
    this.redisTree = new RedisKeyTreeState(
      (conn) => this.manager.connect(conn),
      (node) => this.refreshNode(node),
    );
  }

  /** 刷新整棵树 */
  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
    this.refreshEmitter.fire();
  }

  dispose(): void {
    this.refreshEmitter.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  /**
   * 异步重算有效配置（覆盖优先）的路径校验结果并刷新树。
   * `connId` 省略时全量重扫；此方法不发起任何同步/网络请求，仅本地 fs 校验。
   */
  async refreshPathIssues(connId?: string): Promise<void> {
    if (connId) {
      const conn = this.store.get(connId);
      if (!conn) this.pathIssues.delete(connId);
      else this.pathIssues.set(connId, await validateConnectionPaths(this.effective(conn)));
    } else {
      this.pathIssues.clear();
      for (const c of this.store.list()) {
        this.pathIssues.set(c.id, await validateConnectionPaths(this.effective(c)));
      }
    }
    this.refresh();
  }

  /** 某连接的有效配置（本机覆盖优先）；未注入覆盖存储时恒等。 */
  private effective(conn: SavedConnection): SavedConnection {
    return this.overrideStore ? this.overrideStore.applyOverrides(conn) : conn;
  }

  private pathTooltip(issues: PathValidationIssue[]): string {
    return l10n('sync.needsPathConfig', { fields: issues.map((i) => i.field).join(', ') });
  }

  /** 刷新单个节点（重新拉取其子节点） */
  refreshNode(node: DbTreeNode): void {
    this.onDidChangeTreeDataEmitter.fire(node);
  }

  /** 标记连接已打开（可展开） */
  markOpen(connId: string): void {
    this.openConns.add(connId);
  }

  /** 设置连接的服务器摘要（类型+版本），显示在连接名右侧 */
  setConnVersion(connId: string, desc: string): void {
    this.connVersions.set(connId, desc);
  }

  /**
   * 设置当前选中的连接（其子节点被选中时归属的连接）。
   * **定向刷新**旧/新连接节点图标，不整树重渲染——否则所有已展开连接都会重查元数据。
   */
  setActiveConnection(connId: string | undefined): void {
    if (this.activeConnId === connId) return;
    const prev = this.activeConnId;
    this.activeConnId = connId;
    for (const id of [prev, connId]) if (id) this.refreshConnectionIcon(id);
  }

  /** 只重算并重渲染某连接节点的图标（路径异常时保持 warning 不改）。 */
  private refreshConnectionIcon(connId: string): void {
    const node = this.connNodes.get(connId);
    if (!node?.conn) return;
    const isOpen = this.openConns.has(connId);
    const pathCheck = this.pathIssues.get(connId);
    if (!isOpen && pathCheck && !pathCheck.valid) return;
    const state: ConnIconState = !isOpen ? 'dim' : connId === this.activeConnId ? 'active' : 'open';
    node.iconPath = this.dbTypeIcon(node.conn, state);
    this.refreshNode(node);
  }

  /** 标记连接已关闭（不可展开） */
  markClosed(connId: string): void {
    this.openConns.delete(connId);
    this.connVersions.delete(connId);
    this.redisTree.clearRedisKeyState(connId);
  }

  /**
   * 设置某 db 的搜索匹配并刷新（pattern 为空则清除）。
   * 清空该 db 的懒加载缓存，使下次展开重新 SCAN。
   */
  setRedisMatch(node: DbTreeNode, pattern: string | undefined): void {
    this.redisTree.setRedisMatch(node, pattern);
  }

  /** 返回当前已打开连接的 id 列表（供全局对象搜索等使用） */
  getOpenConnIds(): string[] {
    return Array.from(this.openConns);
  }

  getTreeItem(element: DbTreeNode): TreeItem {
    return element;
  }

  async getChildren(element?: DbTreeNode): Promise<DbTreeNode[]> {
    if (!element) {
      return this.buildRootChildren();
    }

    try {
      switch (element.kind) {
        case NodeKind.Group:
          if (!element.groupId) return [];
          return this.buildGroupChildren(element.groupId);
        case NodeKind.Connection:
          return this.buildConnectionChildren(element);
        case NodeKind.Database:
          return this.buildDatabaseChildren(element);
        case NodeKind.Schema:
          return this.buildSchemaChildren(element);
        case NodeKind.Category:
          return this.buildCategoryChildren(element);
        case NodeKind.QueryFolder:
          return this.buildQueryFolderChildren(element);
        case NodeKind.Table:
          return this.buildTableChildren(element);
        // P7 S5-3：Redis 只读键导航（懒加载）。
        case NodeKind.RedisDb:
          return this.redisTree.buildRedisKeyChildren(element, '');
        case NodeKind.RedisKeyFolder:
          return this.redisTree.buildRedisKeyChildren(element, element.redisKeyPrefix ?? '');
        default:
          return [];
      }
    } catch (error) {
      diagError('tree load failed', (error as Error).message);
      window.showErrorMessage(
        l10n('tree.loadFailed', { label: element.label, message: (error as Error).message }),
      );
      return [];
    }
  }

  /** 连接节点子节点：数据库列表 */
  private async buildConnectionChildren(element: DbTreeNode): Promise<DbTreeNode[]> {
    if (!element.conn) return [];
    // Redis（P7 S3）：子节点为逻辑库（INFO keyspace）；键在 webview 内分页加载。
    if (element.conn.dbType === DatabaseType.REDIS) {
      const conn = element.conn;
      const session = await this.manager.connect(conn);
      if (session.kind !== 'redis') return [];
      // Cluster 无逻辑库（无 SELECT）：给一个合成「Keys」节点（逐 master SCAN 聚合）。
      if (session.mode === 'cluster') {
        const node = new DbTreeNode(
          l10n('redis.tree.clusterKeys'),
          TreeItemCollapsibleState.Collapsed,
          NodeKind.RedisDb,
          conn,
          undefined,
          element,
        );
        node.redisDbIndex = 0;
        node.id = `${conn.id}:cluster`;
        return [node];
      }
      const stats = await redisKeyspace(session.client);
      return stats.map((stat) => {
        const label = `db${stat.index}`;
        const node = new DbTreeNode(
          label,
          TreeItemCollapsibleState.Collapsed,
          NodeKind.RedisDb,
          conn,
          undefined,
          element,
          undefined,
          label,
        );
        node.redisDbIndex = stat.index;
        node.description = String(stat.keys);
        node.id = `${conn.id}:db${stat.index}`;
        // C-2：DB 节点仅展开键树（不再有默认点击命令）。
        return node;
      });
    }
    const conn = element.conn;
    const session = await this.manager.connectSql(conn);
    if (!session.capabilities.multiDatabaseExplorer) {
      // 'public' 是 schema 名而非库名；单库引擎缺省用 SQLite 的 'main'。
      const only = conn.database || 'main';
      const n = new DbTreeNode(only, TreeItemCollapsibleState.Collapsed, NodeKind.Database, conn, undefined, element, undefined, only);
      n.id = `${conn.id}:sqldb:${only}`;
      return [n];
    }
    // 枚举库失败时回退为**单个节点**（conn.database / PG 的 current_database），
// 而不是让整棵树展开报错。
    let dbs: string[] = [];
    try {
      dbs = await session.metadata.getDatabases();
    } catch (error) {
      // 不再静默吞掉：记录诊断，便于排查「只显示一个库」的根因。
      diagError('enumerate databases failed', (error as Error).message);
      dbs = [];
    }
    if (!dbs.length) {
      const pgDb = conn.dbType === DatabaseType.PG ? await this.currentDatabaseOf(session) : '';
      const only = conn.database || pgDb || 'main';
      const n = new DbTreeNode(only, TreeItemCollapsibleState.Collapsed, NodeKind.Database, conn, undefined, element, undefined, only);
      n.id = `${conn.id}:sqldb:${only}`;
      return [n];
    }
    return dbs.map((db) => {
      // B4：Database 节点带 `database=库名`，恢复/导入/导出/定时备份/数据对比据此命中该库。
      const n = new DbTreeNode(db, TreeItemCollapsibleState.Collapsed, NodeKind.Database, conn, undefined, element, undefined, db);
      n.id = `${conn.id}:sqldb:${db}`;
      return n;
    });
  }

  /** PG 主会话实际所在库（枚举库失败/`conn.database` 为空时兜底显示）。 */
  private async currentDatabaseOf(session: { query: { query(sql: string): Promise<{ rows: any[] }> } }): Promise<string> {
    try {
      const r = await session.query.query('SELECT current_database() AS db');
      const db = r.rows?.[0]?.db;
      if (db) return String(db);
    } catch { /* fall through */ }
    return '';
  }

  /** 数据库节点子节点：PG 先出 schema 层；其余按方言能力过滤分类（表/视图始终显示）。 */
  private async buildDatabaseChildren(element: DbTreeNode): Promise<DbTreeNode[]> {
    if (!element.conn) return [];
    // Redis 逻辑库无 SQL 分类子节点（键在 webview），且 DialectRegistry.get(REDIS) 会抛错。
    if (element.conn.dbType === DatabaseType.REDIS) return [];
    const dialect = DialectRegistry.get(element.conn.dbType);
    if (!dialect) return [];
    // B1：PG（capabilities.schemas）在库下先出 schema 层。B2：库节点 label 即目标库，取对应库会话。
    if (dialect.capabilities.schemas) {
      const session = await this.manager.connectSql(element.conn, element.label);
      const schemas = await session.metadata.getSchemas();
      // 连接配置的默认 schema（`conn.schema || 'public'`）置顶，而不是恒把 public 置顶。
      const preferred = (element.conn.schema && element.conn.schema.trim()) || 'public';
      const ordered = schemas.includes(preferred)
        ? [preferred, ...schemas.filter((s) => s !== preferred)]
        : schemas;
      const schemaNodes = ordered.map((name) => this.schemaNode(element, name));
      // 「查询」分类挂在 **Database** 节点下：保存查询按库组织，若在每个 schema 下各挂一份，
      // 其子节点 id 只含库名会跨 schema 冲突（且重复展示）。见 buildSchemaChildren(includeQuery=false)。
      const queryCat = this.categoryNodes(element, element.label ?? '').find((n) => n.categoryType === 'query');
      return queryCat ? [...schemaNodes, queryCat] : schemaNodes;
    }
    return this.categoryNodes(element, element.label ?? '');
  }

  /** PG schema 节点（database = 库名，schema 单独携带）。 */
  private schemaNode(parent: DbTreeNode, name: string): DbTreeNode {
    const conn = parent.conn!;
    const n = new DbTreeNode(name, TreeItemCollapsibleState.Collapsed, NodeKind.Schema, conn, undefined, parent, undefined, parent.label);
    n.schema = name;
    n.id = `${parent.id}:schema:${name}`;
    // 默认 schema 展开态与普通节点一致，无需额外标记。
    return n;
  }

  /** Schema 节点子节点：对象分类（database 槽给 schema，供元数据/限定名使用）。查询分类不在此层。 */
  private buildSchemaChildren(element: DbTreeNode): DbTreeNode[] {
    const schema = element.schema ?? '';
    return this.categoryNodes(element, schema, false);
  }

  /**
   * 分类节点工厂。`scope` 是对象作用域：MySQL 为库名；PG 为 schema 名。
   * — MySQL/SQLite：database = scope。
   * — PG（B2）：database = **库名**（多库会话用），schema = scope（限定名用）。
   * — query 分类挂在库节点：database = 库名。
   */
  private categoryNodes(element: DbTreeNode, scope: string, includeQuery = true): DbTreeNode[] {
    if (!element.conn) return [];
    const dialect = DialectRegistry.get(element.conn.dbType);
    if (!dialect) return [];
    const caps = dialect.capabilities;
    const isPg = element.conn.dbType === DatabaseType.PG;
    // PG 库名：Schema 节点继承库节点（element.database）；Database 节点用 label。
    const pgDb = element.kind === NodeKind.Schema
      ? (element.database ?? element.conn.database ?? '')
      : (element.label ?? element.database ?? element.conn.database ?? '');
    const database = isPg ? pgDb : scope;
    const categories: { type: CategoryType; label: string; database: string; schema?: string }[] = [
      { type: 'table', label: l10n('cat.tables'), database, schema: isPg ? scope : undefined },
      { type: 'view', label: l10n('cat.views'), database, schema: isPg ? scope : undefined },
    ];
    if (caps.routines) categories.push({ type: 'function', label: l10n('cat.functions'), database, schema: isPg ? scope : undefined });
    if (caps.events) categories.push({ type: 'event', label: l10n('cat.events'), database, schema: isPg ? scope : undefined });
    if (includeQuery) categories.push({ type: 'query', label: l10n('cat.queries'), database });
    return categories.map((c) => {
      const n = new DbTreeNode(c.label, TreeItemCollapsibleState.Collapsed, NodeKind.Category, element.conn, undefined, element, c.type, c.database);
      if (c.schema) n.schema = c.schema;
      n.id = `${element.id}:cat:${c.type}`;
      return n;
    });
  }

  // ───────────── D*：Redis 只读键导航（委托 RedisKeyTreeState） ─────────────

  /** 加载根层一页（首次展开 / 「加载更多」）。 */
  async loadMoreRedisKeys(node: DbTreeNode): Promise<{ added: number; total: number; done: boolean; error: boolean }> {
    return this.redisTree.loadMoreRedisKeys(node);
  }

  /** 显式「加载完整文件夹」（按前缀独立 SCAN + 进度/取消）。 */
  async loadFullFolder(
    node: DbTreeNode,
    token?: CancellationToken,
    onProgress?: (loaded: number) => void,
  ): Promise<boolean> {
    return this.redisTree.loadFullFolder(node, token, onProgress);
  }

  /** 根层「载入全部键」（modal 二次确认 + 进度 + 取消 + 硬上限）。 */
  async loadAllRedisKeys(
    node: DbTreeNode,
    token?: CancellationToken,
    onProgress?: (loaded: number) => void,
  ): Promise<{ scanned: number; done: boolean; capped: boolean }> {
    return this.redisTree.loadAllRedisKeys(node, token, onProgress);
  }

  /** 刷新某节点所属 RedisDb（load more/full/all 后保展开态）。 */
  refreshRedisDbNode(node: DbTreeNode): void {
    this.redisTree.refreshRedisDbNode(node);
  }

  /** 键变更后重扫该 db 并保留当前搜索（定向失效 `__full__` 快照）。 */
  async refreshRedisAfterMutation(node: DbTreeNode, invalidateAllSnapshots = false, extraAffected: readonly string[] = []): Promise<void> {
    return this.redisTree.refreshRedisAfterMutation(node, invalidateAllSnapshots, extraAffected);
  }

  /** 分类节点子节点：根据分类类型查询具体对象 */
  private async buildCategoryChildren(element: DbTreeNode): Promise<DbTreeNode[]> {
    const db = element.database;
    const conn = element.conn;
    const catType = element.categoryType;
    if (!db || !conn || !catType) return [];

    if (catType === 'query') {
      const folderNodes = this.store.getQueryFolders(conn.id).map((folder) => {
        const n = new DbTreeNode(
          folder.name,
          TreeItemCollapsibleState.Collapsed,
          NodeKind.QueryFolder,
          conn,
          undefined,
          element,
          undefined,
          db,
          undefined,
          undefined,
          folder.id,
        );
        n.id = `${conn.id}:sqldb:${db}:qf:${folder.id}`;
        return n;
      });
      const queryNodes = this.store.getQueriesInFolder(conn.id, db).map(
        (q) => {
          const n = new DbTreeNode(
            q.name,
            TreeItemCollapsibleState.None,
            NodeKind.SavedQuery,
            conn,
            undefined,
            element,
            undefined,
            db,
            undefined,
            q.id,
          );
          n.command = { command: 'devbelt.openQuery', title: 'Open', arguments: [n] };
          n.id = `${conn.id}:sqldb:${db}:q:${q.id}`;
          return n;
        },
      );
      return [...folderNodes, ...queryNodes];
    }

    const session = await this.manager.connectSql(conn, db);
    const builder = new MetadataNodeBuilder(session.metadata);
    const schema = element.schema;

    switch (catType) {
      case 'table':
      case 'view':
      case 'function':
      case 'event':
        return builder.build(catType, conn, db, element, schema);
      case 'index':
        return this.buildIndexChildren(session, conn, db, element, schema);
      case 'trigger':
        return this.buildTriggerChildren(session, conn, db, element, schema);
      case 'foreignKey':
        return this.buildForeignKeyChildren(session, conn, db, element, schema);
      default:
        return [];
    }
  }

  /** 索引分类子节点 */
  private async buildIndexChildren(session: any, conn: SavedConnection, db: string, element: DbTreeNode, schema?: string): Promise<DbTreeNode[]> {
    const table = element.parent?.label;
    if (!table) return [];
    const indexes = await session.metadata.getIndexes(table, db, schema);
    return indexes.map((idx: any) => {
      const node = new DbTreeNode(idx.name, TreeItemCollapsibleState.None, NodeKind.Index, conn, undefined, element, undefined, db);
      node.schema = schema;
      node.id = `${element.id}:idx:${idx.name}`;
      node.description = [
        idx.columns?.join(', '),
        idx.isPrimary ? 'PK' : idx.isUnique ? 'UNIQUE' : '',
      ].filter(Boolean).join(' ');
      return node;
    });
  }

  /** 触发器分类子节点 */
  private async buildTriggerChildren(session: any, conn: SavedConnection, db: string, element: DbTreeNode, schema?: string): Promise<DbTreeNode[]> {
    const table = element.parent?.label;
    if (!table) return [];
    const triggers = await session.metadata.getTriggers(table, db, schema);
    return triggers.map((t: any) => {
      const node = new DbTreeNode(t.name, TreeItemCollapsibleState.None, NodeKind.Trigger, conn, undefined, element, undefined, db);
      node.schema = schema;
      node.id = `${element.id}:trg:${t.name}`;
      node.description = [t.timing, t.event].filter(Boolean).join(' ');
      node.command = { command: 'devbelt.viewTrigger', title: 'View', arguments: [node] };
      return node;
    });
  }

  /** 外键分类子节点（只读展示，按当前表过滤） */
  private async buildForeignKeyChildren(session: any, conn: SavedConnection, db: string, element: DbTreeNode, schema?: string): Promise<DbTreeNode[]> {
    const table = element.parent?.label;
    if (!table) return [];
    const fks = await session.metadata.getForeignKeys(db, schema);
    return fks
      .filter((f: any) => f.tableName === table)
      .map((f: any) => {
        const node = new DbTreeNode(
          `${f.columnName} → ${f.refTable}.${f.refColumn}`,
          TreeItemCollapsibleState.None,
          NodeKind.ForeignKey,
          conn,
          undefined,
          element,
          undefined,
          db,
        );
        node.schema = schema;
        // 复合外键每个列各一行、约束名相同：id 必须带 columnName，否则树节点 id 重复
        // （VS Code 报 "already registered" 并丢节点）。
        const fkKey = f.constraintName
          ? `${f.constraintName}:${f.columnName}`
          : `${f.columnName}>${f.refTable}.${f.refColumn}`;
        node.id = `${element.id}:fk:${fkKey}`;
        node.refTable = f.refTable;
        node.refColumn = f.refColumn;
        node.refSchema = f.refSchema;
        node.constraintName = f.constraintName;
        node.command = { command: 'devbelt.jumpToRefTable', title: 'Open', arguments: [node] };
        return node;
      });
  }

  /** 查询文件夹子节点：文件夹内保存的查询 */
  private buildQueryFolderChildren(element: DbTreeNode): DbTreeNode[] {
    const conn = element.conn;
    if (!conn) return [];
    const db = element.database;
    return this.store.getQueriesInFolder(conn.id, db, element.queryFolderId).map(
      (q) => {
        const n = new DbTreeNode(
          q.name,
          TreeItemCollapsibleState.None,
          NodeKind.SavedQuery,
          conn,
          undefined,
          element,
          undefined,
          db,
          undefined,
          q.id,
        );
        n.command = { command: 'devbelt.openQuery', title: 'Open', arguments: [n] };
        n.id = `${conn.id}:sqldb:${db}:q:${q.id}`;
        return n;
      },
    );
  }

  /** 表节点子节点：列列表 + 索引/触发器/外键子分类 */
  private async buildTableChildren(element: DbTreeNode): Promise<DbTreeNode[]> {
    if (!element.conn) return [];
    const session = await this.manager.connectSql(element.conn, element.database);
    const columns = await session.metadata.getColumns(element.label, element.database, element.schema);
    const colNodes = columns.map((col) => {
      const node = new DbTreeNode(
        col.name,
        TreeItemCollapsibleState.None,
        NodeKind.Column,
        element.conn,
        undefined,
        element,
        undefined,
        element.database,
      );
      node.schema = element.schema;
      node.id = `${element.id}:col:${col.name}`;
      node.description = `${col.simpleType || col.type}`;
      if (col.isPrimary) {
        node.iconPath = new ThemeIcon('key', new ThemeColor('charts.yellow'));
        node.description = `${col.simpleType || col.type}  PK`;
      }
      if (col.nullable === 'NO' || col.isNotNull) {
        node.description += '  NOT NULL';
      }
      return node;
    });

    const caps = session.capabilities;
    const subCategories: DbTreeNode[] = [];
    const mkCat = (type: CategoryType, label: string) => {
      const n = new DbTreeNode(
        label, TreeItemCollapsibleState.Collapsed, NodeKind.Category, element.conn, undefined, element, type, element.database,
      );
      n.schema = element.schema;
      n.id = `${element.id}:cat:${type}`;
      return n;
    };
    if (caps.operations.includes('manageIndexes')) {
      subCategories.push(mkCat('index', l10n('cat.indexes')));
      subCategories.push(mkCat('trigger', l10n('cat.triggers')));
    }
    subCategories.push(mkCat('foreignKey', l10n('cat.foreignKeys')));
    return [...colNodes, ...subCategories];
  }

  /** 根节点：顶层分组 + 未分组连接（不含软删除墓碑） */
  private buildRootChildren(): DbTreeNode[] {
    const data = this.store.getVisibleTreeData();
    // 分组/连接引用无法解析（缺失或已删除）时按顶层处理，避免导入/同步产生的孤儿被静默隐藏。
    const visibleGroupIds = new Set(data.groups.map((g) => g.id));
    const topGroups = data.groups.filter((g) => !g.parentId || !visibleGroupIds.has(g.parentId));
    const ungrouped = data.connections.filter((c) => !c.groupId || !visibleGroupIds.has(c.groupId));
    const gNodes = topGroups.map(
      (g) => {
        const n = new DbTreeNode(g.name, TreeItemCollapsibleState.Collapsed, NodeKind.Group, undefined, g.id);
        n.id = `group:${g.id}`; // 稳定 id：整树 refresh 后保住展开态
        return n;
      },
    );
    const cNodes = ungrouped.map((c) => this.makeConnectionNode(this.withCredentials(c)));
    return [...gNodes, ...cNodes];
  }

  /** 分组节点：子分组 + 组内连接（不含软删除墓碑） */
  private buildGroupChildren(groupId: string): DbTreeNode[] {
    const data = this.store.getVisibleTreeData();
    const childGroups = data.groups.filter((g) => g.parentId === groupId);
    const conns = data.connections.filter((c) => c.groupId === groupId);
    const gNodes = childGroups.map(
      (g) => {
        const n = new DbTreeNode(g.name, TreeItemCollapsibleState.Collapsed, NodeKind.Group, undefined, g.id);
        n.id = `group:${g.id}`;
        return n;
      },
    );
    const cNodes = conns.map((c) => this.makeConnectionNode(this.withCredentials(c)));
    return [...gNodes, ...cNodes];
  }

  /** 用 store 中 materialize 的连接替换原始（无凭据）连接，确保树节点携带密码。 */
  private withCredentials(conn: SavedConnection): SavedConnection {
    const stored = this.store.get(conn.id);
    if (!stored) return conn;
    if (!stored.password && conn.password) return conn;
    return stored;
  }

  /** 创建连接节点：未打开时无箭头+双击触发打开；已打开时可展开 */
  private makeConnectionNode(conn: SavedConnection, parent?: DbTreeNode): DbTreeNode {
    const isOpen = this.openConns.has(conn.id);
    const node = new DbTreeNode(
      conn.name || conn.host,
      // 折叠态同时编码「是否已打开」（见 DbTreeNode contextValue 规则）。
      // Redis（S2）暂无子节点，由 buildConnectionChildren 返回 []；DB/键随 S3。
      isOpen ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None,
      NodeKind.Connection,
      conn,
      undefined,
      parent,
    );
// 环境/自定义色信号改由 FileDecoration 徽标承载（见 connectionDecoration），
    // 图标统一为数据库类型 logo；resourceUri 是装饰的挂载点。
    node.resourceUri = Uri.parse(connectionResource(conn.id));
    const state: ConnIconState = !isOpen ? 'dim' : conn.id === this.activeConnId ? 'active' : 'open';
    const logo = this.dbTypeIcon(conn, state);
    const pathCheck = this.pathIssues.get(conn.id);
    const hasPathIssues = !!pathCheck && !pathCheck.valid;
    if (!isOpen) {
      node.id = `closed_${conn.id}`;
      node.command = {
        command: 'devbelt.openConnection',
        title: 'Open',
        arguments: [conn],
      };
      // 路径异常优先于类型图标（连接不可用是更重要的信号）；tooltip 说明原因。
      if (hasPathIssues) {
        node.iconPath = new ThemeIcon('warning', new ThemeColor('editorWarning.foreground'));
        node.tooltip = this.pathTooltip(pathCheck.issues);
      } else {
        node.iconPath = logo;
      }
    } else {
      node.id = conn.id;
      node.description = this.connVersions.get(conn.id) || '';
      node.iconPath = logo;
      if (hasPathIssues) {
        node.tooltip = this.pathTooltip(pathCheck.issues);
      }
    }
    this.connNodes.set(conn.id, node);
    return node;
  }

  /**
   * 连接节点图标：注入 `extensionUri` 时用数据库类型 logo（浅/深同图，品牌彩色）；
   * 缺省（测试/未接线）回退旧 codicon 行为，便于无 vscode 资源的场景。
   */
  private dbTypeIcon(conn: SavedConnection, state: ConnIconState): TreeItem['iconPath'] {
    if (!this.extensionUri) {
      const isRedis = conn.dbType === DatabaseType.REDIS;
      const envColor = conn.environment === 'production'
        ? 'errorForeground'
        : conn.environment === 'staging'
          ? 'editorWarning.foreground'
          : 'gitDecoration.untrackedResourceForeground';
      const colorToken = connectionColorToken(conn.color);
      return new ThemeIcon(isRedis ? 'symbol-key' : 'server', new ThemeColor(colorToken ?? envColor));
    }
    const uri = Uri.joinPath(this.extensionUri, 'resources', 'icons', dbTypeIconFile(conn.dbType, state));
    return { light: uri, dark: uri };
  }
}
