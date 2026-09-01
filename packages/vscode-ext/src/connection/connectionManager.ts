import { ConnectionFactory, QueryService, MetadataService, DataService, TableService } from '@db-client/core';
import type { DatabaseType } from '@db-client/core';
import type { DatabaseCapabilities } from '@db-client/core';
import type { SavedConnection } from './connectionStore';
import type { HistoryStore } from '../history/historyStore';
import { assertPersonalDatabaseType, isOrganizationConnectionId } from '../sync/entitlementGate';
import type { CachedEntitlement } from '../sync/authService';
import { QueryHistoryRecorder } from '../history/queryHistoryRecorder';
import { SshTunnel } from './sshTunnel';

export interface PoolConfig {
  maxConnections: number;
  idleTimeoutMs: number;
  healthCheckIntervalMs: number;
}

const DEFAULT_POOL_CONFIG: PoolConfig = {
  maxConnections: 10,
  idleTimeoutMs: 300_000,
  healthCheckIntervalMs: 60_000,
};

/**
 * 连接会话：连接 + 查询/元数据/数据编辑/表操作服务的组合。
 */
export interface ConnectionSession {
  capabilities: DatabaseCapabilities;
  query: QueryService;
  metadata: MetadataService;
  data: DataService;
  table: TableService;
  isAlive: () => boolean;
  close: () => void;
}

interface SessionEntry {
  session: ConnectionSession;
  lastUsed: number;
  connId: string;
}

/** 建连归属：个人连接受个人权益门禁；组织连接走 organization 模板权益口径。 */
export type ConnectScope = 'personal' | 'organization';

export interface ConnectOptions {
  scope?: ConnectScope;
}

/**
 * 连接管理器：从已保存配置创建活动连接会话。
 * 内部通过 db-core 的 ConnectionFactory 工厂创建连接并装配方言。
 * 支持连接池配置、LRU 淘汰、空闲超时、健康检查。
 */
