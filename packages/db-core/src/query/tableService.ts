import { validateIdent, validateSchemaIdent } from '../utils/validate.js';
import { qualifyTable } from '../utils/qualify.js';
import { QueryService } from './queryService.js';
import type { QueryOptions } from './queryService.js';
import { supportsOperation, unsupportedOperationMessage } from '../dialect/capabilities.js';
import type { DatabaseOperation } from '../dialect/capabilities.js';
import { normalizeColumnMeta } from './normalize.js';
import type { QueryResult } from '../types/query.js';
import type { ColumnMeta } from '../types/meta.js';
import { validateColumnType, renderColumnAttributes, renderDefaultLiteral } from './columnSpec.js';
import type { ColumnSpec, NewColumnSpec } from './columnSpec.js';
import { mockValue } from './mockData.js';
import { DatabaseType } from '../types/connection.js';

// 列定义与类型校验已下沉 columnSpec.ts；此处 re-export 保持既有 import 站点不变。
export { validateColumnType } from './columnSpec.js';
export type { ColumnSpec, NewColumnSpec } from './columnSpec.js';

/**
 * 表结构操作服务：创建/删除/重命名/清空/复制/查看建表语句。
 * 复用查询服务执行，标识符经方言转义，防止注入。
 *
 * 危险操作（删除/清空）需由上层 UI 二次确认后调用。
 */
export class TableService {
  constructor(private readonly queryService: QueryService) {}

  /**
   * 建表。
   *
   * 自增列的写法三家完全不同，必须在这里分流，否则设计器只能产出 MySQL 语法：
   *  - MySQL：`INT NOT NULL AUTO_INCREMENT` + 独立 `PRIMARY KEY`
   *  - PG：类型换成 `SERIAL` / `BIGSERIAL`
   *  - SQLite：只能写成 `INTEGER PRIMARY KEY AUTOINCREMENT`（内联，且必须是唯一主键）
   */
  async createTable(table: string, columns: NewColumnSpec[], database?: string, schema?: string): Promise<QueryResult> {
    validateIdent(table);
    if (!columns.length) throw new Error('At least one column is required to create a table.');
    const dbType = this.queryService.dialect.dbType;
    const primary = columns.filter((c) => c.isPrimary).map((c) => c.name);
    const autoIncrement = columns.filter((c) => c.autoIncrement);
    if (autoIncrement.length > 1) throw new Error('Only one auto-increment column is supported.');

    // SQLite 的 AUTOINCREMENT 只能内联在唯一主键列上，写成独立 PRIMARY KEY 会报错
    const sqliteInlinePk = dbType === 'SQLITE' && autoIncrement.length === 1;
    if (sqliteInlinePk && (primary.length !== 1 || primary[0] !== autoIncrement[0].name)) {
      throw new Error('SQLite requires the auto-increment column to be the only primary key column.');
    }

    const defs = columns.map((c) => this.columnDefinition(c, dbType, sqliteInlinePk));
    if (primary.length && !sqliteInlinePk) {
      defs.push(`PRIMARY KEY (${primary.map((c) => this.wrap(validateIdent(c))).join(', ')})`);
    }
    return this.ddl(`CREATE TABLE ${this.wrapQualified(table, database, schema)} (\n  ${defs.join(',\n  ')}\n)`);
  }

  private columnDefinition(col: NewColumnSpec, dbType: string, sqliteInlinePk: boolean): string {
    validateIdent(col.name);
    return `${this.wrap(col.name)} ${this.columnAttributes(col, dbType, sqliteInlinePk)}`;
  }

  /** 列属性（类型 + 约束 + 默认值 + 注释），不含列名。与结构同步共用同一渲染器。 */
  private columnAttributes(col: ColumnSpec, dbType: string, sqliteInlinePk: boolean): string {
    return renderColumnAttributes(col, dbType, (v) => this.esc(v), sqliteInlinePk);
  }

  /** 默认值字面量：数字与时间关键字原样写入，其余按方言规则转义为字符串。 */
  private defaultLiteral(value: string): string {
    return renderDefaultLiteral(value, (v) => this.esc(v));
  }

  /** 删除表（危险操作） */
  async dropTable(table: string, database?: string, schema?: string): Promise<QueryResult> {
    return this.ddl(`DROP TABLE ${this.wrapQualified(table, database, schema)}`);
  }

  /** 重命名表 */
  async renameTable(table: string, newName: string, database?: string, schema?: string): Promise<QueryResult> {
    this.require('renameTable');
    if (this.queryService.dialect.dbType === 'MYSQL') {
      return this.ddl(
        `RENAME TABLE ${this.wrapQualified(table, database, schema)} TO ${this.wrapQualified(newName, database, schema)}`,
      );
    }
    // PG/SQLite：目标名与源同 schema（PG 的 RENAME TO 只接受新名，schema 由源表限定）。
    return this.ddl(`ALTER TABLE ${this.wrapQualified(table, database, schema)} RENAME TO ${this.wrap(newName)}`);
  }

