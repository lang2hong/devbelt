import { DatabaseType, parseCatIndices } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type {
  ConnectionSession,
  RedisConnectionSession,
  SqlConnectionSession,
} from '../connection/connectionSession.js';

/**
 * AI 作用域（"库"）解析（P9 S7a，跨引擎）。
 *
 * "一个连接支持多库"在各引擎的形态：
 *  - MySQL/PG：多 database（`metadata.getDatabases()`；过滤系统库）；
 *  - Redis：逻辑库数字（`INFO keyspace` 非空库 ∪ `CONFIG GET databases` 上限 ∪ 当前库；cluster 恒 db0）；
 *  - ES：索引（`_cat/indices`；以 `.` 开头的系统索引过滤）；
 *  - SQLite：单文件，无作用域。
 *
 * 连接**可以没有默认库**：作用域列表是唯一必需来源，选择优先级
 * 上次选择 → 连接默认库/当前库 → 列表第一项（见 `pickScope`）。
 */
export type AiScopeKind = 'database' | 'redis-db' | 'index';

export interface ScopeList {
  kind: AiScopeKind | 'none';
  options: string[];
}

/** 系统库不进选择器（MySQL information_schema 等；PG template0/1）。 */
const SYSTEM_DATABASES = new Set([
  'information_schema',
  'mysql',
  'performance_schema',
  'sys',
  'template0',
  'template1',
]);

export function scopeKindOf(dbType: DatabaseType | string): AiScopeKind | 'none' {
  switch (dbType) {
    case DatabaseType.MYSQL:
    case DatabaseType.PG:
      return 'database';
    case DatabaseType.REDIS:
      return 'redis-db';
    case DatabaseType.ELASTICSEARCH:
      return 'index';
    default:
      return 'none';
  }
}

/** 列出连接的作用域候选（引擎与会话不匹配 / 无权限 / 网络失败 → 空列表，不抛）。 */
export async function listScopes(conn: SavedConnection, session: ConnectionSession): Promise<ScopeList> {
  const kind = scopeKindOf(conn.dbType);
  if (kind === 'none') return { kind: 'none', options: [] };
  try {
    if (kind === 'database') {
      if (session.kind !== 'sql') return { kind, options: [] };
      const dbs = await session.metadata.getDatabases();
      return { kind, options: dbs.filter((name) => !SYSTEM_DATABASES.has(name.toLowerCase())) };
    }
    if (kind === 'redis-db') {
      if (session.kind !== 'redis') return { kind, options: [] };
      return { kind, options: await listRedisDbs(session, conn) };
    }
    if (session.kind !== 'elasticsearch') return { kind, options: [] };
    const res = await session.es.request('GET', '/_cat/indices', undefined, { format: 'json' });
    if (res.status >= 400) return { kind, options: [] };
    return {
      kind,
      options: parseCatIndices(res.body)
        .map((item) => item.name)
        .filter((name) => name && !name.startsWith('.')),
    };
  } catch {
    return { kind, options: [] };
  }
}

/** 选择优先级：上次选择 → 连接默认/当前库 → 第一项；无候选返回 undefined。 */
export function pickScope(options: string[], saved?: string, preferred?: string): string | undefined {
  if (options.length === 0) return undefined;
  if (saved && options.includes(saved)) return saved;
  if (preferred && options.includes(preferred)) return preferred;
  return options[0];
}

/** 读取 SQL 会话当前所在库（MySQL `DATABASE()` / PG `current_database()`；失败/无 → undefined）。 */
export async function currentDatabase(session: SqlConnectionSession, dbType: string): Promise<string | undefined> {
  const engine = dbType.toLowerCase();
  const sql = engine === 'pg' ? 'SELECT current_database() AS db' : engine === 'mysql' ? 'SELECT DATABASE() AS db' : undefined;
  if (!sql) return undefined;
  try {
    const result = await session.query.query(sql);
    const row = (result?.rows ?? [])[0] as Record<string, unknown> | undefined;
    const value = row ? row.db ?? row.DB ?? Object.values(row)[0] : undefined;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Redis 逻辑库列表：非空库 ∪ CONFIG 上限 ∪ 当前库/配置库；cluster 恒 db0。 */
async function listRedisDbs(session: RedisConnectionSession, conn: SavedConnection): Promise<string[]> {
  if (session.client.isCluster) return ['0'];
  const dbs = new Set<number>();
  try {
    const info = await session.client.info('keyspace');
    for (const match of info.matchAll(/^db(\d+):/gm)) dbs.add(Number(match[1]));
  } catch {
    /* keyspace 读不到时仅靠 CONFIG/当前库 */
  }
  const max = await readConfiguredDatabases(session);
  if (max !== undefined && max > 0 && max <= 256) {
    for (let i = 0; i < max; i += 1) dbs.add(i);
  }
  dbs.add(Number.isInteger(session.db) ? session.db : 0);
  if (typeof conn.redisDb === 'number' && Number.isInteger(conn.redisDb)) dbs.add(conn.redisDb);
  return [...dbs].sort((a, b) => a - b).map(String);
}

/** `CONFIG GET databases`（被禁用/改名 → undefined）；兼容 flat `[k,v]` 与嵌套 `[[k,v]]`。 */
async function readConfiguredDatabases(session: RedisConnectionSession): Promise<number | undefined> {
  try {
    const res = await session.client.sendCommand('CONFIG', ['GET', 'databases']);
    return parseDatabasesCount(res);
  } catch {
    return undefined;
  }
}

export function parseDatabasesCount(res: unknown): number | undefined {
  const pairs: Array<[unknown, unknown]> = [];
  if (Array.isArray(res)) {
    if (res.length > 0 && Array.isArray(res[0])) {
      for (const item of res as unknown[]) {
        if (Array.isArray(item) && item.length >= 2) pairs.push([item[0], item[1]]);
      }
    } else {
      for (let i = 0; i + 1 < res.length; i += 2) pairs.push([res[i], res[i + 1]]);
    }
  } else if (res && typeof res === 'object') {
    const value = (res as Record<string, unknown>).databases;
    if (value !== undefined) pairs.push(['databases', value]);
  }
  for (const [key, value] of pairs) {
    if (String(key).toLowerCase() === 'databases') {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}