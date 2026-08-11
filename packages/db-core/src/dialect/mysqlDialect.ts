import { DatabaseType } from '../types/connection';
import { validateIdent } from '../utils/validate';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta, ForeignKeyMeta } from '../types/meta';
import type { SqlDialect } from './sqlDialect';
import type { DatabaseCapabilities } from './capabilities';

/**
 * MySQL 方言实现。
 */
export class MysqlDialect implements SqlDialect {
  readonly dbType = DatabaseType.MYSQL;
  readonly capabilities: DatabaseCapabilities = {
    multiDatabaseExplorer: true,
    databases: true,
    views: true,
    routines: true,
    events: true,
    users: true,
    operations: [
      'createDatabase', 'dropDatabase', 'renameTable', 'duplicateTable',
      'truncateTable', 'getTableDefinition', 'alterTable', 'manageIndexes', 'manageRoutines',
      'manageEvents', 'manageUsers', 'dumpTable', 'schemaSync',
    ],
  };

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
    if (database) {
      validateIdent(database);
      return `SELECT TABLE_NAME AS name, TABLE_ROWS AS table_rows FROM information_schema.tables WHERE table_schema = '${database}' AND table_type = 'BASE TABLE'`;
    }
    return `SELECT TABLE_NAME AS name, TABLE_ROWS AS table_rows FROM information_schema.tables WHERE table_type = 'BASE TABLE'`;
  }

  getViewListSql(database?: string): string {
    if (database) {
      validateIdent(database);
      return `SELECT TABLE_NAME AS name FROM information_schema.views WHERE table_schema = '${database}'`;
    }
    return `SELECT TABLE_NAME AS name FROM information_schema.views`;
  }

  getFunctionListSql(database?: string): string {
    const where = database
      ? `routine_schema = '${validateIdent(database)}'`
      : `routine_schema = database()`;
    return `SELECT routine_name AS name, routine_type AS type FROM information_schema.routines WHERE ${where} ORDER BY routine_name`;
  }

  getEventListSql(database?: string): string {
    const where = database
      ? `event_schema = '${validateIdent(database)}'`
      : `event_schema = database()`;
    return `SELECT event_name AS name, definer, event_type FROM information_schema.events WHERE ${where} ORDER BY event_name`;
  }

  getRoutineDefinitionSql(name: string, routineType: string, database?: string): string {
    const validType = routineType === 'FUNCTION' || routineType === 'PROCEDURE'
      ? routineType
      : 'FUNCTION';
    const qualified = database
      ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(name))}`
      : this.wrap(validateIdent(name));
    return `SHOW CREATE ${validType} ${qualified}`;
  }

  getEventDefinitionSql(name: string, database?: string): string {
    const qualified = database
      ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(name))}`
      : this.wrap(validateIdent(name));
    return `SHOW CREATE EVENT ${qualified}`;
  }

  getViewDefinitionSql(name: string, database?: string): string {
    const qualified = database
      ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(name))}`
      : this.wrap(validateIdent(name));
    return `SHOW CREATE VIEW ${qualified}`;
  }

  getIndexListSql(table: string, database?: string): string {
    validateIdent(table);
    const where = database
      ? `table_schema = '${validateIdent(database)}' AND table_name = '${table}'`
      : `table_schema = database() AND table_name = '${table}'`;
    return `SELECT index_name AS name, column_name AS col, non_unique = 0 AS is_unique, index_name = 'PRIMARY' AS is_primary FROM information_schema.statistics WHERE ${where} ORDER BY index_name, seq_in_index`;
  }

  getUserListSql(): string {
    return `SELECT user AS name, host AS host FROM mysql.user ORDER BY user`;
  }

  getForeignKeysSql(database?: string): string {
    const where = database ? `table_schema = '${validateIdent(database)}'` : `table_schema = database()`;
    return `SELECT table_name AS tableName, column_name AS columnName, referenced_table_name AS refTable, referenced_column_name AS refColumn FROM information_schema.key_column_usage WHERE referenced_table_name IS NOT NULL AND ${where}`;
  }

  getProcessListSql(): string { return 'SHOW PROCESSLIST'; }
  getStatusVariablesSql(): string { return 'SHOW GLOBAL STATUS'; }
  getServerVariablesSql(): string { return 'SHOW VARIABLES'; }

  getColumnsSql(table: string, database?: string): string {
    validateIdent(table);
    return database
      ? `SHOW FULL COLUMNS FROM ${this.wrap(table)} FROM ${this.wrap(validateIdent(database))}`
      : `SHOW FULL COLUMNS FROM ${this.wrap(table)}`;
  }

  parseTableList(rows: any[]): TableMeta[] {
    return rows.map((row) => ({
      name: row.name,
      comment: row.comment || '',
      table_rows: row.table_rows,
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
      map.get(name)!.columns.push(row.col);
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

  parseForeignKeys(rows: any[]): ForeignKeyMeta[] {
    return rows.map((row) => ({
      tableName: row.tableName,
      columnName: row.columnName,
      refTable: row.refTable,
      refColumn: row.refColumn,
    }));
  }

  buildInsertSql(rows: Record<string, any>[], columns: string[], table: string, database?: string): string {
    const validTable = validateIdent(table);
    const qualified = database
      ? `${this.wrap(validateIdent(database))}.${this.wrap(validTable)}`
      : this.wrap(validTable);
    const colList = columns.map((c) => this.wrap(validateIdent(c))).join(', ');
    let out = '';
    for (const row of rows) {
      const values = columns.map((c) => this.formatValue(row[c])).join(', ');
      out += `INSERT INTO ${qualified} (${colList}) VALUES (${values});\n`;
    }
    return out;
  }

  /** MySQL 字符串字面量：反斜杠与单引号都需转义。 */
  private formatValue(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
    if (typeof value === 'object') {
      const json = JSON.stringify(value).replace(/\\/g, '\\\\').replace(/'/g, "''");
      return `'${json}'`;
    }
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\0/g, '\\0')}'`;
  }
}
