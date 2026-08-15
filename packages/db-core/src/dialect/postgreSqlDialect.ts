import { DatabaseType } from '../types/connection';
import { validateIdent } from '../utils/validate';
import { toBool } from '../utils/coerce';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta, ForeignKeyMeta, TriggerMeta } from '../types/meta';
import type { SqlDialect } from './sqlDialect';
import type { DatabaseCapabilities } from './capabilities';
import { columnTypesFor } from './typeCatalog';

/**
 * PostgreSQL 方言实现。
 */
export class PostgreSqlDialect implements SqlDialect {
  readonly dbType = DatabaseType.PG;
  readonly columnTypes = columnTypesFor(DatabaseType.PG);

  createTableTemplate(table: string): string {
    return `CREATE TABLE IF NOT EXISTS ${table} (\n  "id" SERIAL PRIMARY KEY,\n  "name" VARCHAR(255)\n);`;
  }

  /** PG 无 DELIMITER 概念，函数体用 $$ 包裹并声明语言。 */
  createRoutineTemplate(name: string): string {
    return `CREATE OR REPLACE FUNCTION ${name}()\nRETURNS void AS $$\nBEGIN\n  -- function body\nEND;\n$$ LANGUAGE plpgsql;`;
  }
  readonly capabilities: DatabaseCapabilities = {
    multiDatabaseExplorer: false,
    databases: true,
    views: true,
    routines: true,
    events: false,
    users: true,
    operations: [
      'createDatabase', 'dropDatabase', 'renameTable', 'renameView', 'truncateTable',
      // 复制表用 `CREATE TABLE ... (LIKE ... INCLUDING ALL)`；此前未声明该能力，
      // 于是「复制表」在 PG 上被一路拒到底
      'duplicateTable',
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

  /** pg_get_viewdef 返回纯 SELECT，包上 CREATE OR REPLACE VIEW 外壳。 */
  normalizeViewAlterSql(raw: string, name: string, database?: string): string {
    const select = (raw || '').replace(/;?\s*$/, '').trim();
    const q = database ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(name))}` : this.wrap(validateIdent(name));
    return `CREATE OR REPLACE VIEW ${q} AS\n${select};`;
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

  /** pg_user 公开但保险起见提供降级（current_user 恒可用，无 host）。 */
  getCurrentUserSql(): string {
    return `SELECT current_user AS ident`;
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

  /**
   * 解析索引列表。列名从 `pg_get_indexdef` 的定义串中提取——PG 的
   * `pg_indexes` 不直接给列清单，此前返回空数组导致索引编辑弹窗勾选项全空。
   */
  parseIndexList(rows: any[]): IndexMeta[] {
    return rows.map((row) => ({
      name: row.name,
      columns: parseIndexDefColumns(row.definition),
      isUnique: toBool(row.is_unique) || /\bCREATE\s+UNIQUE\s+INDEX\b/i.test(String(row.definition ?? '')),
      isPrimary: toBool(row.is_primary),
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
      const values = columns.map((c) => this.escapeValue(row[c])).join(', ');
      out += `INSERT INTO ${qualified} (${colList}) VALUES (${values});\n`;
    }
    return out;
  }

  /** PostgreSQL 标准字符串：仅单引号翻倍，不转义反斜杠。 */
  escapeValue(value: any): string {
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

/**
 * 从 `CREATE [UNIQUE] INDEX name ON tbl USING btree (a, b DESC, lower(c))`
 * 中提取列名列表。
 *
 * 只取最外层括号内以逗号分隔的项，去掉排序/NULLS/操作符类修饰与引号；
 * 表达式索引（如 `lower(c)`）原样保留，便于 UI 展示。
 */
function parseIndexDefColumns(definition: unknown): string[] {
  const def = String(definition ?? '');
  const start = def.indexOf('(');
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = start; i < def.length; i++) {
    if (def[i] === '(') depth++;
    else if (def[i] === ')') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return [];

  const parts: string[] = [];
  let buf = '';
  let nested = 0;
  for (const ch of def.slice(start + 1, end)) {
    if (ch === '(') nested++;
    else if (ch === ')') nested--;
    if (ch === ',' && nested === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);

  return parts
    .map((part) => part
      .trim()
      .replace(/\s+(ASC|DESC)\b/i, '')
      .replace(/\s+NULLS\s+(FIRST|LAST)\b/i, '')
      .replace(/\s+COLLATE\s+\S+/i, '')
      .replace(/\s+\S*_ops\b/i, '')
      .trim()
      .replace(/^"(.*)"$/, '$1'))
    .filter((part) => part.length > 0);
}
