import { DatabaseType } from '../types/connection';
import type { TableMeta, ViewMeta } from '../types/meta';
import type { SqlDialect } from './sqlDialect';

/**
 * MySQL 方言实现。
 */
export class MysqlDialect implements SqlDialect {
  readonly dbType = DatabaseType.MYSQL;

  wrap(identifier: string): string {
    return `\`${identifier}\``;
  }

  getPagedSql(sql: string, offset: number, limit: number): string {
    return `${sql} LIMIT ${offset}, ${limit}`;
  }

  getDatabaseListSql(): string {
    return 'SHOW DATABASES';
  }

  getTableListSql(database?: string): string {
    return database
      ? `SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment, TABLE_ROWS AS table_rows, AUTO_INCREMENT AS auto_increment, DATA_LENGTH AS data_length, INDEX_LENGTH AS index_length FROM information_schema.tables WHERE table_schema = '${database}' AND table_type = 'BASE TABLE'`
      : `SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment, TABLE_ROWS AS table_rows, AUTO_INCREMENT AS auto_increment, DATA_LENGTH AS data_length, INDEX_LENGTH AS index_length FROM information_schema.tables WHERE table_type = 'BASE TABLE'`;
  }

  getViewListSql(database?: string): string {
    return database
      ? `SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment FROM information_schema.views WHERE table_schema = '${database}'`
      : `SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment FROM information_schema.views`;
  }

  getColumnsSql(table: string, database?: string): string {
    return database
      ? `SHOW FULL COLUMNS FROM ${this.wrap(table)} FROM ${this.wrap(database)}`
      : `SHOW FULL COLUMNS FROM ${this.wrap(table)}`;
  }

  parseTableList(rows: any[]): TableMeta[] {
    return rows.map((row) => ({
      name: row.name,
      comment: row.comment || '',
      table_rows: row.table_rows,
      auto_increment: row.auto_increment,
      data_length: row.data_length,
      index_length: row.index_length,
    }));
  }

  parseViewList(rows: any[]): ViewMeta[] {
    return rows.map((row) => ({ name: row.name, comment: row.comment || '' }));
  }
}