export class ConnectionManager {
  private readonly sessions = new Map<string, ConnectionSession>();
  private readonly sessionEntries = new Map<string, SessionEntry>();
  private readonly explicit = new Set<string>();
  private readonly connecting = new Map<string, Promise<ConnectionSession>>();
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
    /** 个人权益 getter（门禁用）；注入后建连前会校验个人连接引擎。组织连接跳过。 */
    private readonly getPersonalEntitlement?: () => CachedEntitlement | undefined,
  ) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
    this.startHealthCheck();
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
  peek(id: string): ConnectionSession | undefined {
    return this.sessions.get(id);
  }

  /** 该连接是否为用户显式打开。 */
  isExplicit(id: string): boolean {
    return this.explicit.has(id);
  }

  /**
   * 建立连接会话并缓存。
   * @param conn 已保存连接配置
   */
  async connect(conn: SavedConnection, opts?: ConnectOptions): Promise<ConnectionSession> {
    this.assertEngineScope(conn, opts?.scope ?? 'personal');
    const existing = this.sessions.get(conn.id);
    if (existing) {
      this.touch(conn.id);
      if (existing.isAlive()) return existing;
      existing.close();
    }

    const inflight = this.connecting.get(conn.id);
    if (inflight) return inflight;

    const promise = this.doConnect(conn);
    this.connecting.set(conn.id, promise);
    try {
      const session = await promise;
      if (!this.healthCheckTimer) this.startHealthCheck();
      return session;
    } finally {
      this.connecting.delete(conn.id);
    }
  }

  /** 建连前的个人权益门禁：组织连接（显式 scope 或 org: 前缀 id）跳过；个人连接 fail-closed 到 Free。 */
  private assertEngineScope(conn: SavedConnection, scope: ConnectScope): void {
    if (scope === 'organization' || isOrganizationConnectionId(conn.id)) return;
    assertPersonalDatabaseType(conn.dbType, this.getPersonalEntitlement?.());
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
  private async doConnect(conn: SavedConnection): Promise<ConnectionSession> {
    this.evictIfNeeded();

    let host = conn.host;
    let port = conn.port;
    let tunnelOpened = false;
    if (conn.sshHost) {
      const localPort = await SshTunnel.create(conn);
      if (localPort) {
        host = '127.0.0.1';
        port = localPort;
        tunnelOpened = true;
      }
    }

    try {
      return await this.buildSession(conn, host, port);
    } catch (err) {
      if (tunnelOpened) SshTunnel.close(conn.id);
      throw err;
    }
  }

  /** 装配连接与四个服务；失败由 doConnect 统一清理隧道。 */
  private async buildSession(
    conn: SavedConnection,
    host: string,
    port: number,
  ): Promise<ConnectionSession> {
    const { connection, dialect } = ConnectionFactory.createWithDialect(
      conn.dbType as DatabaseType,
      {
        host,
        port,
        user: conn.user,
        password: conn.password,
        database: conn.database,
        schema: conn.schema,
        timezone: conn.timezone,
        connectTimeout: conn.connectTimeout,
        requestTimeout: conn.requestTimeout,
        dbPath: conn.dbPath,
        useConnectionString: conn.useConnectionString,
        connectionUrl: conn.connectionUrl,
        useSSL: conn.useSSL,
        caPath: conn.caPath,
        clientCertPath: conn.clientCertPath,
        clientKeyPath: conn.clientKeyPath,
        socketPath: conn.socketPath,
      },
    );

    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => (err ? reject(err) : resolve()));
    });

    // 观察者挂在 QueryService 上，于是这条会话上**任何**修改性语句都会进历史，
    // 无论它来自编辑器、结果网格、表设计器还是树右键命令。
    const recorder = this.history ? new QueryHistoryRecorder(conn, this.history) : undefined;
    const query = new QueryService(connection, dialect, recorder?.observer());
    const session: ConnectionSession = {
      capabilities: dialect.capabilities,
      query,
      metadata: new MetadataService(query),
      data: new DataService(query),
      table: new TableService(query),
      isAlive: () => connection.isAlive(),
      close: () => {
        connection.end();
        this.sessions.delete(conn.id);
        this.sessionEntries.delete(conn.id);
        if (conn.sshHost) SshTunnel.close(conn.id);
      },
    };
    this.sessions.set(conn.id, session);
    this.sessionEntries.set(conn.id, { session, lastUsed: Date.now(), connId: conn.id });
    if (this.disposing) {
      session.close();
      throw new Error('ConnectionManager is disposing');
    }
    return session;
  }

  /** 关闭指定连接会话 */
  disposeConn(id: string): void {
    this.explicit.delete(id);
    this.connecting.delete(id);
    const session = this.sessions.get(id);
    if (session) {
      session.close();
    }
    if (this.sessions.size === 0) {
      this.stopHealthCheck();
    }
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
      const inFlight = entry.session.query.inFlightCount;
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

  private touch(connId: string): void {
    const entry = this.sessionEntries.get(connId);
    if (entry) entry.lastUsed = Date.now();
  }

  private evictIfNeeded(): void {
    while (this.sessions.size >= this.config.maxConnections) {
      const victim = this.findLruVictim();
      if (!victim) break;
      this.sessions.delete(victim.connId);
      this.sessionEntries.delete(victim.connId);
      victim.session.close();
    }
  }

  private findLruVictim(): SessionEntry | undefined {
    let oldest: SessionEntry | undefined;
    for (const entry of this.sessionEntries.values()) {
      if (this.explicit.has(entry.connId)) continue;
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
      const toDispose: string[] = [];
      for (const [id, entry] of this.sessionEntries) {
        if (this.explicit.has(id)) continue;
        if (now - entry.lastUsed > this.config.idleTimeoutMs || !entry.session.isAlive()) {
          toDispose.push(id);
        }
      }
      for (const id of toDispose) {
        this.disposeConn(id);
      }
    }, this.config.healthCheckIntervalMs);
  }
}
