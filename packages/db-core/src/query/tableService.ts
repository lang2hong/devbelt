import * as sqlstring from 'sqlstring';
import { validateIdent } from '../utils/validate';
import { QueryService } from './queryService';
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
    return this.ddl(
      `RENAME TABLE ${this.wrapQualified(table, database)} TO ${this.wrapQualified(newName, database)}`,
    );
  }

  /** 清空表（危险操作） */
  async truncateTable(table: string, database?: string): Promise<QueryResult> {
    return this.ddl(`TRUNCATE TABLE ${this.wrapQualified(table, database)}`);
  }

  /** 复制表结构（含数据） */
  async dupTable(table: string, newName: string, database?: string): Promise<QueryResult> {
    return this.ddl(
      `CREATE TABLE ${this.wrapQualified(newName, database)} LIKE ${this.wrapQualified(table, database)}`,
    );
  }

  /** 查询建表语句（各方言实现不同，返回首行首列） */
  async getCreateSql(table: string, database?: string): Promise<string> {
    const sql = this.getCreateSqlForDialect(table, database);
    const result = await this.queryService.query(sql);
    const row = result.rows[0] as Record<string, any> | undefined;
    if (!row) return '';
    return Object.values(row)[0] as string;
  }

  /** 删除视图 */
  async dropView(view: string, database?: string): Promise<QueryResult> {
    return this.ddl(`DROP VIEW ${this.wrapQualified(view, database)}`);
  }

  /** 删除函数/存储过程 */
  async dropRoutine(name: string, routineType: string, database?: string): Promise<QueryResult> {
    const qualified = this.wrapQualified(name, database);
    return this.ddl(`DROP ${routineType} IF EXISTS ${qualified}`);
  }

  /** 删除事件 */
  async dropEvent(name: string, database?: string): Promise<QueryResult> {
    const qualified = this.wrapQualified(name, database);
    return this.ddl(`DROP EVENT IF EXISTS ${qualified}`);
  }

  /** 删除索引 */
  async dropIndex(indexName: string, table: string, database?: string): Promise<QueryResult> {
    const qualifiedTable = this.wrapQualified(table, database);
    return this.ddl(`DROP INDEX ${this.wrap(indexName)} ON ${qualifiedTable}`);
  }

  /** 创建索引 */
  async createIndex(indexName: string, table: string, columns: string[], database?: string, isUnique = false): Promise<QueryResult> {
    const qualifiedTable = this.wrapQualified(table, database);
    const colList = columns.map((c) => this.wrap(c)).join(', ');
    return this.ddl(`CREATE ${isUnique ? 'UNIQUE ' : ''}INDEX ${this.wrap(indexName)} ON ${qualifiedTable} (${colList})`);
  }

  // ── 用户管理 ──

  /** 创建用户 */
  async createUser(name: string, password: string, host = '%'): Promise<QueryResult> {
    return this.ddl(`CREATE USER ${sqlstring.escape(name)}@${sqlstring.escape(host)} IDENTIFIED BY ${sqlstring.escape(password)}`);
  }

  async dropUser(name: string, host = '%'): Promise<QueryResult> {
    return this.ddl(`DROP USER IF EXISTS ${sqlstring.escape(name)}@${sqlstring.escape(host)}`);
  }

  async alterUserPassword(name: string, password: string, host = '%'): Promise<QueryResult> {
    return this.ddl(`ALTER USER ${sqlstring.escape(name)}@${sqlstring.escape(host)} IDENTIFIED BY ${sqlstring.escape(password)}`);
  }

  async grantPrivilege(name: string, privilege: string, database?: string, host = '%'): Promise<QueryResult> {
    const PRIV_WHITELIST = /^(ALL(\s+PRIVILEGES)?|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|REFERENCES|TRIGGER|EXECUTE|USAGE|RELOAD|PROCESS|REPLICATION\s+CLIENT|REPLICATION\s+SLAVE|SHOW\s+DATABASES|SHUTDOWN|SUPER)$/i;
    if (!PRIV_WHITELIST.test(privilege.trim())) {
      throw new Error(`Invalid privilege: "${privilege}"`);
    }
    const target = database ? `${this.wrap(validateIdent(database))}.*` : '*.*';
    return this.ddl(`GRANT ${privilege} ON ${target} TO ${sqlstring.escape(name)}@${sqlstring.escape(host)}`);
  }

  async revokePrivilege(name: string, privilege: string, database?: string, host = '%'): Promise<QueryResult> {
    const PRIV_WHITELIST = /^(ALL(\s+PRIVILEGES)?|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|REFERENCES|TRIGGER|EXECUTE|USAGE|RELOAD|PROCESS|REPLICATION\s+CLIENT|REPLICATION\s+SLAVE|SHOW\s+DATABASES|SHUTDOWN|SUPER)$/i;
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
    const parts: string[] = [];
    const ddl = await this.getCreateSql(table, database);
    parts.push(`-- Table: ${database ? database + '.' : ''}${table}`);
    parts.push(`DROP TABLE IF EXISTS ${this.wrapQualified(table, database)};`);
    parts.push(ddl + ';');
    parts.push('');
    if (includeData) {
      const selectResult = await this.queryService.query(`SELECT * FROM ${this.wrapQualified(table, database)}`);
      if (selectResult.rows.length > 0) {
        const fields = selectResult.fields.map((f: any) => f.name);
        const colList = fields.map((f: string) => this.wrap(f)).join(', ');
        for (const row of selectResult.rows) {
          const values = fields.map((f: string) => {
            const v = row[f];
            if (v === null || v === undefined) return 'NULL';
            return sqlstring.escape(v);
          }).join(', ');
          parts.push(`INSERT INTO ${this.wrapQualified(table, database)} (${colList}) VALUES (${values});`);
        }
        parts.push(`-- ${selectResult.rows.length} row(s) dumped`);
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
      cols = result.rows.map((r: any) => this.normalizeCol(r));
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

  /** 按列名/类型生成 Mock 值 */
  private mockValue(col: ColumnMeta, seq: number): string {
    const name = (col.name || '').toLowerCase();
    const type = (col.simpleType || col.type || '').toLowerCase();

    // 语义匹配
    if (name.includes('email')) return `'user${seq}@example.com'`;
    if (name.includes('phone') || name.includes('mobile')) return `'1${String(Math.floor(Math.random() * 9e9)).padStart(9, '0')}'`;
    if (name.includes('name')) return `'${this.randomName()}'`;
    if (name.includes('address')) return `'${this.randomAddress()}'`;
    if (name.includes('city')) return `'${this.randomCity()}'`;
    if (name.includes('url') || name.includes('website')) return `'https://example.com/${seq}'`;
    if (name.includes('avatar') || name.includes('image')) return `'https://example.com/avatar/${seq}.png'`;
    if (name.includes('password')) return `'${this.randomString(12)}'`;
    if (name.includes('token')) return `'${this.randomString(32)}'`;
    if (name.includes('ip')) return `'${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}'`;
    if (name.includes('status')) return `'${['active', 'inactive', 'pending'][seq % 3]}'`;
    if (name.includes('code')) return `'${this.randomString(8).toUpperCase()}'`;
    if (name.includes('desc') || name.includes('content') || name.includes('comment')) return `'Mock data ${seq}'`;

    // 类型匹配
    if (type.includes('int') || type.includes('bigint') || type.includes('serial')) return String(seq + 1);
    if (type.includes('bool') || type.includes('bit')) return seq % 2 === 0 ? '1' : '0';
    if (type.includes('decimal') || type.includes('float') || type.includes('double')) return (Math.random() * 10000).toFixed(2);
    if (type.includes('date') || type.includes('time') || type.includes('year')) {
      const d = new Date(Date.now() - Math.floor(Math.random() * 365 * 86400000));
      return `'${d.toISOString().slice(0, 19).replace('T', ' ')}'`;
    }
    if (type.includes('text') || type.includes('blob')) return `'Mock ${seq}'`;

    // 默认：随机字符串
    return `'${this.randomString(10)}'`;
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

  /** 归一化列元数据（兼容各方言返回格式） */
  private normalizeCol(row: any): ColumnMeta {
    const name = row.name ?? row.Field ?? row.column_name ?? row['name'];
    const type = row.type ?? row.Type ?? row.data_type ?? row['type'];
    return {
      name,
      simpleType: row.simple_type ?? String(type).split('(')[0],
      type,
      comment: row.comment ?? row.Comment ?? row['comment'] ?? '',
      key: row.key ?? row.Key ?? row['key'] ?? '',
      nullable: row.nullable ?? row.Null ?? row.is_nullable ?? '',
      maxLength: row.maxLength ?? '',
      defaultValue: row.defaultValue ?? row.Default ?? row.column_default ?? '',
      extra: row.extra ?? row.Extra ?? '',
      isNotNull: row.isNotNull ?? false,
      isAutoIncrement: String(row.extra ?? row.Extra ?? '').includes('auto_increment'),
      isUnique: false,
      isPrimary: row.key === 'PRI' || row.Key === 'PRI',
      pk: '',
    };
  }

  /** 执行 DDL */
  private async ddl(sql: string): Promise<QueryResult> {
    return this.queryService.query(sql);
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
      case 'PG':
        return `SELECT pg_get_tabledef('${table}'::regclass)`;
      default:
        return `SELECT sql FROM sqlite_master WHERE name = '${table}'`;
    }
  }
}
