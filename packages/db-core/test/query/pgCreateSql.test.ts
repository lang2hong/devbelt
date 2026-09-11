import { describe, expect, it } from 'vitest';
import { TableService } from '../../src/query/tableService';
import { QueryService } from '../../src/query/queryService';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { SqliteDialect } from '../../src/dialect/sqliteDialect';
import { IConnection } from '../../src/connection/connection';

/**
 * PG 的 `getCreateSql` 生成的查询。
 *
 * 这里断言 **SQL 文本**而不是执行结果 —— 本机没有 PostgreSQL 实例，
 * `test/integration/pgReal.test.ts` 的门禁（PG_TEST_URL）未开启。
 * 好在这三个缺陷都是"语句本身在现代 PG 上跑不起来"，文本级断言足以钉住：
 * 一旦有人把 `pg_get_expr` 换回 `adsrc`，这些用例立刻报红。
 */

class Capture extends IConnection {
  readonly sqls: string[] = [];
  constructor() { super({ host: 'h', port: 5432, user: 'u' }); }
  query(sql: any, values?: any, callback?: any): void {
    this.sqls.push(String(sql));
    const cb = typeof values === 'function' ? values : callback;
    // 返回一行，让 getCreateSql 走到取值分支
    setImmediate(() => cb(null, [{ create_sql: 'CREATE TABLE t ();' }], []));
  }
  connect(cb: (e: any) => void): void { cb(null); }
  beginTransaction(cb: (e: any) => void): void { cb(null); }
  rollback(): void {}
  commit(): void {}
  end(): void {}
  isAlive(): boolean { return true; }
}

function pgSvc() {
  const con = new Capture();
  const svc = new QueryService(con, new PostgreSqlDialect());
  return { con, table: new TableService(svc) };
}

describe('PG getCreateSql', () => {
  /**
   * `pg_attrdef.adsrc` 在 PostgreSQL **12 被移除**（11 起标记废弃）。
   * 引用它的查询在 PG 12+ 上直接报
   * `column ad.adsrc does not exist` —— 也就是说"查看建表语句"这个功能
   * 在所有现代 PG 上都是坏的，而且报错完全指不到原因。
   * 正确写法是 `pg_get_expr(ad.adbin, ad.adrelid)`。
   */
  it('不再引用 PG 12 已移除的 ad.adsrc', async () => {
    const { con, table } = pgSvc();
    await table.getCreateSql('t1');
    const sql = con.sqls[0];
    expect(sql).not.toMatch(/\badsrc\b/);
    expect(sql).toMatch(/pg_get_expr\s*\(\s*ad\.adbin\s*,\s*ad\.adrelid\s*\)/);
  });

  /**
   * schema 过滤原本是 `quote_literal("dbname")`。
   *
   * `this.wrap(database)` 生成的是**双引号标识符** `"dbname"`，而 PG 里双引号
   * 表示标识符 —— `quote_literal("dbname")` 会被解析成"把名为 dbname 的列
   * 当参数传给 quote_literal"，报 `column "dbname" does not exist`。
   * 指定 schema 时这个功能同样是坏的。
   */
  it('指定 schema 时生成字符串字面量而非双引号标识符', async () => {
    const { con, table } = pgSvc();
    await table.getCreateSql('t1', 'myschema');
    const sql = con.sqls[0];
    expect(sql).not.toMatch(/quote_literal\s*\(\s*"/);
    expect(sql).toMatch(/n\.nspname\s*=\s*'myschema'/);
  });

  it('未指定 schema 时用 current_schema()', async () => {
    const { con, table } = pgSvc();
    await table.getCreateSql('t1');
    expect(con.sqls[0]).toMatch(/current_schema\(\)/);
  });

  /**
   * 表名进的是字符串字面量位置，必须走方言的 escapeValue。
   * `validateIdent` 已经在前面兜了一层，但两道都上的成本是零。
   */
  it('表名走字面量转义，含单引号的名字不破坏语句', async () => {
    const { con, table } = pgSvc();
    // validateIdent 会拒绝含引号的名字，这里验证它确实拒绝
    await expect(table.getCreateSql("t'; DROP TABLE x; --")).rejects.toThrow();
    expect(con.sqls).toHaveLength(0);
  });

  it('schema 名同样经过校验', async () => {
    const { table } = pgSvc();
    await expect(table.getCreateSql('t1', "s'; DROP SCHEMA y; --")).rejects.toThrow();
  });

  /**
   * `pg_class` 里表、索引、序列、视图共用 relname 命名空间。
   * 不过滤 relkind 时，一个与表同名的索引会让 `string_agg` 把两个对象的列
   * 混在一起输出 —— 得到一段语法上像 DDL、内容上是错的文本。
   */
  it('限定 relkind 为普通表/分区表', async () => {
    const { con, table } = pgSvc();
    await table.getCreateSql('t1');
    expect(con.sqls[0]).toMatch(/c\.relkind\s+IN\s*\(\s*'r'\s*,\s*'p'\s*\)/i);
  });

  /**
   * 列顺序必须与表定义一致。`string_agg` 不保证输入顺序，不带 ORDER BY 时
   * 生成的 DDL 列顺序是随机的 —— 拿它去别处建表，`INSERT ... VALUES` 按位置
   * 赋值就会错列。
   */
  it('列按 attnum 排序', async () => {
    const { con, table } = pgSvc();
    await table.getCreateSql('t1');
    expect(con.sqls[0]).toMatch(/ORDER\s+BY\s+a\.attnum/i);
  });
});

describe('其他方言的 getCreateSql 未受影响', () => {
  it('MySQL 用 SHOW CREATE TABLE', async () => {
    const con = new Capture();
    const t = new TableService(new QueryService(con, new MysqlDialect()));
    await t.getCreateSql('t1', 'db1');
    expect(con.sqls[0]).toBe('SHOW CREATE TABLE `db1`.`t1`');
  });

  it('SQLite 查 sqlite_master 且表名走字面量转义', async () => {
    const con = new Capture();
    const t = new TableService(new QueryService(con, new SqliteDialect()));
    await t.getCreateSql('t1');
    expect(con.sqls[0]).toBe("SELECT sql FROM sqlite_master WHERE name = 't1'");
  });
});

describe('PG getColumnsSql 带长度/精度', () => {
  it('type 列拼接 character/numeric 的长度精度，供 schema diff 捕捉变化', () => {
    const sql = new PostgreSqlDialect().getColumnsSql('t1');
    expect(sql).toContain("data_type || '(' || character_maximum_length || ')'");
    expect(sql).toContain("numeric_precision");
    expect(sql).toContain('numeric_scale');
    expect(sql).toContain('udt_name');
  });
});
