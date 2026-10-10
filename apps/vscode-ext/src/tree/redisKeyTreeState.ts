/**
 * Redis 键树懒加载状态机（P7 S5-3 / C-1）。
 *
 * 从 `DbTreeDataProvider` 抽出：只读键导航的 SCAN 分页、按分隔符折叠、搜索 MATCH、
 * 完整文件夹快照与写后定向失效，以及加载代际（防旧页覆盖新状态）都在这里。
 *
 * 与宿主解耦，只依赖两个注入：
 *  - `connect`：按连接取会话（provider 注入 `ConnectionManager.connect`）；
 *  - `refreshNode`：定向刷新树节点（provider 注入自身 `refreshNode`）。
 * 不 import `ConnectionManager`，便于单测并避免环依赖。
 */
import { TreeItemCollapsibleState, window } from 'vscode';
import type { CancellationToken } from 'vscode';
import { redisScan, redisScanOnNode, redisSelect } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { ConnectionSession } from '../connection/connectionSession';
import { DbTreeNode, NodeKind } from './dbTreeNode';
import { groupRedisKeyChildren, redisPrefixPattern } from '../result/redisKeyFold';
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

/** 按连接取会话（provider 注入；返回判别联合，内部按 kind 收窄）。 */
export type RedisConnectFn = (conn: SavedConnection) => Promise<ConnectionSession>;

/**
 * Redis 只读键导航的状态与懒加载逻辑。
 */
export class RedisKeyTreeState {
  /** key = `${connId}:db${idx}:` 根扁平集；文件夹由客户端折叠。 */
  private readonly redisKeys = new Map<string, string[]>();
  private readonly redisCursors = new Map<string, string>();
  /** cluster：各 master 的 SCAN 游标（key 同根 stateKey）。 */
  private readonly redisClusterCursors = new Map<string, string[]>();
  private readonly redisScanned = new Set<string>();
  /** 上次扫描失败的 db（key 同 stateKey）：失败不算扫完，保留「加载更多」可重试。 */
  private readonly redisScanError = new Set<string>();
  /** S5-3：每 db 的搜索匹配（key = `${connId}:db${idx}`，值为 Redis MATCH pattern）。 */
  private readonly redisMatches = new Map<string, string>();
  /** D*：「已全部加载」文件夹快照（key = `${connId}:db${idx}:__full__:${prefix}`）。 */
  private readonly redisFolderFull = new Map<string, { keys: string[]; complete: boolean }>();
  /** S5-2：文件夹增量 SCAN 游标（每前缀，不整段占锁、不落全量快照）。 */
  private readonly redisFolderCursors = new Map<string, string>();
  /** S5-2：cluster 文件夹增量：各 master 独立游标。 */
  private readonly redisFolderClusterCursors = new Map<string, string[]>();
  /**
   * 加载代际。`redisConnGen` 按连接计（关闭连接时**无条件** +1，即使该 db 从未搜索过）；
   * `redisDbGen` 按 db 计（搜索切换/清除时 +1）。在途 SCAN 结果写回前校验二者组成的代际，
   * 已变则丢弃，避免旧页覆盖新状态或残留在已关闭连接上（D7 竞态）。
   */
  private readonly redisConnGen = new Map<string, number>();
  private readonly redisDbGen = new Map<string, number>();

  constructor(
    private readonly connect: RedisConnectFn,
    private readonly refreshNode: (node: DbTreeNode) => void,
  ) {}

  /** 读取某 db 的当前代际（连接代际:db 代际）。 */
  private redisGenOf(connId: string, dbIndex: number): string {
    return `${this.redisConnGen.get(connId) ?? 0}:${this.redisDbGen.get(`${connId}:db${dbIndex}`) ?? 0}`;
  }

  /** 使某 db 的加载代际 +1（搜索切换/清除）。 */
  private bumpRedisGen(connId: string, dbIndex: number): void {
    const k = `${connId}:db${dbIndex}`;
    this.redisDbGen.set(k, (this.redisDbGen.get(k) ?? 0) + 1);
  }

