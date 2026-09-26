import { Event, EventEmitter, TreeDataProvider, TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, window } from 'vscode';
import type { CancellationToken } from 'vscode';
import { DatabaseType, DialectRegistry, redisKeyspace, redisScan, redisScanOnNode, redisSelect } from '@devbelt/db-core';
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

/** D*：Redis 键树根层每页 SCAN 数量（文件夹展开不再单独 SCAN，客户端折叠）。 */
const REDIS_TREE_PAGE = 500;
/** D*：软上限——「加载更多」累计到此即停并给出「载入全部」入口（防无界浏览卡死）。 */
const REDIS_TREE_SOFT_CAP = 20000;
/** D*：硬上限——仅「载入全部」可达（需二次确认），超出截断。 */
export const REDIS_TREE_HARD_CAP = 100000;
/** D*：cluster 逐 master 时每 master 的最小 count，避免 master 多时 count 退化。 */
const CLUSTER_MIN_PAGE = 10;

/** cluster 单页目标：按 master 数均分总页大小（每 master 至少 CLUSTER_MIN_PAGE）。 */
function clusterPageSize(masterCount: number): number {
  return Math.max(CLUSTER_MIN_PAGE, Math.ceil(REDIS_TREE_PAGE / Math.max(1, masterCount)));
}

