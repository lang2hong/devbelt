import * as sqlstring from 'sqlstring';
import { validateIdent } from '../utils/validate';
import { QueryService } from './queryService';
import { supportsOperation, unsupportedOperationMessage } from '../dialect/capabilities';
import type { DatabaseOperation } from '../dialect/capabilities';
import { normalizeColumnMeta } from './normalize';
import type { QueryResult } from '../types/query';
import type { ColumnMeta } from '../types/meta';

/**
 * 表结构操作服务：创建/删除/重命名/清空/复制/查看建表语句。
 * 复用查询服务执行，标识符经方言转义，防止注入。
 *
 * 危险操作（删除/清空）需由上层 UI 二次确认后调用。
 */
export class TableService {
  constructor(private readonly queryService: QueryService) {}

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

  /** 清空表（危险操作） */
  async truncateTable(table: string, database?: string): Promise<QueryResult> {
    this.require('truncateTable');
    return this.ddl(`TRUNCATE TABLE ${this.wrapQualified(table, database)}`);
  }

  /** 复制表结构（含数据） */
  async dupTable(table: string, newName: string, database?: string): Promise<QueryResult> {
    this.require('duplicateTable');
    return this.ddl(
      `CREATE TABLE ${this.wrapQualified(newName, database)} LIKE ${this.wrapQualified(table, database)}`,
    );
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

  /** 删除索引 */
  async dropIndex(indexName: string, table: string, database?: string): Promise<QueryResult> {
    this.require('manageIndexes');
    const qualifiedTable = this.wrapQualified(table, database);
    return this.ddl(`DROP INDEX ${this.wrap(indexName)} ON ${qualifiedTable}`);
  }

  /** 创建索引 */
  async createIndex(indexName: string, table: string, columns: string[], database?: string, isUnique = false): Promise<QueryResult> {
    this.require('manageIndexes');
    const qualifiedTable = this.wrapQualified(table, database);
    const colList = columns.map((c) => this.wrap(c)).join(', ');
    return this.ddl(`CREATE ${isUnique ? 'UNIQUE ' : ''}INDEX ${this.wrap(indexName)} ON ${qualifiedTable} (${colList})`);
  }

  // ── 用户管理 ──

  /** 创建用户 */
  async createUser(name: string, password: string, host = '%'): Promise<QueryResult> {
    this.require('manageUsers');
    return this.ddl(`CREATE USER ${sqlstring.escape(name)}@${sqlstring.escape(host)} IDENTIFIED BY ${sqlstring.escape(password)}`);
  }

  async dropUser(name: string, host = '%'): Promise<QueryResult> {
    this.require('manageUsers');
    return this.ddl(`DROP USER IF EXISTS ${sqlstring.escape(name)}@${sqlstring.escape(host)}`);
  }

  async alterUserPassword(name: string, password: string, host = '%'): Promise<QueryResult> {
    this.require('manageUsers');
    return this.ddl(`ALTER USER ${sqlstring.escape(name)}@${sqlstring.escape(host)} IDENTIFIED BY ${sqlstring.escape(password)}`);
  }

  async grantPrivilege(name: string, privilege: string, database?: string, host = '%'): Promise<QueryResult> {
    this.require('manageUsers');
    const PRIV_WHITELIST = /^(ALL(\s+PRIVILEGES)?|SELECT|INSERT|UPDATE|DELETE|CREATE(\s+VIEW)?|DROP|ALTER|INDEX|REFERENCES|TRIGGER|EXECUTE|USAGE|RELOAD|PROCESS|REPLICATION\s+CLIENT|REPLICATION\s+SLAVE|SHOW\s+(VIEW|DATABASES)|SHUTDOWN|SUPER)$/i;
    if (!PRIV_WHITELIST.test(privilege.trim())) {
      throw new Error(`Invalid privilege: "${privilege}"`);
    }
    const target = database ? `${this.wrap(validateIdent(database))}.*` : '*.*';
    return this.ddl(`GRANT ${privilege} ON ${target} TO ${sqlstring.escape(name)}@${sqlstring.escape(host)}`);
  }

  async revokePrivilege(name: string, privilege: string, database?: string, host = '%'): Promise<QueryResult> {
    this.require('manageUsers');
    const PRIV_WHITELIST = /^(ALL(\s+PRIVILEGES)?|SELECT|INSERT|UPDATE|DELETE|CREATE(\s+VIEW)?|DROP|ALTER|INDEX|REFERENCES|TRIGGER|EXECUTE|USAGE|RELOAD|PROCESS|REPLICATION\s+CLIENT|REPLICATION\s+SLAVE|SHOW\s+(VIEW|DATABASES)|SHUTDOWN|SUPER)$/i;
    if (!PRIV_WHITELIST.test(privilege.trim())) {
      throw new Error(`Invalid privilege: "${privilege}"`);
    }
    const target = database ? `${this.wrap(validateIdent(database))}.*` : '*.*';
    return this.ddl(`REVOKE ${privilege} ON ${target} FROM ${sqlstring.escape(name)}@${sqlstring.escape(host)}`);
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
            return sqlstring.escape(v);
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
      await this.queryService.query(sql);
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

    return isNumeric ? val : `'${val.replace(/'/g, "''")}'`;
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

  private async ddl(sql: string): Promise<QueryResult> {
    return this.queryService.query(sql);
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
      default:
        return `SELECT sql FROM sqlite_master WHERE name = '${table}'`;
    }
  }
}
