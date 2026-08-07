import { ConnectionFactory, QueryService, MetadataService, DataService } from '@db-client/core';
import type { DatabaseType } from '@db-client/core';
import type { SavedConnection } from './connectionStore';

/**
 * 连接会话：连接 + 查询服务 + 元数据服务 + 数据编辑服务的组合。
 */
export interface ConnectionSession {
  /** 查询服务（复用 db-core） */
  query: QueryService;
  /** 元数据服务（复用 db-core） */
  metadata: MetadataService;
  /** 数据编辑服务（复用 db-core） */
  data: DataService;
  /** 关闭连接 */
  close: () => void;
}

/**
 * 连接管理器：从已保存配置创建活动连接会话。
 * 内部通过 db-core 的 ConnectionFactory 工厂创建连接并装配方言。
 */
export class ConnectionManager {
  private readonly sessions = new Map<string, ConnectionSession>();

  /**
   * 建立连接会话并缓存。
   * @param conn 已保存连接配置
   */
  async connect(conn: SavedConnection): Promise<ConnectionSession> {
    const existing = this.sessions.get(conn.id);
    if (existing) return existing;

    const { connection, dialect } = ConnectionFactory.createWithDialect(
      conn.dbType as DatabaseType,
      {
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
        database: conn.database,
        dbPath: conn.dbPath,
        useConnectionString: conn.useConnectionString,
        connectionUrl: conn.connectionUrl,
      },
    );

    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => (err ? reject(err) : resolve()));
    });

    const query = new QueryService(connection, dialect);
    const session: ConnectionSession = {
      query,
      metadata: new MetadataService(query),
      data: new DataService(query),
      close: () => {
        connection.end();
        this.sessions.delete(conn.id);
      },
    };
    this.sessions.set(conn.id, session);
    return session;
  }

  /** 关闭全部连接（扩展退出时调用） */
  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
  }
}