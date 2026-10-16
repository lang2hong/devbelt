import { DatabaseType, validateIdent } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { classifyWriteKind } from '../utils/sqlRisk';
import type { ConnectionManager } from '../connection/connectionManager.js';

/**
 * 命令侧 EXPLAIN（只读；需活动连接）。
 *
 * 与 QueryRunner.doExplain 同规则：SQLite 用 EXPLAIN QUERY PLAN（人类可读）、
 * MySQL/PG 用不带 ANALYZE 的 EXPLAIN（无写库副作用）、DDL 跳过。
 * 这里独立实现（命令不持有 TableQueryView 的 runner），返回格式化文本供 optimize prompt。
 */
export async function runExplain(
  manager: ConnectionManager,
  conn: SavedConnection,
  database: string | undefined,
  sql: string,
): Promise<string | undefined> {
  try {
    const session = await manager.connectSql(conn, database);
    const db = database || conn.database;
    if (db && conn.dbType === DatabaseType.MYSQL) {
      await session.query.query(`USE ${session.query.wrap(validateIdent(db))}`);
    }
    const prefix = conn.dbType === DatabaseType.SQLITE ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
    const scanOptions = manager.scanOptionsFor?.(conn);
    const ddl = classifyWriteKind(sql, scanOptions) === 'ddl';
    if (ddl) return undefined;
    const result = await session.query.query(`${prefix}${sql}`);
    const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
    return rows.map((row) => JSON.stringify(row)).join('\n') || undefined;
  } catch {
    return undefined; // 取不到计划不阻塞 optimize（prompt 里会省略 EXPLAIN 段）
  }
}