  /** 使某连接的加载代际 +1（关闭/清理；无条件，覆盖从未搜索过的 db）。 */
  private bumpRedisConnGen(connId: string): void {
    this.redisConnGen.set(connId, (this.redisConnGen.get(connId) ?? 0) + 1);
  }

  /** 清理某连接的 Redis 键树懒加载状态。 */
  clearRedisKeyState(connId: string): void {
    const p = `${connId}:`;
    for (const k of [...this.redisKeys.keys()]) if (k.startsWith(p)) this.redisKeys.delete(k);
    for (const k of [...this.redisCursors.keys()]) if (k.startsWith(p)) this.redisCursors.delete(k);
    for (const k of [...this.redisClusterCursors.keys()]) if (k.startsWith(p)) this.redisClusterCursors.delete(k);
    for (const k of [...this.redisScanned]) if (k.startsWith(p)) this.redisScanned.delete(k);
    for (const k of [...this.redisScanError]) if (k.startsWith(p)) this.redisScanError.delete(k);
    for (const k of [...this.redisMatches.keys()]) if (k.startsWith(p)) this.redisMatches.delete(k);
    for (const k of [...this.redisFolderFull.keys()]) if (k.startsWith(p)) this.redisFolderFull.delete(k);
    for (const k of [...this.redisFolderCursors.keys()]) if (k.startsWith(p)) this.redisFolderCursors.delete(k);
    for (const k of [...this.redisFolderClusterCursors.keys()]) if (k.startsWith(p)) this.redisFolderClusterCursors.delete(k);
    // 关闭：无条件递增连接代际，让在途加载作废（覆盖从未搜索过的 db）。
    this.bumpRedisConnGen(connId);
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
    for (const k of [...this.redisScanError]) if (k.startsWith(p)) this.redisScanError.delete(k);
    for (const k of [...this.redisFolderCursors.keys()]) if (k.startsWith(p)) this.redisFolderCursors.delete(k);
    for (const k of [...this.redisFolderClusterCursors.keys()]) if (k.startsWith(p)) this.redisFolderClusterCursors.delete(k);
    // 搜索切换/清除：作废在途加载，避免旧 MATCH 的结果写回。
    this.bumpRedisGen(node.conn.id, node.redisDbIndex);
    this.refreshNode(node);
  }

  /** 根层扁平集 stateKey（前缀恒为空）。 */
  private redisRootKey(connId: string, dbIndex: number): string {
    return `${connId}:db${dbIndex}:`;
  }

  /** 「已全部加载」文件夹快照 stateKey。 */
  private redisFullFolderKey(connId: string, dbIndex: number, prefix: string): string {
    return `${connId}:db${dbIndex}:__full__:${prefix}`;
  }

  /** S5-2：文件夹增量加载 stateKey（每前缀独立游标）。 */
  private redisFolderPartKey(connId: string, dbIndex: number, prefix: string): string {
    return `${connId}:db${dbIndex}:__part__:${prefix}`;
  }

  // 合并去重，不截断：SCAN 游标已越过整页，被截掉的键之后再也扫不到（软/硬 cap 只用于
  // 「停止继续扫描」——调用方在 count() >= cap 时 break），允许略微超出一页。
  private mergeRedisKeys(stateKey: string, batch: readonly string[]): void {
    if (!batch.length) return;
    const acc = this.redisKeys.get(stateKey) ?? [];
    this.redisKeys.set(stateKey, [...new Set([...acc, ...batch])]);
  }

