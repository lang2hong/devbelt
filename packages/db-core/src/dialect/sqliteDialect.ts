import { DatabaseType } from '../types/connection.js';
import { validateIdent } from '../utils/validate.js';
import { toBool } from '../utils/coerce.js';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta, ForeignKeyMeta, TriggerMeta } from '../types/meta.js';
import type { SqlDialect } from './sqlDialect.js';
import type { DatabaseCapabilities } from './capabilities.js';
import { columnTypesFor } from './typeCatalog.js';
import { buildKeysetSql } from './keyset.js';

/**
 * SQLite 方言实现。
 */
export class SqliteDialect implements SqlDialect {
  readonly dbType = DatabaseType.SQLITE;
  readonly columnTypes = columnTypesFor(DatabaseType.SQLITE);

  createTableTemplate(table: string): string {
    return `CREATE TABLE IF NOT EXISTS ${table} (\n  "id" INTEGER PRIMARY KEY AUTOINCREMENT,\n  "name" TEXT\n);`;
  }

  addColumnTemplate(table: string): string {
    return `ALTER TABLE ${table} ADD COLUMN "new_column" INTEGER;`;
  }

  /** SQLite 不支持改列型（需 DROP 后重建表），只能改列名。 */
  modifyColumnTemplate(table: string, column: string, _definition: string): string {
    return `-- SQLite does not support altering a column type.\nALTER TABLE ${table} RENAME COLUMN ${this.wrap(column)} TO ${this.wrap(column)};`;
  }

  /**
   * SQLite 无存储过程；返回空串表示不支持，调用方据此不提供入口。
   * 保留参数以对齐接口签名（调用方按统一形态传名字）。
   */
  createRoutineTemplate(_name: string): string {
    return '';
  }
  readonly capabilities: DatabaseCapabilities = {
    multiDatabaseExplorer: false,
    databases: false,
    views: true,
    routines: false,
    events: false,
    users: false,
    // duplicateTable 走 `CREATE TABLE AS SELECT`：能复制结构与数据，
    // 但不保留主键/索引/约束，调用方需向用户说明
    operations: ['renameTable', 'duplicateTable', 'getTableDefinition', 'alterTable', 'manageIndexes', 'dumpTable', 'schemaSync'],
  };

  /**
   * 包裹标识符。内部双引号必须翻倍（SQL 标准的标识符转义规则）。
   * SQLite 驱动经 CLI stdin 执行、支持多语句，逃出标识符上下文的代价比另两家更高。
   */
  wrap(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  getPagedSql(sql: string, offset: number, limit: number): string {
    return `${sql} LIMIT ${limit} OFFSET ${offset}`;
  }

  getKeysetSql(sql: string, orderColumns: string[], afterValues: unknown[] | undefined, limit: number): string {
    return buildKeysetSql(sql, orderColumns, afterValues, limit, (c) => this.wrap(c), (v) => this.escapeValue(v));
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

  /**
   * SQLite 不支持 `CREATE OR REPLACE VIEW`，用 `DROP VIEW IF EXISTS` + `CREATE VIEW`。
   * 改完执行时先删再建，等价于「替换」。
   */
  normalizeViewAlterSql(raw: string, name: string): string {
    const head = raw.match(/^CREATE\s+VIEW\s+\S+\s+AS\s+/i);
    const select = (head ? raw.slice(head[0].length) : raw).replace(/;?\s*$/, '').trim();
    const q = this.wrap(validateIdent(name));
    return `DROP VIEW IF EXISTS ${q};\nCREATE VIEW ${q} AS\n${select};`;
  }

  getIndexListSql(table: string): string {
    validateIdent(table);
    // 用 pragma_index_list/信息表拿真实元数据：过去列恒空、is_unique 恒 0，且把所有
    // `sqlite_autoindex%` 当成主键——唯一约束自动索引被误标为主键。这里按 origin
    // 判定主键（origin='pk'），unique 取真实值，列经 pragma_index_info 展开。
    return `SELECT il.name AS name, il."unique" AS is_unique, (il.origin = 'pk') AS is_primary,
      ii.name AS col
      FROM pragma_index_list(${this.wrap(table)}) il
      JOIN pragma_index_info(il.name) ii
      ORDER BY il.name, ii.seqno`;
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

  getTriggerListSql(table: string): string {
    validateIdent(table);
    return `SELECT name AS name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = '${table}' ORDER BY name`;
  }

  getTriggerDefinitionSql(name: string): string {
    validateIdent(name);
    return `SELECT sql AS definition FROM sqlite_master WHERE type = 'trigger' AND name = '${name}'`;
  }

  createIndexSql(name: string, table: string, columns: string[], unique: boolean): string {
    const cols = columns.map((c) => this.wrap(validateIdent(c))).join(', ');
    return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${this.wrap(validateIdent(name))} ON ${this.wrap(validateIdent(table))} (${cols})`;
  }

  dropIndexSql(name: string, _table?: string, _database?: string): string {
    return `DROP INDEX IF EXISTS ${this.wrap(validateIdent(name))}`;
  }

  dropTriggerSql(name: string, _table?: string, _database?: string): string {
    return `DROP TRIGGER IF EXISTS ${this.wrap(validateIdent(name))}`;
  }

  createForeignKeySql(): string {
    return '';
  }

  dropForeignKeySql(): string {
    return '';
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

  /**
   * 解析索引列表；标志位过 toBool，避免字符串 `"0"` 被判为真。
   * SQL 每列一行，按索引名归并并保序收集列。
   */
  parseIndexList(rows: any[]): IndexMeta[] {
    const map = new Map<string, IndexMeta>();
    for (const row of rows) {
      const name = String(row.name);
      let entry = map.get(name);
      if (!entry) {
        entry = { name, columns: [], isUnique: toBool(row.is_unique), isPrimary: toBool(row.is_primary) };
        map.set(name, entry);
      }
      if (row.col != null) entry.columns.push(String(row.col));
    }
    return Array.from(map.values());
  }

  parseTriggerList(rows: any[]): TriggerMeta[] {
    return rows.map((row) => ({ name: row.name }));
  }

  parseUserList(): UserMeta[] {
    return [];
  }

  parseForeignKeys(rows: any[]): ForeignKeyMeta[] {
    return rows.map((row) => ({
      tableName: row.tableName,
      columnName: row.columnName,
      refTable: row.refTable,
      refColumn: row.refColumn,
      constraintName: row.constraintName,
    }));
  }

  buildInsertSql(rows: Record<string, any>[], columns: string[], table: string, _database?: string): string {
    // SQLite 单文件数据库，database 限定无意义，始终只限定表名。
    const validTable = validateIdent(table);
    const qualified = this.wrap(validTable);
    const colList = columns.map((c) => this.wrap(validateIdent(c))).join(', ');
    let out = '';
    for (const row of rows) {
      const values = columns.map((c) => this.escapeValue(row[c])).join(', ');
      out += `INSERT INTO ${qualified} (${colList}) VALUES (${values});\n`;
    }
    return out;
  }

  /** SQLite 标准字符串：仅单引号翻倍。 */
  escapeValue(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`;
    if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
    if (typeof value === 'object') {
      const json = JSON.stringify(value).replace(/'/g, "''");
      return `'${json}'`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }
}
