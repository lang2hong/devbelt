import { Event, EventEmitter, TreeDataProvider, TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, window } from 'vscode';
import { DatabaseType, DialectRegistry, redisKeyspace, redisScan, redisSelect } from '@devbelt/db-core';
import { connectionColorToken } from '../utils/connectionColor';
import { ConnectionStore, type SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { ConnectionPathOverrideStore } from '../connection/connectionPathOverrideStore';
import { validateConnectionPaths, type PathValidationResult, type PathValidationIssue } from '../connection/connectionPathValidator';
import { DbTreeNode, NodeKind, type CategoryType } from './dbTreeNode';
import { groupRedisKeyChildren, redisPrefixPattern } from '../result/redisKeyFold';
import { MetadataNodeBuilder } from './metadataNodeBuilder';
import { l10n } from '../i18n';
import { diagError } from '../utils/diagnostics';

/** S5-3：Redis 键树每页 SCAN 数量（只读导航，限制单层节点数）。 */
const REDIS_TREE_PAGE = 200;
/** S5-3：单 db 最多加载的键节点数（超出以提示节点截断，防 TreeView 卡死；ARDM 同类上限 200k）。
 *  仅约束**树展示**；删除路径（deleteFolder 全量循环）按用户意图走全量，不受此限。 */
const REDIS_TREE_MAX = 20000;

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

  /** 有效配置的路径校验结果缓存（按 connId，异步填充，供同步渲染读）。 */
  private readonly pathIssues = new Map<string, PathValidationResult>();

  /** S5-3：Redis 只读键导航懒加载状态（key = `${connId}:db${idx}:${prefix}`）。 */
  private readonly redisKeys = new Map<string, string[]>();
  private readonly redisCursors = new Map<string, string>();
  private readonly redisScanned = new Set<string>();
  /** S5-3：每 db 的搜索匹配（key = `${connId}:db${idx}`，值为 Redis MATCH pattern）。 */
  private readonly redisMatches = new Map<string, string>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly overrideStore?: ConnectionPathOverrideStore,
  ) {}

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

  /** 标记连接已关闭（不可展开） */
  markClosed(connId: string): void {
    this.openConns.delete(connId);
    this.connVersions.delete(connId);
    this.clearRedisKeyState(connId);
  }

  /** 清理某连接的 Redis 键树懒加载状态。 */
  private clearRedisKeyState(connId: string): void {
    const p = `${connId}:`;
    for (const k of [...this.redisKeys.keys()]) if (k.startsWith(p)) this.redisKeys.delete(k);
    for (const k of [...this.redisCursors.keys()]) if (k.startsWith(p)) this.redisCursors.delete(k);
    for (const k of [...this.redisScanned]) if (k.startsWith(p)) this.redisScanned.delete(k);
    for (const k of [...this.redisMatches.keys()]) if (k.startsWith(p)) this.redisMatches.delete(k);
  }

  /**
   * 设置某 db 的搜索匹配并刷新（pattern 为空则清除）。
   * 清空该 db 的懒加载缓存，使下次展开重新 SCAN。
   */
  setRedisMatch(node: DbTreeNode, pattern: string | undefined): void {
    if (!node.conn || node.redisDbIndex === undefined) return;
    const dbKey = `${node.conn.id}:db${node.redisDbIndex}`;
    if (pattern) this.redisMatches.set(dbKey, pattern);
    else this.redisMatches.delete(dbKey);
    const p = `${dbKey}:`;
    for (const k of [...this.redisKeys.keys()]) if (k.startsWith(p)) this.redisKeys.delete(k);
    for (const k of [...this.redisCursors.keys()]) if (k.startsWith(p)) this.redisCursors.delete(k);
    for (const k of [...this.redisScanned]) if (k.startsWith(p)) this.redisScanned.delete(k);
    this.refreshNode(node);
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
        case NodeKind.Category:
          return this.buildCategoryChildren(element);
        case NodeKind.QueryFolder:
          return this.buildQueryFolderChildren(element);
        case NodeKind.Table:
          return this.buildTableChildren(element);
        // P7 S5-3：Redis 只读键导航（懒加载）。
        case NodeKind.RedisDb:
          return this.buildRedisKeyChildren(element, '');
        case NodeKind.RedisKeyFolder:
          return this.buildRedisKeyChildren(element, element.redisKeyPrefix ?? '');
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
      // Cluster 无逻辑库（无 SELECT）：不显示 DB 节点。
      if (session.mode === 'cluster') return [];
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
        node.command = { command: 'devbelt.redis.keyBrowser', title: 'Open', arguments: [node] };
        return node;
      });
    }
    const session = await this.manager.connectSql(element.conn);
    if (!session.capabilities.multiDatabaseExplorer) {
      return [
        new DbTreeNode(
          element.conn.database || (element.conn.dbType === DatabaseType.PG ? 'public' : 'main'),
          TreeItemCollapsibleState.Collapsed,
          NodeKind.Database,
          element.conn,
          undefined,
          element,
        ),
      ];
    }
    const dbs = await session.metadata.getDatabases();
    return dbs.map(
      (db) =>
        new DbTreeNode(
          db,
          TreeItemCollapsibleState.Collapsed,
          NodeKind.Database,
          element.conn,
          undefined,
          element,
        ),
    );
  }

  /** 数据库节点子节点：按方言能力过滤分类（表/视图始终显示） */
  private buildDatabaseChildren(element: DbTreeNode): DbTreeNode[] {
    if (!element.conn) return [];
    // Redis 逻辑库无 SQL 分类子节点（键在 webview），且 DialectRegistry.get(REDIS) 会抛错。
    if (element.conn.dbType === DatabaseType.REDIS) return [];
    const dialect = DialectRegistry.get(element.conn.dbType);
    if (!dialect) return [];
    const caps = dialect.capabilities;
    const categories: { type: CategoryType; label: string }[] = [
      { type: 'table', label: l10n('cat.tables') },
      { type: 'view', label: l10n('cat.views') },
    ];
    if (caps.routines) categories.push({ type: 'function', label: l10n('cat.functions') });
    if (caps.events) categories.push({ type: 'event', label: l10n('cat.events') });
    categories.push({ type: 'query', label: l10n('cat.queries') });
    // 用户不是库级对象：`getUsers()` 与库无关，挂在库下会让 MySQL 的 20 个库
    // 各显示一份完全相同的用户列表。改为连接右键打开专门的用户管理面板。
    return categories.map(
      (c) =>
        new DbTreeNode(
          c.label,
          TreeItemCollapsibleState.Collapsed,
          NodeKind.Category,
          element.conn,
          undefined,
          element,
          c.type,
          element.label,
        ),
    );
  }

  // ────────────────── S5-3：Redis 只读键导航（懒加载） ──────────────────

  /** 懒加载状态键：`${connId}:db${idx}:${prefix}`。 */
  private redisStateKey(connId: string, dbIndex: number, prefix: string): string {
    return `${connId}:db${dbIndex}:${prefix}`;
  }

  /** 加载某前缀下的一页键（首次即首页）；供展开与「加载更多」调用。 */
  async loadMoreRedisKeys(node: DbTreeNode): Promise<void> {
    const conn = node.conn;
    if (!conn || node.redisDbIndex === undefined) return;
    const prefix = node.redisKeyPrefix ?? '';
    const stateKey = this.redisStateKey(conn.id, node.redisDbIndex, prefix);
    // 已达上限：不再续扫（提示节点由 buildRedisKeyChildren 给出）。
    if ((this.redisKeys.get(stateKey)?.length ?? 0) >= REDIS_TREE_MAX) {
      this.redisScanned.add(stateKey);
      return;
    }
    const cursor = this.redisCursors.get(stateKey) ?? '0';
    const sep = conn.keySeparator || ':';
    const dbKey = `${conn.id}:db${node.redisDbIndex}`;
    // 搜索态（仅根级）优先用用户 match；否则文件夹用前缀 pattern。
    const match = prefix === '' ? this.redisMatches.get(dbKey) : undefined;
    const pattern = match ?? (prefix ? redisPrefixPattern(prefix, sep) : undefined);
    try {
      const session = await this.manager.connect(conn);
      if (session.kind !== 'redis') return;
      const client = session.client;
      const dbIndex = node.redisDbIndex;
      await client.runExclusive(async () => {
        if (!client.isCluster && dbIndex !== session.db) {
          await redisSelect(client, dbIndex);
          session.db = dbIndex;
        }
        const page = await redisScan(client, cursor, { match: pattern, count: REDIS_TREE_PAGE });
        const acc = this.redisKeys.get(stateKey) ?? [];
        const merged = [...new Set([...acc, ...page.keys])];
        this.redisKeys.set(stateKey, merged.slice(0, REDIS_TREE_MAX));
        this.redisCursors.set(stateKey, page.cursor);
      });
      this.redisScanned.add(stateKey);
    } catch (err) {
      diagError('redis key tree scan failed', (err as Error).message);
      this.redisScanned.add(stateKey);
    }
  }

  /** 由已加载 key 生成子节点：搜索态为扁平结果，否则折叠文件夹；末尾「加载更多」/上限提示。 */
  private async buildRedisKeyChildren(parent: DbTreeNode, prefix: string): Promise<DbTreeNode[]> {
    const conn = parent.conn;
    if (!conn || parent.redisDbIndex === undefined) return [];
    const stateKey = this.redisStateKey(conn.id, parent.redisDbIndex, prefix);
    if (!this.redisScanned.has(stateKey)) await this.loadMoreRedisKeys(parent);
    const keys = this.redisKeys.get(stateKey) ?? [];
    const searching = prefix === '' && this.redisMatches.has(`${conn.id}:db${parent.redisDbIndex}`);
    const group = searching
      ? { folders: [], keys: [...keys].sort() }
      : groupRedisKeyChildren(keys, prefix, conn.keySeparator || ':');
    const folderNodes = group.folders.map((f) => {
      const n = new DbTreeNode(f.name, TreeItemCollapsibleState.Collapsed, NodeKind.RedisKeyFolder, conn, undefined, parent);
      n.redisDbIndex = parent.redisDbIndex;
      n.redisKeyPrefix = f.prefix;
      n.id = `${conn.id}:db${parent.redisDbIndex}:f:${f.prefix}`;
      return n;
    });
    const keyNodes = group.keys.map((k) => this.redisKeyNode(parent, k));
    const out = [...folderNodes, ...keyNodes];
    if (keys.length >= REDIS_TREE_MAX) {
      out.push(this.redisNoticeNode(parent, l10n('redis.tree.capReached', { max: String(REDIS_TREE_MAX) })));
    } else if ((this.redisCursors.get(stateKey) ?? '0') !== '0') {
      out.push(this.redisLoadMoreNode(parent, prefix));
    }
    return out;
  }

  private redisKeyNode(parent: DbTreeNode, key: string): DbTreeNode {
    const n = new DbTreeNode(key, TreeItemCollapsibleState.None, NodeKind.RedisKey, parent.conn, undefined, parent);
    n.redisDbIndex = parent.redisDbIndex;
    n.redisKey = key;
    n.id = `${parent.conn!.id}:db${parent.redisDbIndex}:k:${key}`;
    n.command = { command: 'devbelt.redis.keyBrowser', title: l10n('redis.tree.open'), arguments: [n] };
    return n;
  }

  private redisLoadMoreNode(parent: DbTreeNode, prefix: string): DbTreeNode {
    const n = new DbTreeNode(l10n('redis.tree.loadMore'), TreeItemCollapsibleState.None, NodeKind.RedisKeyLoadMore, parent.conn, undefined, parent);
    n.redisDbIndex = parent.redisDbIndex;
    n.redisKeyPrefix = prefix;
    n.id = `${parent.conn!.id}:db${parent.redisDbIndex}:more:${prefix}`;
    n.command = { command: 'devbelt.redis.loadMoreKeys', title: l10n('redis.tree.loadMore'), arguments: [n] };
    return n;
  }

  /** 上限提示节点（无命令，仅展示）。 */
  private redisNoticeNode(parent: DbTreeNode, label: string): DbTreeNode {
    const n = new DbTreeNode(label, TreeItemCollapsibleState.None, NodeKind.RedisKeyLoadMore, parent.conn, undefined, parent);
    n.redisDbIndex = parent.redisDbIndex;
    n.id = `${parent.conn!.id}:db${parent.redisDbIndex}:notice`;
    return n;
  }

  /** 向上找所属 RedisDb 节点。 */
  private findRedisDb(node: DbTreeNode): DbTreeNode | undefined {
    let n: DbTreeNode | undefined = node;
    while (n) {
      if (n.kind === NodeKind.RedisDb) return n;
      n = n.parent;
    }
    return undefined;
  }

  /**
   * 键变更（重命名/TTL/删除/新建）后重扫该 db 并保留当前搜索。
   * 清空该 db 懒加载缓存以免陈旧，再 refresh db 节点。
   */
  async refreshRedisAfterMutation(node: DbTreeNode): Promise<void> {
    const db = this.findRedisDb(node);
    if (!db?.conn || db.redisDbIndex === undefined) return;
    const dbKey = `${db.conn.id}:db${db.redisDbIndex}`;
    this.setRedisMatch(db, this.redisMatches.get(dbKey));
  }

  /** 分类节点子节点：根据分类类型查询具体对象 */
  private async buildCategoryChildren(element: DbTreeNode): Promise<DbTreeNode[]> {
    const db = element.database;
    const conn = element.conn;
    const catType = element.categoryType;
    if (!db || !conn || !catType) return [];

    if (catType === 'query') {
      const folderNodes = this.store.getQueryFolders(conn.id).map(
        (folder) =>
          new DbTreeNode(
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
          ),
      );
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
          return n;
        },
      );
      return [...folderNodes, ...queryNodes];
    }

    const session = await this.manager.connectSql(conn);
    const builder = new MetadataNodeBuilder(session.metadata);

    switch (catType) {
      case 'table':
      case 'view':
      case 'function':
      case 'event':
        return builder.build(catType, conn, db, element);
      case 'index':
        return this.buildIndexChildren(session, conn, db, element);
      case 'trigger':
        return this.buildTriggerChildren(session, conn, db, element);
      case 'foreignKey':
        return this.buildForeignKeyChildren(session, conn, db, element);
      default:
        return [];
    }
  }

  /** 索引分类子节点 */
  private async buildIndexChildren(session: any, conn: SavedConnection, db: string, element: DbTreeNode): Promise<DbTreeNode[]> {
    const table = element.parent?.label;
    if (!table) return [];
    const indexes = await session.metadata.getIndexes(table, db);
    return indexes.map((idx: any) => {
      const node = new DbTreeNode(idx.name, TreeItemCollapsibleState.None, NodeKind.Index, conn, undefined, element, undefined, db);
      node.description = [
        idx.columns?.join(', '),
        idx.isPrimary ? 'PK' : idx.isUnique ? 'UNIQUE' : '',
      ].filter(Boolean).join(' ');
      return node;
    });
  }

  /** 触发器分类子节点 */
  private async buildTriggerChildren(session: any, conn: SavedConnection, db: string, element: DbTreeNode): Promise<DbTreeNode[]> {
    const table = element.parent?.label;
    if (!table) return [];
    const triggers = await session.metadata.getTriggers(table, db);
    return triggers.map((t: any) => {
      const node = new DbTreeNode(t.name, TreeItemCollapsibleState.None, NodeKind.Trigger, conn, undefined, element, undefined, db);
      node.description = [t.timing, t.event].filter(Boolean).join(' ');
      node.command = { command: 'devbelt.viewTrigger', title: 'View', arguments: [node] };
      return node;
    });
  }

  /** 外键分类子节点（只读展示，按当前表过滤） */
  private async buildForeignKeyChildren(session: any, conn: SavedConnection, db: string, element: DbTreeNode): Promise<DbTreeNode[]> {
    const table = element.parent?.label;
    if (!table) return [];
    const fks = await session.metadata.getForeignKeys(db);
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
        node.refTable = f.refTable;
        node.refColumn = f.refColumn;
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
        return n;
      },
    );
  }

  /** 表节点子节点：列列表 + 索引/触发器/外键子分类 */
  private async buildTableChildren(element: DbTreeNode): Promise<DbTreeNode[]> {
    if (!element.conn) return [];
    const session = await this.manager.connectSql(element.conn);
    const columns = await session.metadata.getColumns(element.label, element.database);
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
    const mkCat = (type: CategoryType, label: string) => new DbTreeNode(
      label, TreeItemCollapsibleState.Collapsed, NodeKind.Category, element.conn, undefined, element, type, element.database,
    );
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
      (g) =>
        new DbTreeNode(
          g.name,
          TreeItemCollapsibleState.Collapsed,
          NodeKind.Group,
          undefined,
          g.id,
        ),
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
      (g) =>
        new DbTreeNode(
          g.name,
          TreeItemCollapsibleState.Collapsed,
          NodeKind.Group,
          undefined,
          g.id,
        ),
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
    const isRedis = conn.dbType === DatabaseType.REDIS;
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
    const pathCheck = this.pathIssues.get(conn.id);
    const hasPathIssues = !!pathCheck && !pathCheck.valid;
    if (!isOpen) {
      node.id = `closed_${conn.id}`;
      node.command = {
        command: 'devbelt.openConnection',
        title: 'Open',
        arguments: [conn],
      };
      if (hasPathIssues) {
        node.iconPath = new ThemeIcon('warning', new ThemeColor('editorWarning.foreground'));
        node.tooltip = this.pathTooltip(pathCheck.issues);
      }
    } else {
      node.id = conn.id;
      node.description = this.connVersions.get(conn.id) || '';
      const envColor = conn.environment === 'production'
        ? 'errorForeground'
        : conn.environment === 'staging'
          ? 'editorWarning.foreground'
          : 'gitDecoration.untrackedResourceForeground';
      // 用户填写的连接颜色优先（hex → 主题色 token）；否则按环境着色。
      const colorToken = connectionColorToken(conn.color);
      node.iconPath = new ThemeIcon(isRedis ? 'symbol-key' : 'server', new ThemeColor(colorToken ?? envColor));
      if (hasPathIssues) {
        node.tooltip = this.pathTooltip(pathCheck.issues);
      }
    }
    return node;
  }
}
