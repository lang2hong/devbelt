import { ConnectionFactory, QueryService, MetadataService, DataService, TableService } from '@db-client/core';
import type { DatabaseType } from '@db-client/core';
import type { DatabaseCapabilities } from '@db-client/core';
import type { SavedConnection } from './connectionStore';
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

/**
 * 连接管理器：从已保存配置创建活动连接会话。
 * 内部通过 db-core 的 ConnectionFactory 工厂创建连接并装配方言。
 * 支持连接池配置、LRU 淘汰、空闲超时、健康检查。
 */
export class ConnectionManager {
  private readonly sessions = new Map<string, ConnectionSession>();
  private readonly sessionEntries = new Map<string, SessionEntry>();
  private readonly explicit = new Set<string>();
  private readonly config: PoolConfig;
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor(config?: Partial<PoolConfig>) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
    this.startHealthCheck();
  }

  /** 标记该连接为用户显式打开，关闭查询/预览面板时不做自动释放。 */
  markExplicit(id: string): void {
    this.explicit.add(id);
  }

  /** 该连接是否为用户显式打开。 */
  isExplicit(id: string): boolean {
    return this.explicit.has(id);
  }

  /**
   * 建立连接会话并缓存。
   * @param conn 已保存连接配置
   */
  async connect(conn: SavedConnection): Promise<ConnectionSession> {
    const existing = this.sessions.get(conn.id);
    if (existing) {
      this.touch(conn.id);
      if (existing.isAlive()) return existing;
      existing.close();
    }

    this.evictIfNeeded();

    let host = conn.host;
    let port = conn.port;
    if (conn.sshHost) {
      const localPort = await SshTunnel.create(conn);
      if (localPort) {
        host = '127.0.0.1';
        port = localPort;
      }
    }

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
    }).catch((err) => {
      if (conn.sshHost) SshTunnel.close(conn.id);
      throw err;
    });

    const query = new QueryService(connection, dialect);
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
    return session;
  }

  /** 关闭指定连接会话 */
  disposeConn(id: string): void {
    this.explicit.delete(id);
    const session = this.sessions.get(id);
    if (session) {
      session.close();
    }
  }

  /** 关闭全部连接（扩展退出时调用） */
  disposeAll(): void {
    if (this.healthCheckTimer) { clearInterval(this.healthCheckTimer); this.healthCheckTimer = undefined; }
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
    this.sessionEntries.clear();
    this.explicit.clear();
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
    sessions: { id: string; lastUsed: number; isExplicit: boolean; isAlive: boolean }[];
  } {
    const sessions: { id: string; lastUsed: number; isExplicit: boolean; isAlive: boolean }[] = [];
    for (const [id, entry] of this.sessionEntries) {
      sessions.push({
        id,
        lastUsed: entry.lastUsed,
        isExplicit: this.explicit.has(id),
        isAlive: entry.session.isAlive(),
      });
    }
    return {
      total: this.sessions.size,
      active: this.sessions.size,
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

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.sessionEntries) {
        if (this.explicit.has(id)) continue;
        if (now - entry.lastUsed > this.config.idleTimeoutMs) {
          this.disposeConn(id);
        } else if (!entry.session.isAlive()) {
          this.disposeConn(id);
        }
      }
    }, this.config.healthCheckIntervalMs);
  }
}
