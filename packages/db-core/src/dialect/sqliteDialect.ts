import { DatabaseType } from '../types/connection';
import { validateIdent } from '../utils/validate';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta, ForeignKeyMeta } from '../types/meta';
import type { SqlDialect } from './sqlDialect';
import type { DatabaseCapabilities } from './capabilities';

/**
 * SQLite 方言实现。
 */
export class SqliteDialect implements SqlDialect {
  readonly dbType = DatabaseType.SQLITE;
  readonly capabilities: DatabaseCapabilities = {
    multiDatabaseExplorer: false,
    databases: false,
    views: true,
    routines: false,
    events: false,
    users: false,
    operations: ['renameTable', 'getTableDefinition', 'alterTable', 'manageIndexes', 'dumpTable'],
  };

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

  getFunctionListSql(): string {
    return '';
  }

  getEventListSql(): string {
    return '';
  }

  getRoutineDefinitionSql(): string {
    return '';
  }

  getEventDefinitionSql(): string {
    return '';
  }

  getViewDefinitionSql(name: string): string {
    validateIdent(name);
    return `SELECT sql AS definition FROM sqlite_master WHERE type = 'view' AND name = '${name}'`;
  }

  getIndexListSql(table: string): string {
    validateIdent(table);
    return `SELECT name AS name, 0 AS is_unique, name LIKE 'sqlite_autoindex%' AS is_primary FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}'`;
  }

  getUserListSql(): string { return ''; }
  getProcessListSql(): string { return ''; }
  getStatusVariablesSql(): string { return ''; }
  getServerVariablesSql(): string { return ''; }

  getForeignKeysSql(): string {
    return `SELECT m.name AS tableName, fk."from" AS columnName, fk."table" AS refTable, fk."to" AS refColumn
      FROM sqlite_master m
      JOIN pragma_foreign_key_list(m.name) fk
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`;
  }

  getColumnsSql(table: string): string {
    validateIdent(table);
    return `PRAGMA table_info(${this.wrap(table)})`;
  }

  parseTableList(rows: any[]): TableMeta[] {
    return rows.map((row) => ({ name: row.name, comment: row.comment || '' }));
  }

  parseViewList(rows: any[]): ViewMeta[] {
    return rows.map((row) => ({ name: row.name, comment: row.comment || '' }));
  }

  parseFunctionList(): RoutineMeta[] {
    return [];
  }

  parseEventList(): EventMeta[] {
    return [];
  }

  parseIndexList(rows: any[]): IndexMeta[] {
    return rows.map((row) => ({
      name: row.name,
      columns: [],
      isUnique: row.is_unique || false,
      isPrimary: row.is_primary || false,
    }));
  }

  parseUserList(): UserMeta[] {
    return [];
  }

  parseForeignKeys(rows: any[]): ForeignKeyMeta[] {
    return rows.map((row) => ({
      tableName: row.tableName || row.tableName,
      columnName: row.columnName || row.columnName,
      refTable: row.refTable || row.refTable,
      refColumn: row.refColumn || row.refColumn,
    }));
  }

  buildInsertSql(rows: Record<string, any>[], columns: string[], table: string, _database?: string): string {
    // SQLite 单文件数据库，database 限定无意义，始终只限定表名。
    const validTable = validateIdent(table);
    const qualified = this.wrap(validTable);
    const colList = columns.map((c) => this.wrap(validateIdent(c))).join(', ');
    let out = '';
    for (const row of rows) {
      const values = columns.map((c) => this.formatValue(row[c])).join(', ');
      out += `INSERT INTO ${qualified} (${colList}) VALUES (${values});\n`;
    }
    return out;
  }

  /** SQLite 标准字符串：仅单引号翻倍。 */
  private formatValue(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`;
    if (typeof value === 'object') {
      const json = JSON.stringify(value).replace(/'/g, "''");
      return `'${json}'`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }
}