  /** 重命名视图 */
  async renameView(view: string, newName: string, database?: string, schema?: string): Promise<QueryResult> {
    this.require('renameView');
    if (this.queryService.dialect.dbType === 'MYSQL') {
      return this.ddl(`RENAME TABLE ${this.wrapQualified(view, database, schema)} TO ${this.wrapQualified(newName, database, schema)}`);
    }
    return this.ddl(`ALTER VIEW ${this.wrapQualified(view, database, schema)} RENAME TO ${this.wrap(newName)}`);
  }

  /** 清空表（危险操作） */
  async truncateTable(table: string, database?: string, schema?: string): Promise<QueryResult> {
    this.require('truncateTable');
    return this.ddl(`TRUNCATE TABLE ${this.wrapQualified(table, database, schema)}`);
  }

  /**
   * 复制表。
   *
   * `includeData` 为 false 时只复制结构。方言差异：
   *  - MySQL：`CREATE TABLE ... LIKE`（保留索引/默认值/自增），再 `INSERT SELECT` 灌数据
   *  - PG：`CREATE TABLE ... (LIKE ... INCLUDING ALL)`，同样再灌数据
   *  - SQLite：只有 `CREATE TABLE AS SELECT`，**不保留主键/索引/约束**
   *
   * 注意：此前该方法注释写「含数据」，实际只发了 `LIKE`，一行数据都不会复制。
   */
  async dupTable(table: string, newName: string, database?: string, includeData = false, schema?: string): Promise<QueryResult> {
    this.require('duplicateTable');
    validateIdent(table);
    validateIdent(newName);
    const source = this.wrapQualified(table, database, schema);
    const target = this.wrapQualified(newName, database, schema);
    const dbType = this.queryService.dialect.dbType;

    if (dbType === 'SQLITE') {
      // SQLite 无 LIKE 语法；WHERE 0 用于「只要结构」
      return this.ddl(`CREATE TABLE ${target} AS SELECT * FROM ${source}${includeData ? '' : ' WHERE 0'}`);
    }

    const structure = dbType === 'PG'
      ? `CREATE TABLE ${target} (LIKE ${source} INCLUDING ALL)`
      : `CREATE TABLE ${target} LIKE ${source}`;
    const created = await this.ddl(structure);
    if (!includeData) return created;
    return this.ddl(`INSERT INTO ${target} SELECT * FROM ${source}`);
  }

  /** 查询建表语句（各方言实现不同，返回首行首列）。`targetSchema` 仅 PG：DDL 表头写到目标 schema（列仍读自 `schema`）。 */
  async getCreateSql(table: string, database?: string, schema?: string, targetSchema?: string): Promise<string> {
    this.require('getTableDefinition');
    const sql = this.getCreateSqlForDialect(table, database, schema, targetSchema);
    const result = await this.queryService.query(sql);
    const row = result.rows[0] as Record<string, any> | undefined;
    if (!row) return '';
    // MySQL SHOW CREATE TABLE 返回 { Table: ..., 'Create Table': ... }，取 DDL 列
    const createCol = Object.keys(row).find((k) => k.toLowerCase().includes('create'));
    if (createCol) return row[createCol];
    // SQLite/PG 返回单列 sql，取首值
    const values = Object.values(row);
    return values[values.length - 1] as string;
  }

  /** 删除视图 */
  async dropView(view: string, database?: string, schema?: string): Promise<QueryResult> {
    return this.ddl(`DROP VIEW ${this.wrapQualified(view, database, schema)}`);
  }

  /** 删除函数/存储过程。PG 需带参数签名，否则重载函数无法删除。 */
  async dropRoutine(name: string, routineType: string, database?: string, schema?: string, identityArgs?: string): Promise<QueryResult> {
    this.require('manageRoutines');
    // routineType 直接内插进 SQL：白名单，且只允许 FUNCTION / PROCEDURE。
    const rt = String(routineType || '').toUpperCase();
    if (rt !== 'FUNCTION' && rt !== 'PROCEDURE') {
      throw new Error(`Invalid routine type: "${routineType}"`);
    }
    const qualified = this.wrapQualified(name, database, schema);
    if (this.queryService.dialect.dbType === 'PG') {
      // 有签名才加括号（重载可删）；没有签名就不加（不能凭空 `()`，否则删不到无参签名也可能误删）。
      const suffix = identityArgs !== undefined ? `(${this.safeRoutineArgs(identityArgs)})` : '';
      return this.ddl(`DROP ${rt} IF EXISTS ${qualified}${suffix}`);
    }
    return this.ddl(`DROP ${rt} IF EXISTS ${qualified}`);
  }

