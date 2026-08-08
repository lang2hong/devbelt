/**
 * 数据库方言类型。
 * 复用自原项目 DatabaseType，仅保留第一版核心类型。
 */
export enum DatabaseType {
  MYSQL = 'MYSQL',
  PG = 'PG',
  SQLITE = 'SQLITE',
}

/**
 * 连接配置（纯数据，无 vscode 依赖）。
 * 从原项目 Node 的连接配置字段剥离而来，供各方言连接适配器消费。
 */
export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  schema?: string;
  timezone?: string;
  connectTimeout?: number;
  requestTimeout?: number;

  /** 连接串直连模式 */
  useConnectionString?: boolean;
  connectionUrl?: string;

  /** SSL */
  useSSL?: boolean;
  caPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  socketPath?: string;

  /** SQLite only */
  dbPath?: string;
  /** SQLite only：sqlite3 命令路径，缺省自动探测 */
  sqliteCommand?: string;
}