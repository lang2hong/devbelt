import { DatabaseType } from '../types/connection';
import { validateIdent } from '../utils/validate';
import { toBool } from '../utils/coerce';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta, ForeignKeyMeta, TriggerMeta } from '../types/meta';
import type { SqlDialect } from './sqlDialect';
import type { DatabaseCapabilities } from './capabilities';
import { columnTypesFor } from './typeCatalog';

/**
 * MySQL 方言实现。
 */
export class MysqlDialect implements SqlDialect {
  readonly dbType = DatabaseType.MYSQL;
  readonly columnTypes = columnTypesFor(DatabaseType.MYSQL);

  createTableTemplate(table: string): string {
    return `CREATE TABLE IF NOT EXISTS ${table} (\n  \`id\` INT AUTO_INCREMENT PRIMARY KEY,\n  \`name\` VARCHAR(255)\n);`;
  }

  /** MySQL 需要 DELIMITER 切换语句结束符，否则例程体内的 `;` 会被提前截断。 */
  createRoutineTemplate(name: string): string {
    return `DELIMITER $$\nCREATE PROCEDURE ${name}()\nBEGIN\n  -- routine body\nEND$$\nDELIMITER ;`;
  }
  readonly capabilities: DatabaseCapabilities = {
    multiDatabaseExplorer: true,
    databases: true,
    views: true,
    routines: true,
    events: true,
    users: true,
    operations: [
      'createDatabase', 'dropDatabase', 'renameTable', 'renameView', 'duplicateTable',
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

  /**
   * 表列表。必须 SELECT `TABLE_COMMENT`：`parseTableList` 读 `row.comment`，
   * 缺这一列时表注释恒为空（树节点 description 与 tooltip 都拿不到注释）。
   */
  getTableListSql(database?: string): string {
    const cols = 'TABLE_NAME AS name, TABLE_ROWS AS table_rows, TABLE_COMMENT AS comment';
    if (database) {
      validateIdent(database);
      return `SELECT ${cols} FROM information_schema.tables WHERE table_schema = '${database}' AND table_type = 'BASE TABLE'`;
    }
    return `SELECT ${cols} FROM information_schema.tables WHERE table_type = 'BASE TABLE'`;
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

  /**
   * 剥掉 SHOW CREATE VIEW 的 ALGORITHM/DEFINER/SQL SECURITY 头，
   * 取 AS 后的 SELECT，重组为 `CREATE OR REPLACE VIEW <name> AS <select>`。
   * DEFINER 子句带连接特定账号，原样重跑会因权限报错；去掉它并改成 OR REPLACE
   * 后，用户改完 SELECT 即可重建视图。
   */
  normalizeViewAlterSql(raw: string, name: string, database?: string): string {
    const head = raw.match(/^CREATE\s+(?:ALGORITHM=\S+\s+)?(?:DEFINER=\S+\s+)?(?:SQL\s+SECURITY\s+\S+\s+)?VIEW\s+\S+\s+AS\s+/i);
    const select = head ? raw.slice(head[0].length) : raw.replace(/^.*?\bAS\b\s+/is, '');
    const q = database ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(name))}` : this.wrap(validateIdent(name));
    return `CREATE OR REPLACE VIEW ${q} AS\n${select.replace(/;?\s*$/, '')};`;
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

  /** 受限账号无权 SELECT mysql.user 时降级（CURRENT_USER() 恒可用）。 */
  getCurrentUserSql(): string {
    return `SELECT CURRENT_USER() AS ident`;
  }

  /** `SHOW GRANTS FOR` 返回该用户全部 GRANT 语句；解析时按库过滤。 */
  getUserGrantsSql(name: string, host?: string): string {
    return `SHOW GRANTS FOR ${this.escapeValue(name)}@${this.escapeValue(host || '%')}`;
  }

  /**
   * 解析 SHOW GRANTS 结果为白名单权限列表。
   *
   * 每行形如 `GRANT SELECT, INSERT ON db.* TO 'u'@'h'` 或 `GRANT ALL PRIVILEGES ON *.* TO ...`。
   * 列名不稳定（`Grants for 'u'@'h'`），故取行第一个值。
   * database 指定时只取目标库上的权限；`*.*`（全局）与指定库的 `db.*`/`db.table` 都算。
   * USAGE 表示「无权限占位」，跳过。
   */
  parseGrants(rows: any[], database?: string): string[] {
    const out = new Set<string>();
    for (const row of rows) {
      const stmt = String(Object.values(row)[0] ?? '');
      const m = stmt.match(/^GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\s+/i);
      if (!m) continue;
      const privs = m[1];
      const target = m[2];
      if (/^USAGE$/i.test(privs.trim())) continue;
      if (database) {
        // db.* / db.table / *.*
        const dbPart = target.split('.')[0];
        if (dbPart !== '*' && dbPart.replace(/[`]/g, '') !== database) continue;
      }
      for (const p of privs.split(',')) {
        const t = p.trim();
        if (t && !/^USAGE$/i.test(t)) out.add(t);
      }
    }
    return [...out];
  }

  getTriggerListSql(table: string, database?: string): string {
    validateIdent(table);
    const where = database
      ? `TRIGGER_SCHEMA = '${validateIdent(database)}' AND EVENT_OBJECT_TABLE = '${table}'`
      : `TRIGGER_SCHEMA = database() AND EVENT_OBJECT_TABLE = '${table}'`;
    return `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, EVENT_OBJECT_TABLE AS \`table\` FROM information_schema.TRIGGERS WHERE ${where} ORDER BY TRIGGER_NAME`;
  }

  getTriggerDefinitionSql(name: string, database?: string): string {
    const qualified = database
      ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(name))}`
      : this.wrap(validateIdent(name));
    return `SHOW CREATE TRIGGER ${qualified}`;
  }

  createIndexSql(name: string, table: string, columns: string[], unique: boolean, database?: string): string {
    const qualified = database
      ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(table))}`
      : this.wrap(validateIdent(table));
    const cols = columns.map((c) => this.wrap(validateIdent(c))).join(', ');
    return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${this.wrap(validateIdent(name))} ON ${qualified} (${cols})`;
  }

  dropIndexSql(name: string, table: string, database?: string): string {
    const qualified = database
      ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(table))}`
      : this.wrap(validateIdent(table));
    return `DROP INDEX ${this.wrap(validateIdent(name))} ON ${qualified}`;
  }

  dropTriggerSql(name: string, _table: string, database?: string): string {
    const qualified = database
      ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(name))}`
      : this.wrap(validateIdent(name));
    return `DROP TRIGGER IF EXISTS ${qualified}`;
  }

  createForeignKeySql(name: string, table: string, columns: string[], refTable: string, refColumns: string[], database?: string): string {
    const qualified = database
      ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(table))}`
      : this.wrap(validateIdent(table));
    const refQualified = database
      ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(refTable))}`
      : this.wrap(validateIdent(refTable));
    const cols = columns.map((c) => this.wrap(validateIdent(c))).join(', ');
    const refCols = refColumns.map((c) => this.wrap(validateIdent(c))).join(', ');
    return `ALTER TABLE ${qualified} ADD CONSTRAINT ${this.wrap(validateIdent(name))} FOREIGN KEY (${cols}) REFERENCES ${refQualified} (${refCols})`;
  }

  dropForeignKeySql(name: string, table: string, database?: string): string {
    const qualified = database
      ? `${this.wrap(validateIdent(database))}.${this.wrap(validateIdent(table))}`
      : this.wrap(validateIdent(table));
    return `ALTER TABLE ${qualified} DROP FOREIGN KEY ${this.wrap(validateIdent(name))}`;
  }

  getForeignKeysSql(database?: string): string {
    const where = database ? `table_schema = '${validateIdent(database)}'` : `table_schema = database()`;
    return `SELECT table_name AS tableName, column_name AS columnName, referenced_table_name AS refTable, referenced_column_name AS refColumn, constraint_name AS constraintName FROM information_schema.key_column_usage WHERE referenced_table_name IS NOT NULL AND ${where}`;
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

  /**
   * 解析索引列表。
   *
   * `is_unique`/`is_primary` 来自 SQL 布尔表达式，经 MySQL typeCast 后是字符串
   * `"0"`/`"1"`，必须过 toBool——直接使用会让 `!!"0"` 判为真。
   */
  parseIndexList(rows: any[]): IndexMeta[] {
    const map = new Map<string, { columns: string[]; isUnique: boolean; isPrimary: boolean }>();
    for (const row of rows) {
      const name = row.name;
      if (!map.has(name)) {
        map.set(name, { columns: [], isUnique: toBool(row.is_unique), isPrimary: toBool(row.is_primary) });
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

  parseTriggerList(rows: any[]): TriggerMeta[] {
    return rows.map((row) => ({
      name: row.name,
      timing: row.timing,
      event: row.event,
      table: row.table,
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

  /** MySQL 字符串字面量：反斜杠与单引号都需转义。 */
  escapeValue(value: any): string {
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
