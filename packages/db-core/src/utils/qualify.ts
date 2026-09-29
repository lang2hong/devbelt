import { DatabaseType } from '../types/connection.js';

/**
 * 组合「schema/database.表」限定名（标识符须已由调用方校验/包裹）。
 *
 * - PostgreSQL 一个连接对应一个库，跨库限定名 `"db"."table"` 会被解析成 schema
 *   而非库，导致 PG 上 UPDATE/DELETE/INSERT/DDL 全部落到错误的库/schema。多 schema
 *   支持靠**显式的 `schema` 形参**限定（`"schema"."table"`）；未给 schema 时不加
 *   限定，交回连接的 `search_path` 解析（单 schema 连接向后兼容）。
 * - 其余方言：`database` 即库名，生成 `"db"."table"`。
 *
 * 与 `TableService.wrapQualified` 同源，避免各处各写一份而漂移。
 */
export function qualifyTable(dbType: DatabaseType, table: string, database?: string, schema?: string): string {
  if (dbType === DatabaseType.PG) {
    return schema ? `${schema}.${table}` : table;
  }
  if (!database) return table;
  return `${database}.${table}`;
}