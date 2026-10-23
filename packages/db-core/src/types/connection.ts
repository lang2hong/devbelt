/**
 * 数据库方言类型。
 * 复用自原项目 DatabaseType，仅保留第一版核心类型。
 */
export enum DatabaseType {
  MYSQL = 'MYSQL',
  PG = 'PG',
  SQLITE = 'SQLITE',
  REDIS = 'REDIS',
  ELASTICSEARCH = 'ELASTICSEARCH',
}

/**
 * 引擎字符串（同步/权益口径）↔ `DatabaseType` 的**唯一**映射。
 * 同步编解码与权益门禁共用，避免多份重复表漂移（此前 redis 就因此被漏掉）。
 */
export const ENGINE_OF_DATABASE_TYPE: Record<DatabaseType, string> = {
  [DatabaseType.MYSQL]: 'mysql',
  [DatabaseType.PG]: 'postgresql',
  [DatabaseType.SQLITE]: 'sqlite',
  [DatabaseType.REDIS]: 'redis',
  [DatabaseType.ELASTICSEARCH]: 'elasticsearch',
};

const DATABASE_TYPE_OF_ENGINE: Record<string, DatabaseType> = {
  mysql: DatabaseType.MYSQL,
  postgresql: DatabaseType.PG,
  sqlite: DatabaseType.SQLITE,
  redis: DatabaseType.REDIS,
  // ES 已接入引擎枚举，但同步 codec 尚未支持：编/解码侧显式 fail-closed（见 recordCodec）。
  elasticsearch: DatabaseType.ELASTICSEARCH,
};

/** `DatabaseType` → 引擎字符串；未知枚举 fail-closed。 */
export function databaseEngineOf(dbType: DatabaseType): string {
  const engine = ENGINE_OF_DATABASE_TYPE[dbType];
  if (!engine) throw new Error(`unknown DatabaseType: ${String(dbType)}`);
  return engine;
}

/** 引擎字符串 → `DatabaseType`；未知引擎 fail-closed。 */
export function databaseTypeFromEngine(engine: string): DatabaseType {
  const t = DATABASE_TYPE_OF_ENGINE[engine];
  if (!t) throw new Error(`unknown database engine: ${engine}`);
  return t;
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
  /** 是否校验服务端证书；缺省 true（安全默认）。仅 MySQL/PostgreSQL 生效。 */
  rejectUnauthorized?: boolean;
  caPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  socketPath?: string;

  /**
   * 只读连接：在数据库层生效，不只依赖客户端 SQL 分类。
   * MySQL `SET SESSION TRANSACTION READ ONLY`；PostgreSQL
   * `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`；SQLite `.open --readonly`
   * + `PRAGMA query_only=ON`。设置失败时建连失败，不降级为可写。
   */
  readOnly?: boolean;

  /** SQLite only */
  dbPath?: string;
  /** SQLite only：sqlite3 命令路径，缺省自动探测 */
  sqliteCommand?: string;
}