  /** 校验 PG 参数签名（来自 pg_get_function_identity_arguments）：拒绝注入形状。 */
  private safeRoutineArgs(raw: string): string {
    if (/[;'()]|--|\/\*/.test(raw)) {
      throw new Error(`Invalid routine signature: "${raw}"`);
    }
    return raw;
  }

  /** 删除事件 */
  async dropEvent(name: string, database?: string, schema?: string): Promise<QueryResult> {
    this.require('manageEvents');
    const qualified = this.wrapQualified(name, database, schema);
    return this.ddl(`DROP EVENT IF EXISTS ${qualified}`);
  }

  /** 删除索引（主键索引走 ALTER TABLE DROP PRIMARY KEY） */
  async dropIndex(indexName: string, table: string, database?: string, schema?: string): Promise<QueryResult> {
    this.require('manageIndexes');
    const qualifiedTable = this.wrapQualified(table, database, schema);
    if (indexName.toUpperCase() === 'PRIMARY') {
      return this.ddl(`ALTER TABLE ${qualifiedTable} DROP PRIMARY KEY`);
    }
    return this.ddl(this.queryService.dialect.dropIndexSql(indexName, table, database, schema));
  }

  /** 创建索引（主键走 ALTER TABLE ADD PRIMARY KEY） */
  async createIndex(indexName: string, table: string, columns: string[], database?: string, isUnique = false, schema?: string): Promise<QueryResult> {
    this.require('manageIndexes');
    const qualifiedTable = this.wrapQualified(table, database, schema);
    const colList = columns.map((c) => this.wrap(c)).join(', ');
    if (indexName.toUpperCase() === 'PRIMARY') {
      return this.ddl(`ALTER TABLE ${qualifiedTable} ADD PRIMARY KEY (${colList})`);
    }
    return this.ddl(`CREATE ${isUnique ? 'UNIQUE ' : ''}INDEX ${this.wrap(indexName)} ON ${qualifiedTable} (${colList})`);
  }

  /** 重建主键（编辑主键索引时：DROP + ADD 单语句） */
  async recreatePrimaryKey(table: string, columns: string[], database?: string, schema?: string): Promise<QueryResult> {
    this.require('manageIndexes');
    // PG 需先按名 DROP 现有 PK 约束（名字可能自定义），SQLite 需整表重建；
    // 两者都无法用一条通用语句完成。过去无条件发 MySQL 语法 → PG/SQLite 上是非法 SQL。
    if (this.queryService.dialect.dbType !== DatabaseType.MYSQL) {
      throw new Error(
        `Recreating a primary key is not supported for ${this.queryService.dialect.dbType}; drop and re-add it with explicit SQL.`,
      );
    }
    const qualifiedTable = this.wrapQualified(table, database, schema);
    const colList = columns.map((c) => this.wrap(c)).join(', ');
    return this.ddl(`ALTER TABLE ${qualifiedTable} DROP PRIMARY KEY, ADD PRIMARY KEY (${colList})`);
  }

  /** 新增外键 */
  async addForeignKey(table: string, name: string, columns: string[], refTable: string, refColumns: string[], database?: string, schema?: string, refSchema?: string): Promise<QueryResult> {
    this.require('alterTable');
    const sql = this.queryService.dialect.createForeignKeySql(name, table, columns, refTable, refColumns, database, schema, refSchema);
    if (!sql) throw new Error(`${this.queryService.dialect.dbType} does not support adding foreign keys.`);
    return this.ddl(sql);
  }

  /** 删除外键 */
  async dropForeignKey(name: string, table: string, database?: string, schema?: string): Promise<QueryResult> {
    this.require('alterTable');
    const sql = this.queryService.dialect.dropForeignKeySql(name, table, database, schema);
    if (!sql) throw new Error(`${this.queryService.dialect.dbType} does not support dropping foreign keys.`);
    return this.ddl(sql);
  }

  /** 新增列。定义由结构化 spec 合成，类型经白名单校验、值与标识符经方言转义。 */
  async addColumn(table: string, column: string, spec: ColumnSpec, database?: string, schema?: string): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    const def = this.columnAttributes(spec, this.queryService.dialect.dbType, false);
    return this.ddl(`ALTER TABLE ${this.wrapQualified(table, database, schema)} ADD COLUMN ${this.wrap(column)} ${def}`);
  }

