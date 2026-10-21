/**
 * 连接会话类型（P7 判别联合）。
 *
 * 从 connectionManager.ts 拆出，按引擎用 `kind` 判别：
 *  - SqlConnectionSession：SQL 三引擎（连接 + 查询/元数据/数据编辑/表操作服务）；
 *  - RedisConnectionSession：Redis（P7；S1 仅类型接缝，S2 接入真实会话）。
 *
 * 消费 `session.query/metadata/data/table/capabilities` 的代码只应出现在 SQL
 * 面板路径；调用 `ConnectionManager.connectSql()` / `peekSql()` 可直接拿到
 * `SqlConnectionSession`，或对联合类型调用 `assertSqlSession` 收窄。
 */
import type {
  DatabaseCapabilities,
  DataService,
  EsCapabilities,
  EsClient,
  MetadataService,
  QueryService,
  RedisClient,
  TableService,
} from '@devbelt/db-core';

/** SQL 会话：连接 + 四个服务。 */
export interface SqlConnectionSession {
  kind: 'sql';
  capabilities: DatabaseCapabilities;
  query: QueryService;
  metadata: MetadataService;
  data: DataService;
  table: TableService;
  isAlive: () => boolean;
  close: () => void;
}

/** Redis 会话：客户端 + 当前库 + 只读开关。 */
export interface RedisConnectionSession {
  kind: 'redis';
  client: RedisClient;
  /** 当前选中的逻辑库（cluster 模式无 SELECT，恒为 0）。 */
  db: number;
  /** 连接模式。 */
  mode: 'standalone' | 'cluster' | 'sentinel';
  /** 只读模式：客户端在 sendCommand 切面拦截写命令。 */
  readOnly: boolean;
  isAlive: () => boolean;
  close: () => void;
}

/** Elasticsearch 会话（P8 S1：类型接缝；S2 接线会话装配与 UI）。 */
export interface ElasticsearchConnectionSession {
  kind: 'elasticsearch';
  capabilities: EsCapabilities;
  es: EsClient;
  connId: string;
  /** 建连首次 `GET /` 已返回的版本；供树节点直接展示，避免二次 ping。 */
  serverVersion?: string | null;
  isAlive: () => boolean;
  close: () => void;
}

/** 连接会话判别联合。 */
export type ConnectionSession = SqlConnectionSession | RedisConnectionSession | ElasticsearchConnectionSession;

/** 期望 SQL 会话但拿到其它引擎时抛出。 */
export class NotSqlSessionError extends Error {
  constructor(public readonly kind: string) {
    super(`expected a SQL connection session, got '${kind}'`);
    this.name = 'NotSqlSessionError';
  }
}

/** 断言会话为 SQL 会话（TS 类型收窄）。 */
export function assertSqlSession(session: ConnectionSession): asserts session is SqlConnectionSession {
  if (session.kind !== 'sql') throw new NotSqlSessionError(session.kind);
}

/** 返回 SQL 会话，非 SQL 抛错。 */
export function requireSqlSession(session: ConnectionSession): SqlConnectionSession {
  assertSqlSession(session);
  return session;
}
