import { DatabaseType } from '../types/connection.js';

/**
 * 组合「库.表」限定名（标识符须已由调用方校验/包裹）。
 *
 * PostgreSQL 一个连接对应一个库，跨库限定名 `"db"."table"` 会被解析成 schema
 * 而非库，导致 PG 上 UPDATE/DELETE/INSERT/数据 diff 全部失败；故 PG 不限定，交由
 * 连接的 `search_path` 解析。其余方言保留 `"db"."table"` 语义。
 *
 * 与 `TableService.wrapQualified` 同源，避免各处各写一份而漂移。
 */
export function qualifyTable(dbType: DatabaseType, table: string, database?: string): string {
  if (!database || dbType === DatabaseType.PG) return table;
  return `${database}.${table}`;
}