/** 让出事件循环（长循环的每页之间调用，避免扩展宿主卡顿）。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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

  /** S5-3：Redis 只读键导航懒加载状态（key = `${connId}:db${idx}:` 根扁平集；文件夹由客户端折叠）。 */
  private readonly redisKeys = new Map<string, string[]>();
  private readonly redisCursors = new Map<string, string>();
  /** cluster：各 master 的 SCAN 游标（key 同根 stateKey）。 */
  private readonly redisClusterCursors = new Map<string, string[]>();
  private readonly redisScanned = new Set<string>();
  /** S5-3：每 db 的搜索匹配（key = `${connId}:db${idx}`，值为 Redis MATCH pattern）。 */
  private readonly redisMatches = new Map<string, string>();
  /** D*：「已全部加载」文件夹快照（key = `${connId}:db${idx}:__full__:${prefix}`）。 */
  private readonly redisFolderFull = new Map<string, { keys: string[]; complete: boolean }>();

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
    for (const k of [...this.redisClusterCursors.keys()]) if (k.startsWith(p)) this.redisClusterCursors.delete(k);
    for (const k of [...this.redisScanned]) if (k.startsWith(p)) this.redisScanned.delete(k);
    for (const k of [...this.redisMatches.keys()]) if (k.startsWith(p)) this.redisMatches.delete(k);
    for (const k of [...this.redisFolderFull.keys()]) if (k.startsWith(p)) this.redisFolderFull.delete(k);
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
    for (const k of [...this.redisClusterCursors.keys()]) if (k.startsWith(p)) this.redisClusterCursors.delete(k);
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

  // ───────────── D*：Redis 只读键导航（根扁平 SCAN + 客户端折叠） ─────────────

  /** 根层扁平集 stateKey（前缀恒为空）。 */
  private redisRootKey(connId: string, dbIndex: number): string {
    return `${connId}:db${dbIndex}:`;
  }

  /** 「已全部加载」文件夹快照 stateKey。 */
  private redisFullFolderKey(connId: string, dbIndex: number, prefix: string): string {
    return `${connId}:db${dbIndex}:__full__:${prefix}`;
  }

  /** 合并去重并截断到 cap。 */
  private mergeRedisKeys(stateKey: string, batch: readonly string[], cap: number): void {
    if (!batch.length) return;
    const acc = this.redisKeys.get(stateKey) ?? [];
    this.redisKeys.set(stateKey, [...new Set([...acc, ...batch])].slice(0, cap));
  }

  /**
   * 加载根层一页（单页，无 drain）；供首次展开与「加载更多」调用。
   * standalone/sentinel：SELECT+SCAN 同锁内原子；cluster：无 SELECT，逐 master 各自游标后合并。
   */
  async loadMoreRedisKeys(node: DbTreeNode): Promise<void> {
    const conn = node.conn;
    if (!conn || node.redisDbIndex === undefined) return;
    const dbIndex = node.redisDbIndex;
    const stateKey = this.redisRootKey(conn.id, dbIndex);
    if ((this.redisKeys.get(stateKey)?.length ?? 0) >= REDIS_TREE_SOFT_CAP) {
      this.redisScanned.add(stateKey);
      return;
    }
    const match = this.redisMatches.get(`${conn.id}:db${dbIndex}`);
    try {
      const session = await this.manager.connect(conn);
      if (session.kind !== 'redis') return;
      const client = session.client;
      await client.runExclusive(async () => {
        if (client.isCluster) {
          const nodes = client.nodes();
          const cursors = this.redisClusterCursors.get(stateKey) ?? nodes.map(() => '0');
          const next = [...cursors];
          const batch: string[] = [];
          for (let i = 0; i < nodes.length; i++) {
            const page = await redisScanOnNode(nodes[i], cursors[i] ?? '0', { match, count: clusterPageSize(nodes.length) });
            next[i] = page.cursor;
            batch.push(...page.keys);
          }
          this.redisClusterCursors.set(stateKey, next);
          this.mergeRedisKeys(stateKey, batch, REDIS_TREE_SOFT_CAP);
          return;
        }
        if (dbIndex !== session.db) {
          await redisSelect(client, dbIndex);
          session.db = dbIndex;
        }
        const cursor = this.redisCursors.get(stateKey) ?? '0';
        const page = await redisScan(client, cursor, { match, count: REDIS_TREE_PAGE });
        this.redisCursors.set(stateKey, page.cursor);
        this.mergeRedisKeys(stateKey, page.keys, REDIS_TREE_SOFT_CAP);
      });
      this.redisScanned.add(stateKey);
    } catch (err) {
      diagError('redis key tree scan failed', (err as Error).message);
      this.redisScanned.add(stateKey);
    }
  }

  /** 根层是否已扫完（standalone 单游标 / cluster 多游标全归零）。 */
  private redisTreeDone(conn: SavedConnection, dbIndex: number): boolean {
    const stateKey = this.redisRootKey(conn.id, dbIndex);
    if (conn.redisMode === 'cluster') {
      return (this.redisClusterCursors.get(stateKey) ?? []).every((c) => c === '0');
    }
    return (this.redisCursors.get(stateKey) ?? '0') === '0';
  }

  /**
   * 「加载完整文件夹」：按已转义前缀独立 SCAN 到扫完 / 硬上限 / 取消。
   * 每页之间让出事件循环；standalone 每页短锁 SELECT+SCAN（不整段占锁），cluster 无 SELECT 不进锁。
   * **仅在完整扫完时落 `__full__` 快照**；取消/中途错误不改动既有快照（避免空/部分快照把文件夹变空）。
   */
  async loadFullFolder(
    node: DbTreeNode,
    token?: CancellationToken,
    onProgress?: (loaded: number) => void,
  ): Promise<boolean> {
    const conn = node.conn;
    const dbIndex = node.redisDbIndex;
    const prefix = node.redisKeyPrefix ?? '';
    if (!conn || dbIndex === undefined || !prefix) return false;
    const pattern = redisPrefixPattern(prefix, conn.keySeparator || ':');
    const acc: string[] = [];
    let complete = false;
    try {
      const session = await this.manager.connect(conn);
      if (session.kind !== 'redis') return false;
      const client = session.client;
      if (client.isCluster) {
        const nodes = client.nodes();
        const cursors = nodes.map(() => '0');
        const doneFlags = nodes.map(() => false);
        const count = clusterPageSize(nodes.length);
        for (;;) {
          if (token?.isCancellationRequested) break;
          for (let i = 0; i < nodes.length; i++) {
            if (doneFlags[i]) continue;
            const page = await redisScanOnNode(nodes[i], cursors[i], { match: pattern, count });
            cursors[i] = page.cursor;
            acc.push(...page.keys);
            if (page.cursor === '0') doneFlags[i] = true;
          }
          onProgress?.(acc.length);
          if (doneFlags.every(Boolean)) { complete = true; break; }
          if (acc.length >= REDIS_TREE_HARD_CAP) break;
          await yieldToEventLoop();
        }
      } else {
        let cursor = '0';
        for (;;) {
          if (token?.isCancellationRequested) break;
          const page = await client.runExclusive(async () => {
            if (dbIndex !== session.db) {
              await redisSelect(client, dbIndex);
              session.db = dbIndex;
            }
            return redisScan(client, cursor, { match: pattern, count: REDIS_TREE_PAGE });
          });
          cursor = page.cursor;
          acc.push(...page.keys);
          onProgress?.(acc.length);
          if (cursor === '0') { complete = true; break; }
          if (acc.length >= REDIS_TREE_HARD_CAP) break;
          await yieldToEventLoop();
        }
      }
    } catch (err) {
      diagError('redis full folder scan failed', (err as Error).message);
      return false;
    }
    if (!complete) return false;
    this.redisFolderFull.set(this.redisFullFolderKey(conn.id, dbIndex, prefix), {
      keys: [...new Set(acc)].sort(),
      complete: true,
    });
    return true;
  }

  /**
   * 「载入全部键」：从当前游标续扫到归零 / 硬上限 / 取消，每页合并进根扁平集。
   * **不重置、不覆盖**：取消/中途错误时已加载状态保留（续扫语义，避免抹掉用户已累积的多页）。
   * 每页让出事件循环；standalone 每页短锁 SELECT+SCAN，cluster 无 SELECT 不进锁。
   */
  async loadAllRedisKeys(
    node: DbTreeNode,
    token?: CancellationToken,
    onProgress?: (loaded: number) => void,
  ): Promise<{ scanned: number; done: boolean; capped: boolean }> {
    const conn = node.conn;
    const dbIndex = node.redisDbIndex;
    if (!conn || dbIndex === undefined) return { scanned: 0, done: false, capped: false };
    const stateKey = this.redisRootKey(conn.id, dbIndex);
    const match = this.redisMatches.get(`${conn.id}:db${dbIndex}`);
    const count = (): number => this.redisKeys.get(stateKey)?.length ?? 0;
    let done = false;
    let capped = false;
    try {
      const session = await this.manager.connect(conn);
      if (session.kind !== 'redis') return { scanned: count(), done: false, capped: false };
      const client = session.client;
      if (client.isCluster) {
        const nodes = client.nodes();
        // 已有游标且全部归零 = 已扫完 → 直接 done，不再重扫（集群用游标存在性区分「未扫」）。
        const hasCursors = this.redisClusterCursors.has(stateKey);
        const cursors = [...(this.redisClusterCursors.get(stateKey) ?? nodes.map(() => '0'))];
        const doneFlags = hasCursors ? cursors.map((c) => c === '0') : nodes.map(() => false);
        if (hasCursors && doneFlags.every(Boolean) && this.redisKeys.has(stateKey)) {
          done = true;
        } else {
          let idle = 0;
          for (;;) {
            if (token?.isCancellationRequested) break;
            const before = count();
            for (let i = 0; i < nodes.length; i++) {
              if (doneFlags[i]) continue;
              const page = await redisScanOnNode(nodes[i], cursors[i], { match, count: clusterPageSize(nodes.length) });
              cursors[i] = page.cursor;
              this.mergeRedisKeys(stateKey, page.keys, REDIS_TREE_HARD_CAP);
              if (page.cursor === '0') doneFlags[i] = true;
            }
            this.redisClusterCursors.set(stateKey, cursors);
            onProgress?.(count());
            if (doneFlags.every(Boolean)) { done = true; break; }
            if (count() >= REDIS_TREE_HARD_CAP) { capped = true; break; }
            idle = count() === before ? idle + 1 : 0;
            if (idle >= 3) break; // 无进展防死循环
            await yieldToEventLoop();
          }
        }
      } else {
        const cursor = this.redisCursors.get(stateKey) ?? '0';
        // 已扫完（游标归零且已有加载集）→ 直接 done，避免从 0 重扫整库。
        if (cursor === '0' && this.redisKeys.has(stateKey)) {
          done = true;
        } else {
          let cur = cursor;
          let idle = 0;
          for (;;) {
            if (token?.isCancellationRequested) break;
            const before = count();
            const page = await client.runExclusive(async () => {
              if (dbIndex !== session.db) {
                await redisSelect(client, dbIndex);
                session.db = dbIndex;
              }
              return redisScan(client, cur, { match, count: REDIS_TREE_PAGE });
            });
            cur = page.cursor;
            this.mergeRedisKeys(stateKey, page.keys, REDIS_TREE_HARD_CAP);
            this.redisCursors.set(stateKey, cur);
            onProgress?.(count());
            if (cur === '0') { done = true; break; }
            if (count() >= REDIS_TREE_HARD_CAP) { capped = true; break; }
            idle = count() === before ? idle + 1 : 0;
            if (idle >= 3) break;
            await yieldToEventLoop();
          }
        }
      }
    } catch (err) {
      diagError('redis load all keys failed', (err as Error).message);
    }
    this.redisScanned.add(stateKey);
    return { scanned: count(), done, capped };
  }

  /**
   * 由已加载 key 生成子节点。
   *  - 根/Keys（prefix===''）：单页 SCAN → 客户端折叠；末尾唯一「加载更多」/「载入全部」。
   *  - 文件夹：优先用 `__full__` 快照，否则用根扁平集折叠（**零 SCAN**）。
   */
  private async buildRedisKeyChildren(parent: DbTreeNode, prefix: string): Promise<DbTreeNode[]> {
    const conn = parent.conn;
    const dbIndex = parent.redisDbIndex;
    if (!conn || dbIndex === undefined) return [];
    const sep = conn.keySeparator || ':';
    if (prefix === '') {
      const stateKey = this.redisRootKey(conn.id, dbIndex);
      if (!this.redisScanned.has(stateKey)) await this.loadMoreRedisKeys(parent);
      const keys = this.redisKeys.get(stateKey) ?? [];
      const searching = this.redisMatches.has(`${conn.id}:db${dbIndex}`);
      const group = searching
        ? { folders: [] as { name: string; prefix: string }[], keys: [...keys].sort() }
        : groupRedisKeyChildren(keys, '', sep);
      const out = [
        ...group.folders.map((f) => this.redisFolderNode(parent, f.name, f.prefix)),
        ...group.keys.map((k) => this.redisKeyNode(parent, k)),
      ];
      if (!searching && !this.redisTreeDone(conn, dbIndex)) {
        // 仅未扫完时给 action：达软上限→「载入全部」，否则→「加载更多」；扫完则不加节点。
        out.push(keys.length >= REDIS_TREE_SOFT_CAP ? this.redisLoadAllNode(parent) : this.redisLoadMoreNode(parent));
      }
      return out;
    }
    const full = this.redisFolderFull.get(this.redisFullFolderKey(conn.id, dbIndex, prefix));
    // 仅完整快照优先；否则回退根扁平集（取消/错误不落快照，自然不会出现空文件夹视图）。
    const keys = full?.complete ? full.keys : (this.redisKeys.get(this.redisRootKey(conn.id, dbIndex)) ?? []);
    const group = groupRedisKeyChildren(keys, prefix, sep);
    return [
      ...group.folders.map((f) => this.redisFolderNode(parent, f.name, f.prefix)),
      ...group.keys.map((k) => this.redisKeyNode(parent, k)),
    ];
  }

  private redisFolderNode(parent: DbTreeNode, name: string, prefix: string): DbTreeNode {
    const conn = parent.conn!;
    const dbIndex = parent.redisDbIndex!;
    const n = new DbTreeNode(name, TreeItemCollapsibleState.Collapsed, NodeKind.RedisKeyFolder, conn, undefined, parent);
    n.redisDbIndex = dbIndex;
    n.redisKeyPrefix = prefix;
    n.id = `${conn.id}:db${dbIndex}:f:${prefix}`;
    if (this.redisFolderFull.get(this.redisFullFolderKey(conn.id, dbIndex, prefix))?.complete) {
      n.description = l10n('redis.tree.completeBadge');
    }
    return n;
  }

  private redisKeyNode(parent: DbTreeNode, key: string): DbTreeNode {
    const n = new DbTreeNode(key, TreeItemCollapsibleState.None, NodeKind.RedisKey, parent.conn, undefined, parent);
    n.redisDbIndex = parent.redisDbIndex;
    n.redisKey = key;
    n.id = `${parent.conn!.id}:db${parent.redisDbIndex}:k:${key}`;
    n.command = { command: 'devbelt.redis.keyBrowser', title: l10n('redis.tree.open'), arguments: [n] };
    return n;
  }

  private redisLoadMoreNode(parent: DbTreeNode): DbTreeNode {
    const n = new DbTreeNode(l10n('redis.tree.loadMore'), TreeItemCollapsibleState.None, NodeKind.RedisKeyLoadMore, parent.conn, undefined, parent);
    n.redisDbIndex = parent.redisDbIndex;
    n.id = `${parent.conn!.id}:db${parent.redisDbIndex}:more`;
    n.command = { command: 'devbelt.redis.loadMoreKeys', title: l10n('redis.tree.loadMore'), arguments: [n] };
    return n;
  }

  /** 软上限提示 + 「载入全部」入口（带确认/进度，命令侧处理）。 */
  private redisLoadAllNode(parent: DbTreeNode): DbTreeNode {
    const n = new DbTreeNode(
      l10n('redis.tree.softCapReached', { max: String(REDIS_TREE_SOFT_CAP) }),
      TreeItemCollapsibleState.None,
      NodeKind.RedisKeyLoadMore,
      parent.conn,
      undefined,
      parent,
    );
    n.redisDbIndex = parent.redisDbIndex;
    n.id = `${parent.conn!.id}:db${parent.redisDbIndex}:loadall`;
    n.command = { command: 'devbelt.redis.loadAllKeys', title: l10n('redis.tree.loadAll'), arguments: [n] };
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

  /** 刷新某节点所属 RedisDb（供命令侧在 load more/load full/load all 后调用，保展开态）。 */
  refreshRedisDbNode(node: DbTreeNode): void {
    const db = this.findRedisDb(node);
    this.refreshNode(db ?? node);
  }

  /**
   * 键变更（重命名/TTL/删除/新建）后重扫该 db 并保留当前搜索。
   * 定向失效：仅删除「前缀是该键祖先路径」的 `__full__` 快照（完整快照只应存在于确实完整的文件夹），
   * 其余完整快照保留。
   */
  async refreshRedisAfterMutation(node: DbTreeNode): Promise<void> {
    const db = this.findRedisDb(node);
    if (!db?.conn || db.redisDbIndex === undefined) return;
    const { conn } = db;
    const dbIndex = db.redisDbIndex;
    const affected = node.redisKey;
    if (affected) {
      const sep = conn.keySeparator || ':';
      const p = `${conn.id}:db${dbIndex}:__full__:`;
      for (const k of [...this.redisFolderFull.keys()]) {
        if (!k.startsWith(p)) continue;
        const folderPrefix = k.slice(p.length);
        if (affected === folderPrefix || affected.startsWith(`${folderPrefix}${sep}`)) {
          this.redisFolderFull.delete(k);
        }
      }
    }
    this.setRedisMatch(db, this.redisMatches.get(`${conn.id}:db${dbIndex}`));
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