  /**
   * 加载根层一页（单页，无 drain）；供首次展开与「加载更多」调用。
   * standalone/sentinel：SELECT+SCAN 同锁内原子；cluster：无 SELECT，逐 master 各自游标后合并。
   */
  async loadMoreRedisKeys(node: DbTreeNode): Promise<{ added: number; total: number; done: boolean; error: boolean }> {
    const conn = node.conn;
    if (!conn || node.redisDbIndex === undefined) return { added: 0, total: 0, done: true, error: false };
    const dbIndex = node.redisDbIndex;
    const stateKey = this.redisRootKey(conn.id, dbIndex);
    const before = this.redisKeys.get(stateKey)?.length ?? 0;
    if (before >= REDIS_TREE_SOFT_CAP) {
      this.redisScanned.add(stateKey);
      return { added: 0, total: before, done: this.redisTreeDone(conn, dbIndex), error: false };
    }
    const match = this.redisMatches.get(`${conn.id}:db${dbIndex}`);
    const gen = this.redisGenOf(conn.id, dbIndex);
    try {
      const session = await this.connect(conn);
      if (session.kind !== 'redis') {
        // 非 redis 会话（不变式场景）：与 catch 对称，标记为未完成/可重试。
        this.redisScanned.add(stateKey);
        this.redisScanError.add(stateKey);
        return { added: 0, total: before, done: false, error: true };
      }
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
          if (this.redisGenOf(conn.id, dbIndex) !== gen) return; // 搜索/连接已变：丢弃本页
          this.redisClusterCursors.set(stateKey, next);
          this.mergeRedisKeys(stateKey, batch);
          return;
        }
        if (dbIndex !== session.db) {
          await redisSelect(client, dbIndex);
          session.db = dbIndex;
        }
        const cursor = this.redisCursors.get(stateKey) ?? '0';
        const page = await redisScan(client, cursor, { match, count: REDIS_TREE_PAGE });
        if (this.redisGenOf(conn.id, dbIndex) !== gen) return; // 搜索/连接已变：丢弃本页
        this.redisCursors.set(stateKey, page.cursor);
        this.mergeRedisKeys(stateKey, page.keys);
      });
      if (this.redisGenOf(conn.id, dbIndex) !== gen) {
        return { added: 0, total: before, done: false, error: false };
      }
      this.redisScanned.add(stateKey);
      this.redisScanError.delete(stateKey);
      const total = this.redisKeys.get(stateKey)?.length ?? 0;
      return { added: Math.max(0, total - before), total, done: this.redisTreeDone(conn, dbIndex), error: false };
    } catch (err) {
      diagError('redis key tree scan failed', (err as Error).message);
      // 出错不算扫完：保留「加载更多」可重试（redisScanned 只挡自动重扫，不当作完成）。
      this.redisScanned.add(stateKey);
      this.redisScanError.add(stateKey);
      return { added: 0, total: before, done: false, error: true };
    }
  }

  /** 根层是否已扫完（standalone 单游标 / cluster 多游标全归零）。 */
  private redisTreeDone(conn: SavedConnection, dbIndex: number): boolean {
    const stateKey = this.redisRootKey(conn.id, dbIndex);
    if (this.redisScanError.has(stateKey)) return false; // 上次失败：未扫完，可重试
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
    const gen = this.redisGenOf(conn.id, dbIndex);
    try {
      const session = await this.connect(conn);
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
    if (this.redisGenOf(conn.id, dbIndex) !== gen) return false; // 搜索/连接已变：不落旧快照
    this.redisFolderFull.set(this.redisFullFolderKey(conn.id, dbIndex, prefix), {
      keys: [...new Set(acc)].sort(),
      complete: true,
    });
    return true;
  }

  /** 本前缀的增量游标是否已扫完（cluster 需存在且全归零；standalone 游标为 '0'）。 */
  private redisFolderScanDone(conn: SavedConnection, dbIndex: number, prefix: string): boolean {
    const key = this.redisFolderPartKey(conn.id, dbIndex, prefix);
    if (conn.redisMode === 'cluster') {
      const cursors = this.redisFolderClusterCursors.get(key);
      return !!cursors && cursors.every((c) => c === '0');
    }
    return this.redisFolderCursors.get(key) === '0';
  }

  /**
   * S5-2：文件夹增量「加载更多」——按转义前缀独立 SCAN（每前缀游标 + glob 转义），
   * 一次点击有界拉取（至多有新增/扫完/`maxPages`/硬上限），合并进根扁平集。
   * standalone 每页短锁 `[SELECT→SCAN]`；cluster 逐 master 游标推进；不落全量快照。
   */
  async loadMoreFolderKeys(
    node: DbTreeNode,
    maxPages = 10,
  ): Promise<{ added: number; total: number; done: boolean; capped: boolean; error: boolean }> {
    const conn = node.conn;
    const dbIndex = node.redisDbIndex;
    const prefix = node.redisKeyPrefix ?? '';
    if (!conn || dbIndex === undefined || !prefix) {
      return { added: 0, total: 0, done: true, capped: false, error: false };
    }
    const sep = conn.keySeparator || ':';
    const pattern = redisPrefixPattern(prefix, sep);
    const rootKey = this.redisRootKey(conn.id, dbIndex);
    const partKey = this.redisFolderPartKey(conn.id, dbIndex, prefix);
    const before = this.redisKeys.get(rootKey)?.length ?? 0;
    const gen = this.redisGenOf(conn.id, dbIndex);
    try {
      const session = await this.connect(conn);
      if (session.kind !== 'redis') {
        return { added: 0, total: before, done: false, capped: false, error: true };
      }
      const client = session.client;
      let added = 0;
      if (client.isCluster) {
        const nodes = client.nodes();
        const existing = this.redisFolderClusterCursors.get(partKey);
        const cursors = [...(existing ?? nodes.map(() => '0'))];
        const doneFlags = existing ? cursors.map((c) => c === '0') : nodes.map(() => false);
        const count = clusterPageSize(nodes.length);
        outer: for (let round = 0; round < maxPages; round++) {
          for (let i = 0; i < nodes.length; i++) {
            if (doneFlags[i]) continue;
            const page = await redisScanOnNode(nodes[i], cursors[i] ?? '0', { match: pattern, count });
            if (this.redisGenOf(conn.id, dbIndex) !== gen) break outer;
            cursors[i] = page.cursor;
            if (page.cursor === '0') doneFlags[i] = true;
            if (page.keys.length) {
              this.mergeRedisKeys(rootKey, page.keys);
              added += page.keys.length;
            }
          }
          if (added > 0 || doneFlags.every(Boolean)) break;
          if ((this.redisKeys.get(rootKey)?.length ?? 0) >= REDIS_TREE_HARD_CAP) break;
          await yieldToEventLoop();
        }
        if (this.redisGenOf(conn.id, dbIndex) === gen) this.redisFolderClusterCursors.set(partKey, cursors);
      } else {
        let cursor = this.redisFolderCursors.get(partKey) ?? '0';
        for (let page = 0; page < maxPages; page++) {
          const scanned = await client.runExclusive(async () => {
            if (dbIndex !== session.db) {
              await redisSelect(client, dbIndex);
              session.db = dbIndex;
            }
            return redisScan(client, cursor, { match: pattern, count: REDIS_TREE_PAGE });
          });
          if (this.redisGenOf(conn.id, dbIndex) !== gen) break;
          cursor = scanned.cursor;
          if (scanned.keys.length) {
            this.mergeRedisKeys(rootKey, scanned.keys);
            added += scanned.keys.length;
          }
          this.redisFolderCursors.set(partKey, cursor);
          if (added > 0 || cursor === '0') break;
          if ((this.redisKeys.get(rootKey)?.length ?? 0) >= REDIS_TREE_HARD_CAP) break;
          await yieldToEventLoop();
        }
      }
      if (this.redisGenOf(conn.id, dbIndex) !== gen) {
        return { added: 0, total: before, done: false, capped: false, error: false };
      }
      const total = this.redisKeys.get(rootKey)?.length ?? 0;
      return {
        added: Math.max(0, total - before),
        total,
        done: this.redisFolderScanDone(conn, dbIndex, prefix),
        capped: total >= REDIS_TREE_HARD_CAP,
        error: false,
      };
    } catch (err) {
      diagError('redis folder load more failed', (err as Error).message);
      return { added: 0, total: before, done: false, capped: false, error: true };
    }
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
    const gen = this.redisGenOf(conn.id, dbIndex);
    try {
      const session = await this.connect(conn);
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
              if (this.redisGenOf(conn.id, dbIndex) !== gen) break;
              cursors[i] = page.cursor;
              this.mergeRedisKeys(stateKey, page.keys);
              if (page.cursor === '0') doneFlags[i] = true;
            }
            if (this.redisGenOf(conn.id, dbIndex) !== gen) break;
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
            if (this.redisGenOf(conn.id, dbIndex) !== gen) break;
            cur = page.cursor;
            this.mergeRedisKeys(stateKey, page.keys);
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
    // 代际已变（搜索/关闭）：不把本次结果标为已扫，交由新一轮处理。
    if (this.redisGenOf(conn.id, dbIndex) !== gen) return { scanned: count(), done: false, capped: false };
    // 扫完则清除上次的失败标记（否则残留哨兵会让该库一直显示「未扫完」）。
    if (done) this.redisScanError.delete(stateKey);
    this.redisScanned.add(stateKey);
    return { scanned: count(), done, capped };
  }

  /**
   * 由已加载 key 生成子节点。
   *  - 根/Keys（prefix===''）：单页 SCAN → 客户端折叠；末尾唯一「加载更多」/「载入全部」。
   *  - 文件夹：优先用 `__full__` 快照，否则用根扁平集折叠（**零 SCAN**）。
   */
  async buildRedisKeyChildren(parent: DbTreeNode, prefix: string): Promise<DbTreeNode[]> {
    const conn = parent.conn;
    const dbIndex = parent.redisDbIndex;
    if (!conn || dbIndex === undefined) return [];
    const sep = conn.keySeparator || ':';
    if (prefix === '') {
      const stateKey = this.redisRootKey(conn.id, dbIndex);
      if (!this.redisScanned.has(stateKey)) {
        // 首次展开自动扫一页；失败也提示（否则只见空列表 + 可点「加载更多」却不知为何）。
        const res = await this.loadMoreRedisKeys(parent);
        if (res.error) window.showErrorMessage(l10n('redis.tree.loadFailed'));
      }
      const keys = this.redisKeys.get(stateKey) ?? [];
      const searching = this.redisMatches.has(`${conn.id}:db${dbIndex}`);
      const group = searching
        ? { folders: [] as { name: string; prefix: string }[], keys: [...keys].sort() }
        : groupRedisKeyChildren(keys, '', sep);
      const out = [
        ...group.folders.map((f) => this.redisFolderNode(parent, f.name, f.prefix)),
        ...group.keys.map((k) => this.redisKeyNode(parent, k)),
      ];
      // 搜索也提供续页（MATCH 由 loadMoreRedisKeys 沿用），否则大结果集只能看到第一页。
      // 达软上限→「载入全部」；扫完→不可点击的「已全部加载」哨兵；否则→「加载更多」。
      if (keys.length >= REDIS_TREE_SOFT_CAP) out.push(this.redisLoadAllNode(parent));
      else if (this.redisTreeDone(conn, dbIndex)) out.push(this.redisLoadedAllNode(parent));
      else out.push(this.redisLoadMoreNode(parent));
      return out;
    }
    const full = this.redisFolderFull.get(this.redisFullFolderKey(conn.id, dbIndex, prefix));
    // 仅完整快照优先；否则回退根扁平集（取消/错误不落快照，自然不会出现空文件夹视图）。
    const keys = full?.complete ? full.keys : (this.redisKeys.get(this.redisRootKey(conn.id, dbIndex)) ?? []);
    const group = groupRedisKeyChildren(keys, prefix, sep);
    const out = [
      ...group.folders.map((f) => this.redisFolderNode(parent, f.name, f.prefix)),
      ...group.keys.map((k) => this.redisKeyNode(parent, k)),
    ];
    // S5-2：根未扫完且本前缀未单独扫完时提供文件夹级增量入口（不触发全量）。
    if (!full?.complete && !this.redisTreeDone(conn, dbIndex) && !this.redisFolderScanDone(conn, dbIndex, prefix)) {
      out.push(this.redisFolderLoadMoreNode(parent, prefix, keys));
    }
    return out;
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
    // 已加载数量：即使本页 0 新增，数字变化也让用户知道确实点了/还能继续。
    n.description = l10n('redis.tree.loadedCount', { count: String(this.redisLoadedCount(parent)) });
    n.command = { command: 'devbelt.redis.loadMoreKeys', title: l10n('redis.tree.loadMore'), arguments: [n] };
    return n;
  }

  /** 当前 db 根层已加载键数。 */
  private redisLoadedCount(parent: DbTreeNode): number {
    if (!parent.conn || parent.redisDbIndex === undefined) return 0;
    return this.redisKeys.get(this.redisRootKey(parent.conn.id, parent.redisDbIndex))?.length ?? 0;
  }

  /** S5-2：文件夹级「加载更多」哨兵（按前缀独立游标；哨兵直接绑定 loadMoreFolderKeys）。 */
  private redisFolderLoadMoreNode(parent: DbTreeNode, prefix: string, source: readonly string[]): DbTreeNode {
    const conn = parent.conn!;
    const dbIndex = parent.redisDbIndex!;
    const n = new DbTreeNode(l10n('redis.tree.loadMore'), TreeItemCollapsibleState.None, NodeKind.RedisKeyLoadMore, conn, undefined, parent);
    n.redisDbIndex = dbIndex;
    n.redisKeyPrefix = prefix;
    n.id = `${conn.id}:db${dbIndex}:fmore:${prefix}`;
    const base = `${prefix}${conn.keySeparator || ':'}`;
    const count = source.filter((k) => k.startsWith(base)).length;
    n.description = l10n('redis.tree.loadedCount', { count: String(count) });
    n.command = { command: 'devbelt.redis.loadMoreFolderKeys', title: l10n('redis.tree.loadMore'), arguments: [n] };
    return n;
  }

  /** 根层扫完的「已全部加载」哨兵（不可点击），明确告知不会再有更多。 */
  private redisLoadedAllNode(parent: DbTreeNode): DbTreeNode {
    const n = new DbTreeNode(
      l10n('redis.tree.loadedAll', { count: String(this.redisLoadedCount(parent)) }),
      TreeItemCollapsibleState.None,
      NodeKind.RedisKeysLoadedAll,
      parent.conn,
      undefined,
      parent,
    );
    n.redisDbIndex = parent.redisDbIndex;
    n.id = `${parent.conn!.id}:db${parent.redisDbIndex}:loadedall`;
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
  async refreshRedisAfterMutation(node: DbTreeNode, invalidateAllSnapshots = false, extraAffected: readonly string[] = []): Promise<void> {
    const db = this.findRedisDb(node);
    if (!db?.conn || db.redisDbIndex === undefined) return;
    const { conn } = db;
    const dbIndex = db.redisDbIndex;
    const sep = conn.keySeparator || ':';
    const p = `${conn.id}:db${dbIndex}:__full__:`;
    // 受影响前缀：键用键名；文件夹用其前缀（此前只看 redisKey，导致删文件夹/按 pattern 删不失效快照）。
    // extraAffected 用于改名/新建：目标键名所在前缀也要失效（旧节点只带旧键名/当前节点）。
    const base = node.redisKey ?? (node.redisKeyPrefix !== undefined && node.redisKeyPrefix !== '' ? node.redisKeyPrefix : undefined);
    const affectedList = [...(base !== undefined ? [base] : []), ...extraAffected];
    for (const k of [...this.redisFolderFull.keys()]) {
      if (!k.startsWith(p)) continue;
      if (invalidateAllSnapshots || affectedList.length === 0) { this.redisFolderFull.delete(k); continue; }
      const folderPrefix = k.slice(p.length);
      // 自身/祖先（改动落在其子树）或后代（被删前缀包含它）都要失效。
      const hit = affectedList.some((a) => a === folderPrefix || a.startsWith(`${folderPrefix}${sep}`) || folderPrefix.startsWith(`${a}${sep}`));
      if (hit) this.redisFolderFull.delete(k);
    }
    this.setRedisMatch(db, this.redisMatches.get(`${conn.id}:db${dbIndex}`));
  }
}