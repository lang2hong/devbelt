import { DatabaseType } from '../types/connection';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta } from '../types/meta';
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

  getFunctionListSql(database?: string): string {
    const where = database
      ? `routine_schema = '${database}'`
      : `routine_schema = database()`;
    return `SELECT routine_name AS name, routine_type AS type FROM information_schema.routines WHERE ${where} ORDER BY routine_name`;
  }

  getEventListSql(database?: string): string {
    const where = database
      ? `event_schema = '${database}'`
      : `event_schema = database()`;
    return `SELECT event_name AS name, definer, event_type FROM information_schema.events WHERE ${where} ORDER BY event_name`;
  }

  getRoutineDefinitionSql(name: string, routineType: string, database?: string): string {
    const qualified = database
      ? `${this.wrap(database)}.${this.wrap(name)}`
      : this.wrap(name);
    return `SHOW CREATE ${routineType} ${qualified}`;
  }

  getEventDefinitionSql(name: string, database?: string): string {
    const qualified = database
      ? `${this.wrap(database)}.${this.wrap(name)}`
      : this.wrap(name);
    return `SHOW CREATE EVENT ${qualified}`;
  }

  getIndexListSql(table: string, database?: string): string {
    const where = database
      ? `table_schema = '${database}' AND table_name = '${table}'`
      : `table_schema = database() AND table_name = '${table}'`;
    return `SELECT index_name AS name, column_name AS column, non_unique = 0 AS is_unique, index_name = 'PRIMARY' AS is_primary FROM information_schema.statistics WHERE ${where} ORDER BY index_name, seq_in_index`;
  }

  getUserListSql(): string {
    return `SELECT user AS name, host AS host FROM mysql.user ORDER BY user`;
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

  parseFunctionList(rows: any[]): RoutineMeta[] {
    return rows.map((row) => ({
      name: row.name,
      type: row.type || 'FUNCTION',
      comment: '',
    }));
  }

  parseEventList(rows: any[]): EventMeta[] {
    return rows.map((row) => ({
      name: row.name,
      definer: row.definer || '',
      eventType: row.event_type || '',
      comment: '',
    }));
  }

  parseIndexList(rows: any[]): IndexMeta[] {
    const map = new Map<string, { columns: string[]; isUnique: boolean; isPrimary: boolean }>();
    for (const row of rows) {
      const name = row.name;
      if (!map.has(name)) {
        map.set(name, { columns: [], isUnique: row.is_unique, isPrimary: row.is_primary });
      }
      map.get(name)!.columns.push(row.column);
    }
    return Array.from(map.entries()).map(([name, v]) => ({
      name,
      columns: v.columns,
      isUnique: v.isUnique,
      isPrimary: v.isPrimary,
    }));
  }

  parseUserList(rows: any[]): UserMeta[] {
    return rows.map((row) => ({ name: row.name, host: row.host || '%' }));
  }
}