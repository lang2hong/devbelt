import { validateIdent } from '../utils/validate';
import { QueryService } from './queryService';
import type { QueryOptions } from './queryService';
import { supportsOperation, unsupportedOperationMessage } from '../dialect/capabilities';
import type { DatabaseOperation } from '../dialect/capabilities';
import { normalizeColumnMeta } from './normalize';
import type { QueryResult } from '../types/query';
import type { ColumnMeta } from '../types/meta';

/** 建表时的单列定义（由设计器逐项填写，SQL 由方言合成）。 */
export interface NewColumnSpec {
  name: string;
  /** 列类型原文，如 `VARCHAR(255)`、`INT`。 */
  type: string;
  notNull?: boolean;
  isPrimary?: boolean;
  autoIncrement?: boolean;
  /** 默认值原文；数字与 CURRENT_TIMESTAMP 等关键字原样写入，其余按字符串转义。 */
  defaultValue?: string;
  /** 列注释（仅 MySQL 支持列内联 COMMENT，其余方言忽略）。 */
  comment?: string;
}

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
  async createTable(table: string, columns: NewColumnSpec[], database?: string): Promise<QueryResult> {
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
    return this.ddl(`CREATE TABLE ${this.wrapQualified(table, database)} (\n  ${defs.join(',\n  ')}\n)`);
  }

  private columnDefinition(col: NewColumnSpec, dbType: string, sqliteInlinePk: boolean): string {
    validateIdent(col.name);
    const type = (col.type || '').trim();
    if (!type) throw new Error(`Column "${col.name}" requires a type.`);
    const parts: string[] = [this.wrap(col.name)];

    if (col.autoIncrement && dbType === 'PG') {
      parts.push(/big/i.test(type) ? 'BIGSERIAL' : 'SERIAL');
    } else if (col.autoIncrement && dbType === 'SQLITE') {
      parts.push('INTEGER');
    } else {
      parts.push(type);
    }

    if (sqliteInlinePk && col.autoIncrement) {
      parts.push('PRIMARY KEY AUTOINCREMENT');
      return parts.join(' ');
    }
    // PG 的 SERIAL 已隐含 NOT NULL，再写一遍合法但冗余
    if ((col.notNull || col.isPrimary) && !(col.autoIncrement && dbType === 'PG')) {
      parts.push('NOT NULL');
    }
    if (col.autoIncrement && dbType === 'MYSQL') parts.push('AUTO_INCREMENT');
    if (col.defaultValue !== undefined && col.defaultValue !== '' && !col.autoIncrement) {
      parts.push(`DEFAULT ${this.defaultLiteral(col.defaultValue)}`);
    }
    // 列内联 COMMENT 是 MySQL 语法，PG/SQLite 的 CREATE TABLE 不接受
    if (col.comment && dbType === 'MYSQL') parts.push(`COMMENT ${this.esc(col.comment)}`);
    return parts.join(' ');
  }

  /** 默认值字面量：数字与时间关键字原样写入，其余按方言规则转义为字符串。 */
  private defaultLiteral(value: string): string {
    const keyword = /^(CURRENT_TIMESTAMP(\(\d*\))?|CURRENT_DATE|CURRENT_TIME|NULL|TRUE|FALSE)$/i;
    return /^-?\d+(\.\d+)?$/.test(value) || keyword.test(value) ? value : this.esc(value);
  }

  /** 删除表（危险操作） */
  async dropTable(table: string, database?: string): Promise<QueryResult> {
    return this.ddl(`DROP TABLE ${this.wrapQualified(table, database)}`);
  }

  /** 重命名表 */
  async renameTable(table: string, newName: string, database?: string): Promise<QueryResult> {
    this.require('renameTable');
    if (this.queryService.dialect.dbType === 'MYSQL') {
      return this.ddl(
        `RENAME TABLE ${this.wrapQualified(table, database)} TO ${this.wrapQualified(newName, database)}`,
      );
    }
    return this.ddl(`ALTER TABLE ${this.wrapQualified(table, database)} RENAME TO ${this.wrap(newName)}`);
  }

  /** 重命名视图 */
  async renameView(view: string, newName: string, database?: string): Promise<QueryResult> {
    this.require('renameView');
    if (this.queryService.dialect.dbType === 'MYSQL') {
      return this.ddl(`RENAME TABLE ${this.wrapQualified(view, database)} TO ${this.wrapQualified(newName, database)}`);
    }
    return this.ddl(`ALTER VIEW ${this.wrapQualified(view, database)} RENAME TO ${this.wrap(newName)}`);
  }

  /** 清空表（危险操作） */
  async truncateTable(table: string, database?: string): Promise<QueryResult> {
    this.require('truncateTable');
    return this.ddl(`TRUNCATE TABLE ${this.wrapQualified(table, database)}`);
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
  async dupTable(table: string, newName: string, database?: string, includeData = false): Promise<QueryResult> {
    this.require('duplicateTable');
    validateIdent(table);
    validateIdent(newName);
    const source = this.wrapQualified(table, database);
    const target = this.wrapQualified(newName, database);
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

  /** 查询建表语句（各方言实现不同，返回首行首列） */
  async getCreateSql(table: string, database?: string): Promise<string> {
    this.require('getTableDefinition');
    const sql = this.getCreateSqlForDialect(table, database);
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
  async dropView(view: string, database?: string): Promise<QueryResult> {
    return this.ddl(`DROP VIEW ${this.wrapQualified(view, database)}`);
  }

  /** 删除函数/存储过程 */
  async dropRoutine(name: string, routineType: string, database?: string): Promise<QueryResult> {
    this.require('manageRoutines');
    const qualified = this.wrapQualified(name, database);
    return this.ddl(`DROP ${routineType} IF EXISTS ${qualified}`);
  }

  /** 删除事件 */
  async dropEvent(name: string, database?: string): Promise<QueryResult> {
    this.require('manageEvents');
    const qualified = this.wrapQualified(name, database);
    return this.ddl(`DROP EVENT IF EXISTS ${qualified}`);
  }

  /** 删除索引（主键索引走 ALTER TABLE DROP PRIMARY KEY） */
  async dropIndex(indexName: string, table: string, database?: string): Promise<QueryResult> {
    this.require('manageIndexes');
    const qualifiedTable = this.wrapQualified(table, database);
    if (indexName.toUpperCase() === 'PRIMARY') {
      return this.ddl(`ALTER TABLE ${qualifiedTable} DROP PRIMARY KEY`);
    }
    return this.ddl(`DROP INDEX ${this.wrap(indexName)} ON ${qualifiedTable}`);
  }

  /** 创建索引（主键走 ALTER TABLE ADD PRIMARY KEY） */
  async createIndex(indexName: string, table: string, columns: string[], database?: string, isUnique = false): Promise<QueryResult> {
    this.require('manageIndexes');
    const qualifiedTable = this.wrapQualified(table, database);
    const colList = columns.map((c) => this.wrap(c)).join(', ');
    if (indexName.toUpperCase() === 'PRIMARY') {
      return this.ddl(`ALTER TABLE ${qualifiedTable} ADD PRIMARY KEY (${colList})`);
    }
    return this.ddl(`CREATE ${isUnique ? 'UNIQUE ' : ''}INDEX ${this.wrap(indexName)} ON ${qualifiedTable} (${colList})`);
  }

  /** 重建主键（编辑主键索引时：DROP + ADD 单语句） */
  async recreatePrimaryKey(table: string, columns: string[], database?: string): Promise<QueryResult> {
    this.require('manageIndexes');
    const qualifiedTable = this.wrapQualified(table, database);
    const colList = columns.map((c) => this.wrap(c)).join(', ');
    return this.ddl(`ALTER TABLE ${qualifiedTable} DROP PRIMARY KEY, ADD PRIMARY KEY (${colList})`);
  }

  /** 新增外键 */
  async addForeignKey(table: string, name: string, columns: string[], refTable: string, refColumns: string[], database?: string): Promise<QueryResult> {
    this.require('alterTable');
    const sql = this.queryService.dialect.createForeignKeySql(name, table, columns, refTable, refColumns, database);
    if (!sql) throw new Error(`${this.queryService.dialect.dbType} does not support adding foreign keys.`);
    return this.ddl(sql);
  }

  /** 删除外键 */
  async dropForeignKey(name: string, table: string, database?: string): Promise<QueryResult> {
    this.require('alterTable');
    const sql = this.queryService.dialect.dropForeignKeySql(name, table, database);
    if (!sql) throw new Error(`${this.queryService.dialect.dbType} does not support dropping foreign keys.`);
    return this.ddl(sql);
  }

  /** 新增列 */
  async addColumn(table: string, column: string, definition: string, database?: string): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    const def = definition.trim();
    if (!def) throw new Error('Column definition is required.');
    return this.ddl(`ALTER TABLE ${this.wrapQualified(table, database)} ADD COLUMN ${this.wrap(column)} ${def}`);
  }

  /** 删除列（危险操作，需二次确认） */
  async dropColumn(table: string, column: string, database?: string): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    return this.ddl(`ALTER TABLE ${this.wrapQualified(table, database)} DROP COLUMN ${this.wrap(column)}`);
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
    definition: string,
    database?: string,
  ): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    validateIdent(newName);
    const def = definition.trim();
    if (!def) throw new Error('Column definition is required.');
    const qualified = this.wrapQualified(table, database);
    const dbType = this.queryService.dialect.dbType;

    if (dbType === 'MYSQL') {
      return this.ddl(
        `ALTER TABLE ${qualified} CHANGE COLUMN ${this.wrap(column)} ${this.wrap(newName)} ${def}`,
      );
    }
    if (dbType === 'PG') {
      if (newName !== column) {
        await this.ddl(`ALTER TABLE ${qualified} RENAME COLUMN ${this.wrap(column)} TO ${this.wrap(newName)}`);
      }
      return this.ddl(`ALTER TABLE ${qualified} ALTER COLUMN ${this.wrap(newName)} TYPE ${def}`);
    }
    if (newName === column) {
      throw new Error(`${dbType} does not support altering a column type.`);
    }
    return this.renameColumn(table, column, newName, database);
  }

  /** 仅改列名（三家方言都支持 `RENAME COLUMN`，MySQL 8.0+ 亦可）。 */
  async renameColumn(table: string, column: string, newName: string, database?: string): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    validateIdent(newName);
    return this.ddl(
      `ALTER TABLE ${this.wrapQualified(table, database)} RENAME COLUMN ${this.wrap(column)} TO ${this.wrap(newName)}`,
    );
  }

  /** 修改列定义。MySQL 用 MODIFY COLUMN；PG 用 ALTER COLUMN TYPE；SQLite 不支持改类型 */
  async modifyColumn(table: string, column: string, definition: string, database?: string): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    const def = definition.trim();
    if (!def) throw new Error('Column definition is required.');
    const dbType = this.queryService.dialect.dbType;
    if (dbType === 'MYSQL') {
      return this.ddl(`ALTER TABLE ${this.wrapQualified(table, database)} MODIFY COLUMN ${this.wrap(column)} ${def}`);
    }
    if (dbType === 'PG') {
      return this.ddl(`ALTER TABLE ${this.wrapQualified(table, database)} ALTER COLUMN ${this.wrap(column)} TYPE ${def}`);
    }
    throw new Error(`${dbType} does not support altering a column type.`);
  }

  /** 调整列位置（仅 MySQL：CHANGE COLUMN ... AFTER/FIRST）。afterColumn 为 null 表示移到最前(FIRST)。 */
  async reorderColumn(table: string, column: string, afterColumn: string | null, database?: string): Promise<QueryResult> {
    this.require('alterTable');
    validateIdent(table);
    validateIdent(column);
    const dbType = this.queryService.dialect.dbType;
    if (dbType !== 'MYSQL') {
      throw new Error(`${dbType} does not support reordering columns.`);
    }
    const def = await this.getFullColumnDef(table, column, database);
    const position = afterColumn ? ` AFTER ${this.wrap(afterColumn)}` : ' FIRST';
    return this.ddl(`ALTER TABLE ${this.wrapQualified(table, database)} CHANGE COLUMN ${this.wrap(column)} ${this.wrap(column)} ${def}${position}`);
  }

  /**
   * 读取列的完整定义（MySQL）。
   *
   * 供「改列」预填当前定义用：只给类型会把 NOT NULL / DEFAULT / 注释 / 自增
   * 全部抹掉，这在 `CHANGE COLUMN` 里是静默的数据/约束丢失。
   */
  async getColumnDefinition(table: string, column: string, database?: string): Promise<string> {
    validateIdent(table);
    validateIdent(column);
    if (this.queryService.dialect.dbType !== 'MYSQL') {
      throw new Error(`${this.queryService.dialect.dbType} does not expose a full column definition.`);
    }
    return this.getFullColumnDef(table, column, database);
  }

  /** 从 SHOW CREATE TABLE 解析指定列的完整定义（含 NOT NULL/DEFAULT/charset/ON UPDATE 等所有属性）。 */
  private async getFullColumnDef(table: string, column: string, database?: string): Promise<string> {
    const ddl = await this.getCreateSql(table, database);
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
      if (!database) throw new Error('PostgreSQL requires a schema name for grant.');
      return this.ddl(`GRANT ${privilege} ON ALL TABLES IN SCHEMA ${this.wrap(validateIdent(database))} TO ${this.wrap(validateIdent(name))}`);
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
      if (!database) throw new Error('PostgreSQL requires a schema name for revoke.');
      return this.ddl(`REVOKE ${privilege} ON ALL TABLES IN SCHEMA ${this.wrap(validateIdent(database))} FROM ${this.wrap(validateIdent(name))}`);
    }
    const target = database ? `${this.wrap(validateIdent(database))}.*` : '*.*';
    return this.ddl(`REVOKE ${privilege} ON ${target} FROM ${this.esc(name)}@${this.esc(host)}`);
  }

  /**
   * 导出表结构 + 数据（mysqldump 风格 SQL）。
   * 生成：DROP TABLE IF EXISTS + CREATE TABLE + INSERT 语句。
   */
  async dumpSql(table: string, database?: string, includeData = true): Promise<string> {
    this.require('dumpTable');
    validateIdent(table);
    const parts: string[] = [];
    const ddl = await this.getCreateSql(table, database);
    parts.push(`-- Table: ${database ? database + '.' : ''}${table}`);
    parts.push(`DROP TABLE IF EXISTS ${this.wrapQualified(table, database)};`);
    parts.push(ddl + ';');
    parts.push('');
    if (includeData) {
      const DUMP_BATCH = 1000;
      let offset = 0;
      let totalRows = 0;
      const qualified = this.wrapQualified(table, database);
      for (;;) {
        const page = await this.queryService.query(
          `SELECT * FROM ${qualified} LIMIT ${DUMP_BATCH} OFFSET ${offset}`,
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
  ): Promise<number> {
    let cols: ColumnMeta[];
    if (columns && columns.length > 0) {
      cols = columns;
    } else {
      const result = await this.queryService.query(
        this.queryService.dialect.getColumnsSql(table, database),
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
        const values = insertCols.map((c) => this.mockValue(c, batch * batchSize + i)).join(', ');
        valuesList.push(`(${values})`);
      }
      const sql = `INSERT INTO ${this.wrapQualified(table, database)} (${colList}) VALUES ${valuesList.join(', ')}`;
      // 批量循环不逐条进历史，否则百万行 mock 会把上限 100 条的历史冲干；
      // 命令层会补一条汇总记录。
      await this.queryService.query(sql, undefined, { skipHistory: true });
      inserted += batchCount;
    }
    return inserted;
  }

  /** 按列名/类型生成 Mock 值（感知 enum 合法值与 varchar 长度） */
  private mockValue(col: ColumnMeta, seq: number): string {
    const name = (col.name || '').toLowerCase();
    const type = (col.simpleType || col.type || '').toLowerCase();
    const fullType = col.type || '';
    const isNumeric = /int|bigint|serial|decimal|float|double|bool|bit/.test(type);
    const isTemporal = /date|time|year/.test(type);

    let val: string;
    const enumVals = this.parseEnum(fullType);
    if (enumVals.length) {
      val = enumVals[seq % enumVals.length];
    } else if (name.includes('email')) {
      val = `user${seq}@example.com`;
    } else if (name.includes('phone') || name.includes('mobile')) {
      val = `1${String(Math.floor(Math.random() * 9e9)).padStart(9, '0')}`;
    } else if (name.includes('name')) {
      val = this.randomName();
    } else if (name.includes('address')) {
      val = this.randomAddress();
    } else if (name.includes('city')) {
      val = this.randomCity();
    } else if (name.includes('url') || name.includes('website')) {
      val = `https://example.com/${seq}`;
    } else if (name.includes('avatar') || name.includes('image')) {
      val = `https://example.com/avatar/${seq}.png`;
    } else if (name.includes('password')) {
      val = this.randomString(12);
    } else if (name.includes('token')) {
      val = this.randomString(32);
    } else if (name.includes('ip')) {
      val = `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    } else if (name.includes('status')) {
      val = ['active', 'inactive', 'pending'][seq % 3];
    } else if (name.includes('code')) {
      val = this.randomString(8).toUpperCase();
    } else if (name.includes('desc') || name.includes('content') || name.includes('comment')) {
      val = `Mock data ${seq}`;
    } else if (type.includes('int') || type.includes('bigint') || type.includes('serial')) {
      val = String(seq + 1);
    } else if (type.includes('bool') || type.includes('bit')) {
      val = seq % 2 === 0 ? '1' : '0';
    } else if (type.includes('decimal') || type.includes('float') || type.includes('double')) {
      val = (Math.random() * 10000).toFixed(2);
    } else if (isTemporal) {
      const d = new Date(Date.now() - Math.floor(Math.random() * 365 * 86400000));
      val = d.toISOString().slice(0, 19).replace('T', ' ');
    } else if (type.includes('text') || type.includes('blob')) {
      val = `Mock ${seq}`;
    } else {
      val = this.randomString(10);
    }

    // 字符串类型按 varchar(N) 截断，避免 Data too long（text/blob/json 不限长）
    if (!isNumeric && !isTemporal && !/text|blob|json/i.test(type)) {
      const m = fullType.match(/\((\d+)\)/);
      let max = m ? parseInt(m[1], 10) : 0;
      if (max === 0 && /char/i.test(type)) max = 1; // char 无长度默认 1
      if (max > 0 && val.length > max) val = val.slice(0, max);
    }

    // 值转义走方言（this.esc）：此处曾自建 `'${val.replace(/'/g,"''")}'`，
    // 只处理单引号而漏掉反斜杠，MySQL 下造出的数据会与预期不符。
    return isNumeric ? val : this.esc(val);
  }

  /** 解析 enum/set 列的合法值 */
  private parseEnum(type?: string): string[] {
    if (!type) return [];
    const m = type.match(/(?:enum|set)\s*\((.*)\)/i);
    if (!m) return [];
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  }

  private randomName(): string {
    const first = ['John', 'Jane', 'Bob', 'Alice', 'Charlie', 'David', 'Eve', 'Frank', 'Grace', 'Henry'];
    const last = ['Smith', 'Jones', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas'];
    return `${first[Math.floor(Math.random() * first.length)]} ${last[Math.floor(Math.random() * last.length)]}`;
  }

  private randomCity(): string {
    const cities = ['New York', 'London', 'Tokyo', 'Paris', 'Berlin', 'Sydney', 'Toronto', 'Singapore', 'Shanghai', 'Mumbai'];
    return cities[Math.floor(Math.random() * cities.length)];
  }

  private randomAddress(): string {
    return `${Math.floor(Math.random() * 9999)} Main St, ${this.randomCity()}`;
  }

  private randomString(len: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  private async ddl(sql: string, options?: QueryOptions): Promise<QueryResult> {
    return this.queryService.query(sql, undefined, options);
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

  private require(operation: DatabaseOperation): void {
    if (!this.supports(operation)) {
      throw new Error(unsupportedOperationMessage(this.queryService.dialect.dbType, operation));
    }
  }

  /** 包裹标识符 */
  private wrap(identifier: string): string {
    return this.queryService.dialect.wrap(identifier);
  }

  /** 包裹限定名：`db`.`table` 或 `"table"` */
  private wrapQualified(name: string, database?: string): string {
    if (!database) return this.wrap(name);
    return `${this.wrap(database)}.${this.wrap(name)}`;
  }

  /** 按方言生成查询建表语句的 SQL */
  private getCreateSqlForDialect(table: string, database?: string): string {
    const dbType = this.queryService.dialect.dbType;
    const qualified = this.wrapQualified(table, database);
    switch (dbType) {
      case 'MYSQL':
        return `SHOW CREATE TABLE ${qualified}`;
      case 'PG': {
        validateIdent(table);
        const schema = database ? `quote_literal(${this.wrap(database)})` : 'current_schema()';
        return `SELECT
            'CREATE TABLE ' || quote_ident(c.relname) || ' (' || chr(10) ||
            string_agg(
              '  ' || quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
                || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                || CASE WHEN ad.adsrc IS NOT NULL THEN ' DEFAULT ' || ad.adsrc ELSE '' END,
              ',' || chr(10)
            ) || chr(10) || ');' AS create_sql
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
          WHERE c.relname = '${table}' AND n.nspname = ${schema}
          GROUP BY c.relname`;
      }
      default:
        return `SELECT sql FROM sqlite_master WHERE name = '${table}'`;
    }
  }
}