  /** 删除列（危险操作，需二次确认） */
  async dropColumn(table: string, column: string, database?: string, schema?: string): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    return this.ddl(`ALTER TABLE ${this.wrapQualified(table, database, schema)} DROP COLUMN ${this.wrap(column)}`);
  }

  /**
   * 改列（可同时改名）。
   *
   * MySQL 走 `CHANGE COLUMN old new def` —— `MODIFY COLUMN` 改不了列名，
   * 而树上的「Modify」需要覆盖改名这个最常见的诉求。
   * PG 没有一条语句能同时改名与改类型，因此拆成 RENAME + ALTER TYPE 两步；
   * SQLite 只能改名。
   */
  async changeColumn(
    table: string,
    column: string,
    newName: string,
    spec: ColumnSpec,
    database?: string,
    schema?: string,
  ): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    validateIdent(newName);
    const qualified = this.wrapQualified(table, database, schema);
    const dbType = this.queryService.dialect.dbType;

    if (dbType === 'MYSQL') {
      const def = this.columnAttributes(spec, 'MYSQL', false);
      return this.ddl(
        `ALTER TABLE ${qualified} CHANGE COLUMN ${this.wrap(column)} ${this.wrap(newName)} ${def}`,
      );
    }
    if (dbType === 'PG') {
      const type = validateColumnType(spec.type);
      if (newName !== column) {
        await this.ddl(`ALTER TABLE ${qualified} RENAME COLUMN ${this.wrap(column)} TO ${this.wrap(newName)}`);
      }
      return this.ddl(`ALTER TABLE ${qualified} ALTER COLUMN ${this.wrap(newName)} TYPE ${type}`);
    }
    if (newName === column) {
      throw new Error(`${dbType} does not support altering a column type.`);
    }
    return this.renameColumn(table, column, newName, database, schema);
  }

  /** 仅改列名（三家方言都支持 `RENAME COLUMN`，MySQL 8.0+ 亦可）。 */
  async renameColumn(table: string, column: string, newName: string, database?: string, schema?: string): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    validateIdent(newName);
    return this.ddl(
      `ALTER TABLE ${this.wrapQualified(table, database, schema)} RENAME COLUMN ${this.wrap(column)} TO ${this.wrap(newName)}`,
    );
  }

  /** 修改列定义。MySQL 用 MODIFY COLUMN；PG 用 ALTER COLUMN TYPE；SQLite 不支持改类型 */
  async modifyColumn(table: string, column: string, spec: ColumnSpec, database?: string, schema?: string): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    const dbType = this.queryService.dialect.dbType;
    if (dbType === 'MYSQL') {
      const def = this.columnAttributes(spec, 'MYSQL', false);
      return this.ddl(`ALTER TABLE ${this.wrapQualified(table, database, schema)} MODIFY COLUMN ${this.wrap(column)} ${def}`);
    }
    if (dbType === 'PG') {
      const type = validateColumnType(spec.type);
      const q = this.wrapQualified(table, database, schema);
      const c = this.wrap(column);
      // 旧实现只改 TYPE，表单里的 NOT NULL / DEFAULT 被静默丢弃（用户以为已生效）。
      let result = await this.ddl(`ALTER TABLE ${q} ALTER COLUMN ${c} TYPE ${type}`);
      result = await this.ddl(`ALTER TABLE ${q} ALTER COLUMN ${c} ${spec.notNull ? 'SET' : 'DROP'} NOT NULL`);
      if (spec.defaultValue !== undefined && spec.defaultValue !== '') {
        result = await this.ddl(`ALTER TABLE ${q} ALTER COLUMN ${c} SET DEFAULT ${this.defaultLiteral(spec.defaultValue)}`);
      } else if (spec.defaultValue === '') {
        result = await this.ddl(`ALTER TABLE ${q} ALTER COLUMN ${c} DROP DEFAULT`);
      }
      return result;
    }
    throw new Error(`${dbType} does not support altering a column type.`);
  }

  /** 调整列位置（仅 MySQL：CHANGE COLUMN ... AFTER/FIRST）。afterColumn 为 null 表示移到最前(FIRST)。 */
  async reorderColumn(table: string, column: string, afterColumn: string | null, database?: string, schema?: string): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    const dbType = this.queryService.dialect.dbType;
    if (dbType !== 'MYSQL') {
      throw new Error(`${dbType} does not support reordering columns.`);
    }
    const def = await this.getFullColumnDef(table, column, database, schema);
    // def 来自**同库** SHOW CREATE TABLE 解析（相对可信，与跨库 information_schema 不同）；
    // 若将来允许自定义/跨库定义，须同 schemaDiffService 一样过 validateColumnType。
    const position = afterColumn ? ` AFTER ${this.wrap(afterColumn)}` : ' FIRST';
    return this.ddl(`ALTER TABLE ${this.wrapQualified(table, database, schema)} CHANGE COLUMN ${this.wrap(column)} ${this.wrap(column)} ${def}${position}`);
  }

  /**
   * 读取列的完整定义（MySQL）。
   *
   * 供「改列」预填当前定义用：只给类型会把 NOT NULL / DEFAULT / 注释 / 自增
   * 全部抹掉，这在 `CHANGE COLUMN` 里是静默的数据/约束丢失。
   */
  async getColumnDefinition(table: string, column: string, database?: string, schema?: string): Promise<string> {
    validateIdent(table);
    validateIdent(column);
    if (this.queryService.dialect.dbType !== 'MYSQL') {
      throw new Error(`${this.queryService.dialect.dbType} does not expose a full column definition.`);
    }
    return this.getFullColumnDef(table, column, database, schema);
  }

  /** 从 SHOW CREATE TABLE 解析指定列的完整定义（含 NOT NULL/DEFAULT/charset/ON UPDATE 等所有属性）。 */
  private async getFullColumnDef(table: string, column: string, database?: string, schema?: string): Promise<string> {
    const ddl = await this.getCreateSql(table, database, schema);
    for (const raw of ddl.split('\n')) {
      const line = raw.trimEnd();
      const m = line.match(/^\s*`([^`]+)`\s+(.+?)\s*,?\s*$/);
      if (m && m[1] === column && !m[2].startsWith('(')) {
        return m[2].replace(/,\s*$/, '');
      }
    }
    throw new Error(`Column "${column}" not found in table DDL`);
  }

  // ── 用户管理 ──

  /** 方言值转义（含外层引号）；各库字符串规则不同，不可统一用 MySQL 规则。 */
  private esc(value: any): string {
    return this.queryService.dialect.escapeValue(value);
  }

  /**
   * 创建用户。
   * PG 的角色名是标识符（不能用字符串字面量），密码才是字符串字面量；
   * MySQL 的用户名/主机是字符串字面量。
   */
  async createUser(name: string, password: string, host = '%'): Promise<QueryResult> {
    this.require('manageUsers');
    if (this.queryService.dialect.dbType === 'PG') {
      return this.secretDdl(`CREATE ROLE ${this.wrap(validateIdent(name))} WITH LOGIN PASSWORD ${this.esc(password)}`);
    }
    return this.secretDdl(`CREATE USER ${this.esc(name)}@${this.esc(host)} IDENTIFIED BY ${this.esc(password)}`);
  }

  async dropUser(name: string, host = '%'): Promise<QueryResult> {
    this.require('manageUsers');
    if (this.queryService.dialect.dbType === 'PG') {
      return this.ddl(`DROP ROLE IF EXISTS ${this.wrap(validateIdent(name))}`);
    }
    return this.ddl(`DROP USER IF EXISTS ${this.esc(name)}@${this.esc(host)}`);
  }

  async alterUserPassword(name: string, password: string, host = '%'): Promise<QueryResult> {
    this.require('manageUsers');
    if (this.queryService.dialect.dbType === 'PG') {
      return this.secretDdl(`ALTER ROLE ${this.wrap(validateIdent(name))} WITH PASSWORD ${this.esc(password)}`);
    }
    return this.secretDdl(`ALTER USER ${this.esc(name)}@${this.esc(host)} IDENTIFIED BY ${this.esc(password)}`);
  }

  async grantPrivilege(name: string, privilege: string, database?: string, host = '%'): Promise<QueryResult> {
    this.require('manageUsers');
    const PRIV_WHITELIST = /^(ALL(\s+PRIVILEGES)?|SELECT|INSERT|UPDATE|DELETE|CREATE(\s+VIEW)?|DROP|ALTER|INDEX|REFERENCES|TRIGGER|EXECUTE|USAGE|RELOAD|PROCESS|REPLICATION\s+CLIENT|REPLICATION\s+SLAVE|SHOW\s+(VIEW|DATABASES)|SHUTDOWN|SUPER)$/i;
    if (!PRIV_WHITELIST.test(privilege.trim())) {
      throw new Error(`Invalid privilege: "${privilege}"`);
    }
    if (this.queryService.dialect.dbType === 'PG') {
      // PG 里 `database` 是库名，与 schema 是两层（见 qualifyTable）：把库名当 schema
      // 会授权到不存在的 `"库名"` schema。`GRANT ... IN SCHEMA` 只接受标识符，
      // `current_schema()` 在这里是语法错误，故先查出当前 schema 名再内插。
      // 注：这是**用户管理**入口（非从某个 schema 节点发起），作用于 current_schema()，
      // 按连接默认 schema 授权；P7.1 多 schema 下若需逐 schema 授权属独立增强。
      const schema = await this.currentSchema();
      return this.ddl(`GRANT ${privilege} ON ALL TABLES IN SCHEMA ${this.wrap(validateSchemaIdent(schema))} TO ${this.wrap(validateIdent(name))}`);
    }
    const target = database ? `${this.wrap(validateIdent(database))}.*` : '*.*';
    return this.ddl(`GRANT ${privilege} ON ${target} TO ${this.esc(name)}@${this.esc(host)}`);
  }

  async revokePrivilege(name: string, privilege: string, database?: string, host = '%'): Promise<QueryResult> {
    this.require('manageUsers');
    const PRIV_WHITELIST = /^(ALL(\s+PRIVILEGES)?|SELECT|INSERT|UPDATE|DELETE|CREATE(\s+VIEW)?|DROP|ALTER|INDEX|REFERENCES|TRIGGER|EXECUTE|USAGE|RELOAD|PROCESS|REPLICATION\s+CLIENT|REPLICATION\s+SLAVE|SHOW\s+(VIEW|DATABASES)|SHUTDOWN|SUPER)$/i;
    if (!PRIV_WHITELIST.test(privilege.trim())) {
      throw new Error(`Invalid privilege: "${privilege}"`);
    }
    if (this.queryService.dialect.dbType === 'PG') {
      // 同 grantPrivilege：目标是 schema（当前 schema），不是库名。
      const schema = await this.currentSchema();
      return this.ddl(`REVOKE ${privilege} ON ALL TABLES IN SCHEMA ${this.wrap(validateSchemaIdent(schema))} FROM ${this.wrap(validateIdent(name))}`);
    }
    const target = database ? `${this.wrap(validateIdent(database))}.*` : '*.*';
    return this.ddl(`REVOKE ${privilege} ON ${target} FROM ${this.esc(name)}@${this.esc(host)}`);
  }

  /**
   * 导出表结构 + 数据（mysqldump 风格 SQL）。
   * 生成：DROP TABLE IF EXISTS + CREATE TABLE + INSERT 语句。
   */
  async dumpSql(table: string, database?: string, includeData = true, schema?: string): Promise<string> {
    this.require('dumpTable');
    validateIdent(table);
    const parts: string[] = [];
    const ddl = await this.getCreateSql(table, database, schema);
    const scope = schema ?? database;
    parts.push(`-- Table: ${scope ? scope + '.' : ''}${table}`);
    parts.push(`DROP TABLE IF EXISTS ${this.wrapQualified(table, database, schema)};`);
    parts.push(ddl + ';');
    parts.push('');
    if (includeData) {
      const DUMP_BATCH = 1000;
      let offset = 0;
      let totalRows = 0;
      const qualified = this.wrapQualified(table, database, schema);
      // 无 ORDER BY 的 LIMIT/OFFSET 分页顺序不确定：服务端可返回任意顺序，翻页时行会
      // 漂移，导致导出丢行/重复。先探列，再按全部列排序，保证分页稳定。
      const probe = await this.queryService.query(`SELECT * FROM ${qualified} LIMIT 0`);
      const orderColumns = probe.fields.map((f: any) => this.wrap(f.name));
      const orderBy = orderColumns.length ? ` ORDER BY ${orderColumns.join(', ')}` : '';
      for (;;) {
        const page = await this.queryService.query(
          `SELECT * FROM ${qualified}${orderBy} LIMIT ${DUMP_BATCH} OFFSET ${offset}`,
        );
        if (page.rows.length === 0) break;
        if (totalRows === 0) {
          const fields = page.fields.map((f: any) => f.name);
          const colList = fields.map((f: string) => this.wrap(f)).join(', ');
          parts.push(`INSERT INTO ${qualified} (${colList}) VALUES`);
        }
        const fields = page.fields.map((f: any) => f.name);
        for (const row of page.rows) {
          const values = fields.map((f: string) => {
            const v = row[f];
            if (v === null || v === undefined) return 'NULL';
            return this.esc(v);
          }).join(', ');
          parts.push(`(${values}),`);
        }
        totalRows += page.rows.length;
        if (page.rows.length < DUMP_BATCH) break;
        offset += DUMP_BATCH;
      }
      if (totalRows > 0) {
        parts[parts.length - 1] = parts[parts.length - 1].replace(/,$/, ';');
        parts.push(`-- ${totalRows} row(s) dumped`);
      }
    }
    return parts.join('\n');
  }

  /**
   * 生成 Mock 数据并插入表中。
   *
   * 按列名/类型智能生成随机值：email/name/phone/address/date 等语义匹配，
   * INT 自增列跳过，其余按类型生成合理随机值。
   *
   * @param table 表名
   * @param database 数据库名
   * @param count 生成行数
   * @param columns 列元数据（避免重复查询）
   * @returns 实际插入行数
   */
  async generateMockData(
    table: string,
    database: string | undefined,
    count: number,
    columns?: ColumnMeta[],
    schema?: string,
  ): Promise<number> {
    let cols: ColumnMeta[];
    if (columns && columns.length > 0) {
      cols = columns;
    } else {
      const result = await this.queryService.query(
        this.queryService.dialect.getColumnsSql(table, database, schema),
      );
      cols = result.rows.map((r: any) => normalizeColumnMeta(r));
    }

    const insertCols = cols.filter((c) => !c.isAutoIncrement && c.extra !== 'auto_increment');
    const colList = insertCols.map((c) => this.wrap(c.name)).join(', ');

    let inserted = 0;
    const batchSize = Math.min(count, 100);
    for (let batch = 0; batch < Math.ceil(count / batchSize); batch++) {
      const batchCount = Math.min(batchSize, count - batch * batchSize);
      const valuesList: string[] = [];
      for (let i = 0; i < batchCount; i++) {
        const values = insertCols.map((c) => mockValue(c, batch * batchSize + i, (v) => this.esc(v))).join(', ');
        valuesList.push(`(${values})`);
      }
      const sql = `INSERT INTO ${this.wrapQualified(table, database, schema)} (${colList}) VALUES ${valuesList.join(', ')}`;
      // 批量循环不逐条进历史，否则百万行 mock 会把上限 100 条的历史冲干；
      // 命令层会补一条汇总记录。
      await this.queryService.query(sql, undefined, { skipHistory: true });
      inserted += batchCount;
    }
    return inserted;
  }

  private async ddl(sql: string, options?: QueryOptions): Promise<QueryResult> {
    return this.queryService.query(sql, undefined, options);
  }

  /**
   * 解析 PG 当前 schema 名。
   *
   * 授权目标必须是 schema（`GRANT ... IN SCHEMA <name>` 只接受标识符，不能写
   * `current_schema()` 表达式），而连接层提供的 `database` 是库名。其它解析
   * 调用点（建表语句、列解析）统一按 `current_schema()` 语义，这里取同名值。
   */
  private async currentSchema(): Promise<string> {
    const result = await this.queryService.queryAll('SELECT current_schema() AS schema');
    const schema = String(result.rows?.[0]?.schema ?? '');
    if (!schema) throw new Error('Unable to resolve the current PostgreSQL schema.');
    return schema;
  }

  /**
   * 执行含明文密码的语句。
   *
   * 这类 SQL 绝不能进查询历史：历史会持久化到 globalState 并参与云同步，
   * 密码一旦写进去就会离开本机。命令层负责补一条脱敏摘要。
   */
  private async secretDdl(sql: string): Promise<QueryResult> {
    return this.ddl(sql, { skipHistory: true });
  }

  supports(operation: DatabaseOperation): boolean {
    return supportsOperation(this.queryService.dialect.capabilities, operation);
  }

  /** 方言类型（schema 同步按方言生成 DDL 时判断用）。 */
  get dbType() {
    return this.queryService.dialect.dbType;
  }

  /** 方言标识符包裹（校验后）。供 schema 同步生成 DDL 复用。 */
  wrapIdentifier(identifier: string): string {
    return this.wrap(validateIdent(identifier));
  }

  /** 包裹 **schema** 标识符：用放宽后的 `validateSchemaIdent`（允许空格/`.`/`"` 等），引用仍安全。 */
  wrapSchemaIdentifier(identifier: string): string {
    return this.wrap(validateSchemaIdent(identifier));
  }

  private require(operation: DatabaseOperation): void {
    if (!this.supports(operation)) {
      throw new Error(unsupportedOperationMessage(this.queryService.dialect.dbType, operation));
    }
  }

  /** 包裹标识符 */
  private wrap(identifier: string): string {
    return this.queryService.dialect.wrap(identifier);
  }

  /**
   * 包裹限定名：`db`.`table` 或 `"table"`。
   *
   * 这里强制 `validateIdent` 而不是交给调用方：`wrapQualified` 是 DROP / TRUNCATE /
   * RENAME / DUPLICATE / CREATE TABLE 等 DDL 的公共出口，本文件里有 60 多处
   * `validateIdent` 调用点，但恰好这条主干上的几个入口漏了 —— 漏一处就是一条
   * 以调用者权限执行任意 DDL 的路径。
   *
   * PostgreSQL 的限定走 `schema` 形参（`database` 是库名而非 schema，见 qualifyTable）。
   *
   * 威胁模型见 test/dialect/identEscape.test.ts 顶部：表名来自数据库自身的元数据
   * （树节点标签），不是用户输入，所以"用户不会输入引号"这个假设不成立。
   */
  private wrapQualified(name: string, database?: string, schema?: string): string {
    validateIdent(name);
    if (database) validateIdent(database);
    if (schema) validateSchemaIdent(schema);
    if (!database && !schema) return this.wrap(name);
    return qualifyTable(
      this.queryService.dialect.dbType,
      this.wrap(name),
      database ? this.wrap(database) : undefined,
      schema ? this.wrap(schema) : undefined,
    );
  }

  /** 按方言生成查询建表语句的 SQL */
  private getCreateSqlForDialect(table: string, database?: string, schema?: string, targetSchema?: string): string {
    const dbType = this.queryService.dialect.dbType;
    const qualified = this.wrapQualified(table, database, schema);
    switch (dbType) {
      case 'MYSQL':
        return `SHOW CREATE TABLE ${qualified}`;
      case 'PG': {
        validateIdent(table, 63);
        /**
         * 三处此前都是坏的：
         *
         * 1. `ad.adsrc` —— `pg_attrdef.adsrc` 在 PostgreSQL **12 被移除**
         *    （11 起废弃）。引用它的查询在 PG 12+ 上直接报
         *    `column ad.adsrc does not exist`，也就是说"查看建表语句"这个功能
         *    在所有现代 PG 上都不工作，而报错完全指不到原因。
         *    正确写法是 `pg_get_expr(ad.adbin, ad.adrelid)`。
         *
         * 2. `quote_literal(${'${this.wrap(database)}'})` —— `wrap` 生成的是**双引号
         *    标识符** `"myschema"`，而 PG 里双引号表示标识符，于是它被解析成
         *    "把名为 myschema 的列传给 quote_literal"，报
         *    `column "myschema" does not exist`。指定 schema 的路径同样是坏的。
         *    schema 名要以字符串字面量进去。
         *
         * 3. 缺 `relkind` 过滤与 `ORDER BY a.attnum`。pg_class 里表、索引、
         *    序列、视图共用 relname 命名空间，同名索引会让 string_agg 把两个
         *    对象的列混在一起；而 string_agg 不保证输入顺序，不排序时生成的
         *    DDL 列顺序随机 —— 拿它去别处建表，按位置赋值的 INSERT 就错列。
         */
        // B1b：显式 schema 用**字符串字面量**（方言 escapeValue，scs 安全）；未给回退
        // current_schema()。注意不能复用 this.wrap(schema)：双引号是标识符语法，
        // `quote_literal("x")` 会被解析成"名为 x 的列"，正是本节要修的缺陷。
        const schemaExpr = schema ? this.esc(validateSchemaIdent(schema, 63)) : 'current_schema()';
        // B5：未显式给 schema 时建表 DDL **不加** schema 限定（交 search_path），避免把
        // 当前 schema 名写死进 dump/「查看建表 SQL」，导致恢复到别的 schema 时写错目标。
        // 跨 schema 同步（targetSchema）：表头写成目标 schema（quote_ident 用字面量），
        // 列仍按 `schema` 过滤读取；不做脆弱的 DDL 文本替换。
        const tableExpr = targetSchema
          ? `quote_ident(${this.esc(validateSchemaIdent(targetSchema, 63))}) || '.' || quote_ident(c.relname)`
          : schema
            ? `quote_ident(n.nspname) || '.' || quote_ident(c.relname)`
            : `quote_ident(c.relname)`;
        const groupBy = schema ? 'n.nspname, c.relname' : 'c.relname';
        return `SELECT
            'CREATE TABLE ' || ${tableExpr} || ' (' || chr(10) ||
            string_agg(
              '  ' || quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
                || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                || CASE WHEN ad.adbin IS NOT NULL
                        THEN ' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid)
                        ELSE '' END,
              ',' || chr(10) ORDER BY a.attnum
            ) || chr(10) || ');' AS create_sql
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
          WHERE c.relname = ${this.esc(table)}
            AND n.nspname = ${schemaExpr}
            AND c.relkind IN ('r', 'p')
          GROUP BY ${groupBy}`;
      }
      default:
        // 表名进的是字符串**字面量**而非标识符，`wrap` 的翻倍转义在这里不适用；
        // 而 SQLite 驱动经 CLI stdin 执行、天然支持多语句，一个 `x'; DROP ...; --`
        // 会被完整执行。校验之外再用方言的 escapeValue 生成字面量，两道都上。
        validateIdent(table);
        return `SELECT sql FROM sqlite_master WHERE name = ${this.esc(table)}`;
    }
  }
}
