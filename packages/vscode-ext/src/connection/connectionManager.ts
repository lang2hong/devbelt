import { ConnectionFactory, QueryService, MetadataService, DataService, TableService } from '@db-client/core';
import type { DatabaseType } from '@db-client/core';
import type { DatabaseCapabilities } from '@db-client/core';
import type { SavedConnection } from './connectionStore';
import { SshTunnel } from './sshTunnel';

/**
 * 连接会话：连接 + 查询/元数据/数据编辑/表操作服务的组合。
 */
export interface ConnectionSession {
  capabilities: DatabaseCapabilities;
  /** 查询服务（复用 db-core） */
  query: QueryService;
  /** 元数据服务（复用 db-core） */
  metadata: MetadataService;
  /** 数据编辑服务（复用 db-core） */
  data: DataService;
  /** 表操作服务（复用 db-core） */
  table: TableService;
  /** 关闭连接 */
  close: () => void;
}

/**
 * 连接管理器：从已保存配置创建活动连接会话。
 * 内部通过 db-core 的 ConnectionFactory 工厂创建连接并装配方言。
 */
export class ConnectionManager {
  private readonly sessions = new Map<string, ConnectionSession>();
  /** 用户显式“打开连接”的 id（树中打开），不受查询视图关闭时的自动释放影响。 */
  private readonly explicit = new Set<string>();

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
    if (existing) return existing;

    // SSH 隧道：如有配置则建隧道，用本地端口替换远程 host:port
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
      close: () => {
        connection.end();
        this.sessions.delete(conn.id);
        if (conn.sshHost) SshTunnel.close(conn.id);
      },
    };
    this.sessions.set(conn.id, session);
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
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
    this.explicit.clear();
    SshTunnel.closeAll();
  }
}
