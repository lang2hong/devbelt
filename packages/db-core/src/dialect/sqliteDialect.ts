import { DatabaseType } from '../types/connection';
import type { TableMeta, ViewMeta } from '../types/meta';
import type { SqlDialect } from './sqlDialect';

/**
 * SQLite 方言实现。
 */
export class SqliteDialect implements SqlDialect {
  readonly dbType = DatabaseType.SQLITE;

  wrap(identifier: string): string {
    return `"${identifier}"`;
  }

  getPagedSql(sql: string, offset: number, limit: number): string {
    return `${sql} LIMIT ${limit} OFFSET ${offset}`;
  }

  getDatabaseListSql(): string {
    // SQLite 单文件数据库，无库列表概念，返回空
    return '';
  }

  getTableListSql(): string {
    return `SELECT name AS name, '' AS comment FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;
  }

  getViewListSql(): string {
    return `SELECT name AS name, '' AS comment FROM sqlite_master WHERE type = 'view' ORDER BY name`;
  }

  getColumnsSql(table: string): string {
    return `PRAGMA table_info(${this.wrap(table)})`;
  }

  parseTableList(rows: any[]): TableMeta[] {
    return rows.map((row) => ({ name: row.name, comment: row.comment || '' }));
  }

  parseViewList(rows: any[]): ViewMeta[] {
    return rows.map((row) => ({ name: row.name, comment: row.comment || '' }));
  }
}