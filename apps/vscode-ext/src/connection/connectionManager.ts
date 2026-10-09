import { DatabaseType, withDatabaseInUrl } from '@devbelt/db-core';
import type { SqlScanOptions } from '@devbelt/db-core/sql';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { HistoryStore } from '../history/historyStore';
import { dialectScanOptions } from '../utils/sqlDialectOptions';
import { SshTunnel } from './sshTunnel';
import { validateConnectionPaths, type PathValidationResult } from './connectionPathValidator';
import { requireSqlSession, type ConnectionSession, type SqlConnectionSession } from './connectionSession';
import { buildRedisSession } from './buildRedisSession';
import { buildSqlSession } from './buildSqlSession';
import { openIsolatedSqlSession } from './buildSqlSession';
import type { SessionBuildContext } from './sessionBuildContext';
import { DEFAULT_POOL_CONFIG, DERIVED_DB_SESSION_MAX, SESSION_KEY_SEP, type PoolConfig, type SessionEntry } from './poolTypes';

// 派生会话上限转发（测试与命令侧从本模块导入）。
export { DERIVED_DB_SESSION_MAX };
// 连接池构造参数类型（构造签名的一部分，供外部类型化配置）。
export type { PoolConfig } from './poolTypes';

/** 建连前路径校验失败：阻断建连（不含完整路径内容）。 */
export class ConnectionPathError extends Error {
  constructor(public readonly result: PathValidationResult) {
    super(`connection path invalid: ${result.issues.map((i) => `${i.field}:${i.reason}`).join(', ')}`);
    this.name = 'ConnectionPathError';
  }
}

/**
 * 连接管理器：从已保存配置创建活动连接会话。
 * 内部通过 db-core 的 ConnectionFactory 工厂创建连接并装配方言。
 * 支持连接池配置、LRU 淘汰、空闲超时、健康检查。
 */
export class ConnectionManager {
  private readonly sessions = new Map<string, ConnectionSession>();
  /** 长生命周期持有者的引用计数（见 retain/release）。 */
  private readonly retains = new Map<string, number>();
  /** 正在批量导入/导出/恢复的连接：期间不得被淘汰或空闲关闭。 */
  private readonly busies = new Map<string, number>();
  private readonly sessionEntries = new Map<string, SessionEntry>();
  private readonly explicit = new Set<string>();
  private readonly connecting = new Map<string, Promise<ConnectionSession>>();
  /**
   * 连接代际：每次 dispose 递增。在途建连完成后若代际已变，说明用户
   * 已关闭/删除该连接 —— 必须建成即销毁，不能留下幽灵会话与 SSH 隧道。
   *
   * 注意：条目**有意不清理**。`disposeConn` 会先删掉 `connecting` 标记以允许立即重连，
   * 此时若清理该 id 的代际会重置为 0，让在途建连的代际比对相等而不自毁
   * （幽灵会话 + SSH 隧道泄漏）。条目数上界是历史连接 id 数，非时间增长型泄漏。
   * 如需回收，必须先把 `connecting` 改为携带代际并保留 in-flight 记录。
   */
  private readonly generations = new Map<string, number>();
  /** MySQL 服务端是否 NO_BACKSLASH_ESCAPES（按连接缓存，供切分/只读分类）。 */
  private readonly noBackslashEscapes = new Map<string, boolean>();
  /** PG 会话是否 standard_conforming_strings=off（按连接缓存，同上）。 */
  private readonly pgStdOff = new Map<string, boolean>();
  /** PG 主会话实际所在库（`conn.database` 为空时由 `current_database()` 识别；避免重复建会话）。 */
  private readonly primaryDb = new Map<string, string>();
  private readonly config: PoolConfig;
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private disposing = false;

