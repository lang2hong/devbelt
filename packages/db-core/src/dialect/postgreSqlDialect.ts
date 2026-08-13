import { DatabaseType } from '../types/connection';
import { validateIdent } from '../utils/validate';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta, ForeignKeyMeta, TriggerMeta } from '../types/meta';
import type { SqlDialect } from './sqlDialect';
import type { DatabaseCapabilities } from './capabilities';

/**
 * PostgreSQL 方言实现。
 */
export class PostgreSqlDialect implements SqlDialect {
  readonly dbType = DatabaseType.PG;
  readonly capabilities: DatabaseCapabilities = {
    multiDatabaseExplorer: false,
    databases: true,
    views: true,
    routines: true,
    events: false,
    users: true,
    operations: [
      'createDatabase', 'dropDatabase', 'renameTable', 'renameView', 'truncateTable',
      'getTableDefinition', 'alterTable', 'manageIndexes', 'manageRoutines', 'manageUsers',
    ],
  };

  wrap(identifier: string): string {
    return `"${identifier}"`;
  }

  getPagedSql(sql: string, offset: number, limit: number): string {
    return `${sql} LIMIT ${limit} OFFSET ${offset}`;
  }

  getDatabaseListSql(): string {
    return `SELECT datname AS name FROM pg_database WHERE datistemplate = false AND datallowconn = true`;
  }

  getTableListSql(): string {
    return `SELECT c.relname AS name, obj_description(c.oid) AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = current_schema()
      ORDER BY c.relname`;
  }

  getViewListSql(): string {
    return `SELECT c.relname AS name, obj_description(c.oid) AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'v' AND n.nspname = current_schema()
      ORDER BY c.relname`;
  }

  getFunctionListSql(): string {
    return `SELECT p.proname AS name,
        CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'f' THEN 'FUNCTION' ELSE 'FUNCTION' END AS type
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema()
      ORDER BY p.proname`;
  }

  getEventListSql(): string {
    return '';
  }

  getRoutineDefinitionSql(name: string, _routineType: string): string {
    validateIdent(name);
    return `SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = '${name}' AND n.nspname = current_schema()`;
  }

  getEventDefinitionSql(): string {
    return '';
  }

  getViewDefinitionSql(name: string): string {
    validateIdent(name);
    return `SELECT pg_get_viewdef(current_schema() || '.' || '${name}', true) AS definition`;
  }

  getIndexListSql(table: string): string {
    validateIdent(table);
    return `SELECT indexname AS name, indexdef AS definition, 
      CASE WHEN indexdef LIKE '%UNIQUE%' THEN true ELSE false END AS is_unique,
      CASE WHEN indexname = '${table}_pkey' THEN true ELSE false END AS is_primary
      FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = '${table}'`;
  }

  getUserListSql(): string {
    return `SELECT usename AS name FROM pg_user ORDER BY usename`;
  }

  getForeignKeysSql(): string {
    return `SELECT tc.table_name AS "tableName", kcu.column_name AS "columnName",
      ccu.table_name AS "refTable", ccu.column_name AS "refColumn", tc.constraint_name AS "constraintName"
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()`;
  }

  getTriggerListSql(table: string): string {
    validateIdent(table);
    return `SELECT t.tgname AS name, pg_get_triggerdef(t.oid, true) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = '${table}'`;
  }

  getTriggerDefinitionSql(name: string): string {
    validateIdent(name);
    return `SELECT pg_get_triggerdef(t.oid, true) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname = '${name}'`;
  }

  createIndexSql(name: string, table: string, columns: string[], unique: boolean): string {
    const cols = columns.map((c) => this.wrap(validateIdent(c))).join(', ');
    return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${this.wrap(validateIdent(name))} ON ${this.wrap(validateIdent(table))} (${cols})`;
  }

  dropIndexSql(name: string, _table?: string, _database?: string): string {
    return `DROP INDEX IF EXISTS ${this.wrap(validateIdent(name))}`;
  }

  dropTriggerSql(name: string, table: string): string {
    return `DROP TRIGGER IF EXISTS ${this.wrap(validateIdent(name))} ON ${this.wrap(validateIdent(table))}`;
  }

  createForeignKeySql(name: string, table: string, columns: string[], refTable: string, refColumns: string[]): string {
    const cols = columns.map((c) => this.wrap(validateIdent(c))).join(', ');
    const refCols = refColumns.map((c) => this.wrap(validateIdent(c))).join(', ');
    return `ALTER TABLE ${this.wrap(validateIdent(table))} ADD CONSTRAINT ${this.wrap(validateIdent(name))} FOREIGN KEY (${cols}) REFERENCES ${this.wrap(validateIdent(refTable))} (${refCols})`;
  }

  dropForeignKeySql(name: string, table: string): string {
    return `ALTER TABLE ${this.wrap(validateIdent(table))} DROP CONSTRAINT ${this.wrap(validateIdent(name))}`;
  }

  getProcessListSql(): string {
    return 'SELECT pid, usename, datname, client_addr AS host, state, query FROM pg_stat_activity ORDER BY pid';
  }
  getStatusVariablesSql(): string { return ''; }
  getServerVariablesSql(): string {
    return 'SELECT name, setting, short_desc AS description FROM pg_settings ORDER BY name';
  }

  getColumnsSql(table: string): string {
    validateIdent(table);
    return `SELECT column_name AS name,
        data_type AS simple_type,
        data_type AS type,
        COALESCE(column_default, '') AS default_value,
        is_nullable AS nullable,
        '' AS comment,
        '' AS key
      FROM information_schema.columns
      WHERE table_name = '${table}' AND table_schema = current_schema()
      ORDER BY ordinal_position`;
  }

  parseTableList(rows: any[]): TableMeta[] {
    return rows.map((row) => ({ name: row.name, comment: row.comment || '' }));
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

  parseEventList(): EventMeta[] {
    return [];
  }

  parseIndexList(rows: any[]): IndexMeta[] {
    return rows.map((row) => ({
      name: row.name,
      columns: [],
      isUnique: row.is_unique || false,
      isPrimary: row.is_primary || false,
      type: row.definition || '',
    }));
  }

  parseTriggerList(rows: any[]): TriggerMeta[] {
    return rows.map((row) => {
      const def: string = row.definition || '';
      const timing = (def.match(/\b(BEFORE|AFTER|INSTEAD OF)\b/i) || [])[1]?.toUpperCase();
      const event = (def.match(/\b(INSERT|UPDATE|DELETE)\b/i) || [])[1]?.toUpperCase();
      return { name: row.name, timing, event };
    });
  }

  parseUserList(rows: any[]): UserMeta[] {
    return rows.map((row) => ({ name: row.name }));
  }

  parseForeignKeys(rows: any[]): ForeignKeyMeta[] {
    return rows.map((row) => ({
      tableName: row.tableName || row.tablename,
      columnName: row.columnName || row.column_name,
      refTable: row.refTable || row.reftable,
      refColumn: row.refColumn || row.refcolumn,
      constraintName: row.constraintName || row.constraint_name,
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

  /** PostgreSQL 标准字符串：仅单引号翻倍，不转义反斜杠。 */
  private formatValue(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`;
    if (typeof value === 'object') {
      const json = JSON.stringify(value).replace(/'/g, "''");
      return `'${json}'`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }
}