  constructor(
    config?: Partial<PoolConfig>,
    /**
     * 查询历史。可选：测试与不需要历史的场景（如同步）可以不传。
     * 传入后，本管理器建立的每个会话都会把修改性语句写进历史。
     */
    private readonly history?: HistoryStore,
    /**
     * 有效配置解析（B3）：建连/路径校验的单一入口，把本机覆盖应用到连接上。
     * 缺省为恒等（无覆盖）。仅注入纯函数，不引入 vscode 依赖。
     */
    private readonly resolveEffective?: (conn: SavedConnection) => SavedConnection,
  ) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
    this.startHealthCheck();
  }

  /**
   * cluster over SSH 出现未映射节点时的回调（由 extension 注入：诊断 + 一次性提示）。
   * 用可选属性而非构造参数，避免改动既有构造调用与测试。
   */
  onRedisNodeUnmapped?: (connId: string, address: string) => void;

  /** 连接被关闭时回调（重连前重置如未映射提示器等按连接状态）。 */
  onConnectionClosed?: (connId: string) => void;

  private effective(conn: SavedConnection): SavedConnection {
    return this.resolveEffective ? this.resolveEffective(conn) : conn;
  }

  /** 建连所用的有效配置（本机路径覆盖优先）。供「测试连接」等复用同一套解析。 */
  effectiveConnection(conn: SavedConnection): SavedConnection {
    return this.effective(conn);
  }

  /** 当前连接代际（未记录为 0）。 */
  private generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  /** 标记该连接为用户显式打开，关闭查询/预览面板时不做自动释放。 */
  markExplicit(id: string): void {
    this.explicit.add(id);
  }

  /**
   * 取已缓存会话，不存在则返回 undefined（绝不建立新连接）。
   *
   * 用于 dispose 路径：此时调用 connect() 会在会话被释放后又建一条无人持有的
   * 新连接（连同 SSH 隧道）而泄漏。
   */
  peek(id: string, database?: string): ConnectionSession | undefined {
    const key = database !== undefined ? this.findSessionKey(id, database) : id;
    return this.sessions.get(key);
  }

  /** 取已缓存的 SQL 会话（非 SQL 会话返回 undefined）。 */
  peekSql(id: string, database?: string): SqlConnectionSession | undefined {
    const session = this.peek(id, database);
    return session && session.kind === 'sql' ? session : undefined;
  }

  /** 找到绑定该库的已缓存会话键（主会话或衍生），找不到回退衍生键。 */
  private findSessionKey(connId: string, database: string): string {
    for (const [key, entry] of this.sessionEntries) {
      if (entry.connId === connId && entry.database === database) return key;
    }
    return `${connId}${SESSION_KEY_SEP}${database}`;
  }

  /** SQL 会话在途查询数；非 SQL 会话恒为 0。 */
  private sqlInFlight(session: ConnectionSession): number {
    return session.kind === 'sql' ? session.query.inFlightCount : 0;
  }

  /**
   * 当前「已打开 + 正在建连」的连接数，用于并发连接数门禁。
   *
   * 只数 `sessions` 会漏掉建连中的会话：建连是异步的，用户连点/并发打开时
   * 多个 connect 都还没写入 sessions，门禁看不到它们，实际会超出套餐上限。
   * `connecting` 是同一 id 的建连去重表，计入即可保守拦下超额请求。
   */
  openCount(): number {
    // 同一 id 在「已入池但 finally 尚未清 connecting」的微任务窗口会同时出现在两张表，
    // 按 id 并集计数，避免瞬时双计把并发门禁误判为超限。
    // B2：PG 多库衍生会话共享同一逻辑连接，**不计**入并发连接数（按 connId 去重）。
    const ids = new Set<string>();
    for (const key of [...this.sessions.keys(), ...this.connecting.keys()]) {
      ids.add(key.split(SESSION_KEY_SEP)[0]);
    }
    return ids.size;
  }

  /** 该连接是否为用户显式打开。 */
  isExplicit(id: string): boolean {
    return this.explicit.has(id);
  }

  /**
   * 建立连接会话并缓存。
   * @param conn 已保存连接配置
   */
  /** 该连接适用的 SQL 扫描选项（含 MySQL sql_mode / PG standard_conforming_strings 影响）。 */
  scanOptionsFor(conn: SavedConnection): SqlScanOptions {
    return dialectScanOptions(conn.dbType, {
      noBackslashEscapes: this.noBackslashEscapes.get(conn.id) === true,
      standardConformingStrings: this.pgStdOff.get(conn.id) !== true,
    });
  }

  /**
   * 该连接是否处于 MySQL NO_BACKSLASH_ESCAPES 模式。
   * 供值转义（字面量/LIKE）路径判断是否翻倍反斜杠；非 MySQL 恒为 false。
   */
  noBackslashEscapesFor(conn: SavedConnection): boolean {
    return this.noBackslashEscapes.get(conn.id) === true;
  }

  async connect(conn: SavedConnection, database?: string): Promise<ConnectionSession> {
    // PG 多库：database 与连接配置不同 → 衍生库会话（键含库名）。其它引擎忽略。
    const key = this.findSessionKeyOrPrimary(conn, database);
    const existing = this.sessions.get(key);
    if (existing) {
      this.touch(key);
      if (existing.isAlive()) return existing;
      existing.close();
    }

    const inflight = this.connecting.get(key);
    if (inflight) return inflight;

    const generation = this.generation(conn.id);
    const promise = this.doConnect(conn, key === conn.id ? undefined : database, key);
    this.connecting.set(key, promise);
    try {
      const session = await promise;
      // disposeConn 可能发生在 await 期间：此时 buildSession 已自行回收，
      // 或会话已被关闭。两种情况下都不能把连接当作可用返回。
      if (this.generation(conn.id) !== generation || this.sessions.get(key) !== session) {
        throw new Error('connection was closed while it was being established');
      }
      if (!this.healthCheckTimer) this.startHealthCheck();
      return session;
    } finally {
      // 只删除自己登记的那个 promise：disposeConn 会先清掉 connecting 允许立即重连，
      // 若此处无条件 delete，会把「重连后的新 promise」误删，导致后续并发建连绕过去重。
      if (this.connecting.get(key) === promise) this.connecting.delete(key);
    }
  }

  /** 会话键：优先复用绑定该库的已有会话，否则按规则计算。 */
  private findSessionKeyOrPrimary(conn: SavedConnection, database?: string): string {
    if (conn.dbType !== DatabaseType.PG || !database) return conn.id;
    // 连接配置库，或主会话实际所在库（conn.database 为空时识别）→ 主会话。
    if (database === conn.database || database === this.primaryDb.get(conn.id)) return conn.id;
    return this.findSessionKey(conn.id, database);
  }

  /**
   * 建立并返回 SQL 会话。Redis 等非 SQL 连接不适用（会抛 NotSqlSessionError）。
   * SQL 面板路径统一用本方法，避免每处调用点手动收窄。
   *
   * @param database PG 多库：目标库；省略则用连接配置库（主会话）。
   */
  async connectSql(conn: SavedConnection, database?: string): Promise<SqlConnectionSession> {
    return requireSqlSession(await this.connect(conn, database));
  }

  /**
   * 打开一个**独立**（不入池、不与面板/树共享）的 SQL 会话，供长事务（如跨 schema 同步）
   * 使用，避免把其它面板的写入卷进该事务或一起回滚（N1）。调用方负责 `close()`；
   * SSH 隧道按本次引用建/释放。
   */
  async openIsolatedSql(conn: SavedConnection, database?: string): Promise<{ session: SqlConnectionSession; close: () => void }> {
    const effective = this.effective(conn);
    const target = database !== undefined
      ? {
          ...effective,
          database,
          ...(effective.useConnectionString && effective.connectionUrl
            ? { connectionUrl: withDatabaseInUrl(effective.connectionUrl, database) }
            : {}),
        }
      : effective;
    const pathCheck = await validateConnectionPaths(target);
    if (!pathCheck.valid) throw new ConnectionPathError(pathCheck);
    let host = target.host;
    let port = target.port;
    let tunnelLease: string | undefined;
    if (target.sshHost) {
      const acquired = await SshTunnel.create(target);
      if (acquired) { host = '127.0.0.1'; port = acquired.port; tunnelLease = acquired.lease; }
    }
    try {
      return await openIsolatedSqlSession(target, host, port, tunnelLease);
    } catch (err) {
      if (tunnelLease) SshTunnel.release(target.id, tunnelLease);
      throw err;
    }
  }

  /**
   * 建连前路径硬拒绝：已配置但缺失/不可读的本机路径直接拒绝建连，不静默降级。
   * 返回校验结果供调用方（UI 提示）使用；抛 `ConnectionPathError` 阻断建连。
   * 已缓存的活跃会话（isAlive）跳过校验（连接已建立，路径后续变化不影响既有会话）。
   */
  async validateConnectionPath(conn: SavedConnection): Promise<PathValidationResult> {
    return validateConnectionPaths(this.effective(conn));
  }

  /**
   * 真正建连。
   *
   * SSH 隧道一旦建起，**后续任何失败路径都必须关掉它**，否则隧道连同其
   * ssh2 客户端与本地监听端口会悬空。原实现只在 `connection.connect` 的
   * `.catch` 里关，而 `ConnectionFactory.createWithDialect`（不支持的 dbType 会
   * 直接 throw）、`new QueryService` 等同步构造发生在 catch 之外，
   * 那些路径会泄漏隧道。这里统一用 try/catch 兜住建隧道之后的全部逻辑。
   */
  private async doConnect(conn: SavedConnection, database: string | undefined, key: string): Promise<ConnectionSession> {
    const generation = this.generation(conn.id);
    // 有效配置（本机覆盖优先）用作建连与路径校验的唯一依据。
    const effective = this.effective(conn);
    // PG 衍生库会话：覆盖 database；用 URL 配置时同步改写 URL 里的库名，
    // 否则驱动仍会连 URL 指到的库（`database` 字段被忽略）。
    const target = database !== undefined
      ? {
          ...effective,
          database,
          ...(effective.useConnectionString && effective.connectionUrl
            ? { connectionUrl: withDatabaseInUrl(effective.connectionUrl, database) }
            : {}),
        }
      : effective;

    // 建连前强制路径硬拒绝（阶段 A 附加）：已配置但缺失/不可读即拒建。
    const pathCheck = await validateConnectionPaths(target);
    if (!pathCheck.valid) {
      throw new ConnectionPathError(pathCheck);
    }

    let host = target.host;
    let port = target.port;
    let tunnelLease: string | undefined;
    if (target.sshHost) {
      const acquired = await SshTunnel.create(target);
      if (acquired) {
        host = '127.0.0.1';
        port = acquired.port;
        tunnelLease = acquired.lease;
      }
    }

    try {
      return await this.buildSession(target, host, port, generation, key, tunnelLease);
    } catch (err) {
      // 只释放本次引用：多库会话共享同一隧道；带租约，避免关掉重建后的新隧道。
      if (tunnelLease) SshTunnel.release(target.id, tunnelLease);
      throw err;
    }
  }

  /**
   * 按引擎分派会话装配；失败由 doConnect 统一清理隧道。
   * 装配逻辑下沉到 `buildSqlSession` / `buildRedisSession`，经 `SessionBuildContext` 回调本管理器。
   */
  private async buildSession(
    conn: SavedConnection,
    host: string,
    port: number,
    generation: number,
    key: string,
    tunnelLease?: string,
  ): Promise<ConnectionSession> {
    const ctx = this.buildContext();
    if (conn.dbType === DatabaseType.REDIS) {
      return buildRedisSession(ctx, conn, host, port, generation, key, tunnelLease);
    }
    return buildSqlSession(ctx, conn, host, port, generation, key, tunnelLease);
  }

  /** 装配上下文：把管理器内部能力暴露给 session 装配模块（Phase 2 拆分）。 */
  private buildContext(): SessionBuildContext {
    const self = this;
    return {
      get disposing() { return self.disposing; },
      generation: (id) => self.generation(id),
      scanOptionsFor: (c) => self.scanOptionsFor(c),
      history: self.history,
      onRedisNodeUnmapped: (connId, address) => self.onRedisNodeUnmapped?.(connId, address),
      registerSession: (key, session, entry) => self.registerSession(key, session, entry),
      hasSessionForConn: (id) => self.hasSessionForConn(id),
      forgetSession: (key) => { self.sessions.delete(key); self.sessionEntries.delete(key); },
      clearDialectCaches: (id) => { self.noBackslashEscapes.delete(id); self.pgStdOff.delete(id); },
      clearPrimaryDb: (id) => { self.primaryDb.delete(id); },
      setNoBackslashEscapes: (id, value) => { self.noBackslashEscapes.set(id, value); },
      setPgStdOff: (id, value) => { self.pgStdOff.set(id, value); },
      setPrimaryDb: (id, value) => { self.primaryDb.set(id, value); },
      primaryDbOf: (id) => self.primaryDb.get(id),
    };
  }

  /** 会话入池：写入 sessions/sessionEntries；期间管理器销毁则自毁；随后按上限淘汰。 */
  private registerSession(key: string, session: ConnectionSession, entry: SessionEntry): void {
    this.sessions.set(key, session);
    this.sessionEntries.set(key, entry);
    if (this.disposing) {
      session.close();
      throw new Error('ConnectionManager is disposing');
    }
    // 入池后再按上限淘汰，保护刚建好的会话。
    this.evictIfNeeded(key);
  }

  /** 该连接是否仍有已缓存会话（多库衍生场景）。 */
  private hasSessionForConn(connId: string): boolean {
    for (const entry of this.sessionEntries.values()) {
      if (entry.connId === connId) return true;
    }
    return false;
  }

  /**
   * 登记一个长生命周期持有者（视图/面板）对连接的引用。
   *
   * 视图过去在关闭时直接 disposeConn：若同一连接同时被另一视图/查询使用，会把
   * 别人的会话一并杀掉（各自重新建连，浪费且可能中断在途查询）。改为引用计数：
   * release 到 0 且非用户显式打开时才真正关闭。
   */
  retain(id: string): void {
    this.retains.set(id, (this.retains.get(id) ?? 0) + 1);
  }

  /**
 * 标记连接进入「批量操作」（导入/导出/恢复）：期间不被淘汰/空闲关闭；须在 finally 释放。
 * 返回释放函数，便于 `try { ... } finally { unmark() }`。
 */
  markBusy(id: string): () => void {
    this.busies.set(id, (this.busies.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.busies.get(id) ?? 1) - 1;
      if (next > 0) this.busies.set(id, next);
      else this.busies.delete(id);
    };
  }

  /**
 * 按**会话键**登记持有：主会话用连接 id，PG 衍生库会话用 `connId\u0000库名`。
 * 返回释放函数。这样面板持有某个库的会话时，只保护那一个会话——不会被连接级持有
 * 一并豁免（否则 4 个衍生会话上限失效，B3）。
 */
  retainFor(conn: SavedConnection, database?: string): () => void {
    const derived = conn.dbType === DatabaseType.PG
      && !!database
      && database !== conn.database
      && database !== this.primaryDb.get(conn.id);
    const key = derived ? this.findSessionKey(conn.id, database!) : conn.id;
    this.retains.set(key, (this.retains.get(key) ?? 0) + 1);
    return () => this.releaseKey(key, conn.id);
  }

  /** 按会话键释放（key 为连接 id 或衍生键）。 */
  private releaseKey(key: string, connId: string): void {
    const current = this.retains.get(key);
    if (current === undefined || current <= 0) return;
    const next = current - 1;
    if (next > 0) { this.retains.set(key, next); return; }
    this.retains.delete(key);
    // 只有该连接下**所有**会话键都没人持有了，才关闭整个连接；否则仅释放本键，
    // 不能因为关掉一个库的面板就把同连接其它库的会话也关掉（H3）。
    if (!this.explicit.has(connId) && !this.hasRetainForConn(connId)) this.disposeConn(connId);
  }

  /** 该连接是否仍有任一持有（主会话键或衍生库会话键）。 */
  private hasRetainForConn(connId: string): boolean {
    for (const key of this.retains.keys()) {
      if (key === connId || key.startsWith(`${connId}${SESSION_KEY_SEP}`)) return true;
    }
    return false;
  }

  /** 释放一次 retain（连接级主会话）；计数归零且非显式打开时关闭会话。 */
  release(id: string): void {
    this.releaseKey(id, id);
  }

  /** 关闭指定连接会话（含该连接的全部 PG 衍生库会话） */
  disposeConn(id: string): void {
    // 清掉该连接的**全部**持有（主会话 + 各衍生库会话键）。
    for (const key of [...this.retains.keys()]) {
      if (key === id || key.startsWith(`${id}${SESSION_KEY_SEP}`)) this.retains.delete(key);
    }
    // 递增代际：在途建连完成后会据此自毁，不会留下幽灵会话/隧道。
    this.generations.set(id, this.generation(id) + 1);
    this.explicit.delete(id);
    for (const key of [...this.connecting.keys()]) {
      if (key.split(SESSION_KEY_SEP)[0] === id) this.connecting.delete(key);
    }
    for (const entry of [...this.sessionEntries.values()]) {
      if (entry.connId === id) this.closeEntry(entry);
    }
    if (this.sessions.size === 0) {
      this.stopHealthCheck();
    }
    this.onConnectionClosed?.(id);
  }

  /** 关闭全部连接（扩展退出时调用） */
  disposeAll(): void {
    this.disposing = true;
    this.stopHealthCheck();
    this.connecting.clear();
    this.explicit.clear();
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.sessionEntries.clear();
    for (const session of all) {
      session.close();
    }
    // 兜底：session.close() 会按 connId 关自己的隧道，但若某条隧道的会话
    // 从未装配成功（建连中途失败），它不在 sessions 里，只能靠这里清掉。
    SshTunnel.closeAll();
  }

  /** 获取当前活跃连接数 */
  get activeConnections(): number {
    return this.sessions.size;
  }

  /** 获取连接池统计信息 */
  getPoolStats(): {
    total: number;
    active: number;
    explicit: number;
    maxConnections: number;
    idleTimeoutMs: number;
    sessions: { id: string; lastUsed: number; isExplicit: boolean; isAlive: boolean; inFlight: number }[];
  } {
    const sessions: { id: string; lastUsed: number; isExplicit: boolean; isAlive: boolean; inFlight: number }[] = [];
    let active = 0;
    for (const [id, entry] of this.sessionEntries) {
      const inFlight = this.sqlInFlight(entry.session);
      if (inFlight > 0) active++;
      sessions.push({
        id,
        lastUsed: entry.lastUsed,
        isExplicit: this.explicit.has(id),
        isAlive: entry.session.isAlive(),
        inFlight,
      });
    }
    return {
      // total = 池中缓存的会话数；active = 其中有在途查询的会话数。
      // 二者曾都取 sessions.size，导致 active 恒等于 total、指标无意义。
      total: this.sessions.size,
      active,
      explicit: this.explicit.size,
      maxConnections: this.config.maxConnections,
      idleTimeoutMs: this.config.idleTimeoutMs,
      sessions,
    };
  }

  private touch(key: string): void {
    const entry = this.sessionEntries.get(key);
    if (entry) entry.lastUsed = Date.now();
  }

  /**
   * 池满淘汰 LRU。
   *
   * 过去在建连**之前**调用：池已满时先淘汰一个可用会话，再去建新连接；新连接若失败，
   * 被淘汰的会话白白断掉（抖动）。改为建连成功、新会话入池后再淘汰，并保护新会话本身，
   * 使失败路径不影响既有会话。
   */
  private evictIfNeeded(protectKey?: string): void {
    // 全局上限。
    while (this.sessions.size > this.config.maxConnections) {
      const victim = this.findLruVictim(protectKey);
      if (!victim) break;
      this.closeEntry(victim);
    }
    // B2：单连接衍生库会话上限（4 + LRU）。
    const byConn = new Map<string, SessionEntry[]>();
    for (const entry of this.sessionEntries.values()) {
      if (entry.key === entry.connId) continue; // 主会话不计
      const list = byConn.get(entry.connId) ?? [];
      list.push(entry);
      byConn.set(entry.connId, list);
    }
    for (const list of byConn.values()) {
      if (list.length <= DERIVED_DB_SESSION_MAX) continue;
      let excess = list.length - DERIVED_DB_SESSION_MAX;
      const evictable = list.filter((e) => this.isEvictable(e, protectKey)).sort((a, b) => a.lastUsed - b.lastUsed);
      for (const entry of evictable) {
        if (excess <= 0) break;
        this.closeEntry(entry);
        excess--;
      }
    }
  }

  /** 关闭并移除一个会话条目（统一出口）。 */
  private closeEntry(entry: SessionEntry): void {
    this.sessions.delete(entry.key);
    this.sessionEntries.delete(entry.key);
    // 回收该会话键上的 retain：会话已关，陈旧持有（如视图 dispose 漏 release）不应再阻塞整连接释放。
    this.retains.delete(entry.key);
    entry.session.close();
  }

  /**
   * 是否可被淘汰。沿用既有豁免：新会话本身、显式打开、被视图/面板 retain、
   * 有在途查询——保留「在用不误关」的不变量。
   */
  private isEvictable(entry: SessionEntry, protectKey?: string): boolean {
    if (entry.key === protectKey) return false;
    const isPrimary = entry.key === entry.connId;
    // 「显式打开」只保护**主会话**：PG 展开超过上限的衍生库会话仍按自身状态淘汰（B3）。
    if (isPrimary && this.explicit.has(entry.connId)) return false;
    // 被视图/面板 retain（**按会话键**）、或有在途查询的会话不淘汰。
    if (this.retains.has(entry.key)) return false;
    if (this.sqlInFlight(entry.session) > 0) return false;
    // 正在批量导入/导出/恢复的连接不能淘汰（多语句之间有间隙，inFlight 覆盖不到）。
    if ((this.busies.get(entry.connId) ?? 0) > 0) return false;
    // 有未结束事务的会话不能淘汰（否则静默回滚/丢未提交数据）。
    if (entry.session.kind === 'sql' && entry.session.query.inTransaction) return false;
    return true;
  }

  private findLruVictim(protectKey?: string): SessionEntry | undefined {
    let oldest: SessionEntry | undefined;
    for (const entry of this.sessionEntries.values()) {
      if (!this.isEvictable(entry, protectKey)) continue;
      if (!oldest || entry.lastUsed < oldest.lastUsed) {
        oldest = entry;
      }
    }
    return oldest;
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      if (this.disposing) return;
      const now = Date.now();
      const toDispose: SessionEntry[] = [];
      for (const entry of this.sessionEntries.values()) {
        // 有在途查询的会话一律跳过：健康检查不应中断正在执行的语句。
        if (this.sqlInFlight(entry.session) > 0) continue;
        // 显式打开的连接与被持有（retain）的连接豁免「空闲超时」，但仍要检测存活：
        // SSH 断开/DB 掉线后过去会一直显示为已打开、反复失败，只能手动关闭。
        const id = entry.connId;
        const inTx = entry.session.kind === 'sql' && entry.session.query.inTransaction;
        const idle = !this.explicit.has(id) && !this.retains.has(entry.key) && (this.busies.get(id) ?? 0) === 0
          && !inTx && now - entry.lastUsed > this.config.idleTimeoutMs;
        // 未结束事务的会话不因空闲关闭（会静默回滚未提交数据）；但已死连接仍回收。
        if (idle || !entry.session.isAlive()) {
          toDispose.push(entry);
        }
      }
      // 只关这个会话条目（不牵连同连接其它库会话）；全部关完则停下定时器。
      for (const entry of toDispose) {
        this.closeEntry(entry);
      }
      if (this.sessions.size === 0) this.stopHealthCheck();
    }, this.config.healthCheckIntervalMs);
  }
}
