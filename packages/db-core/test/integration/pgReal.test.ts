import { describe, expect, it } from 'vitest';
import pg, { Client } from 'pg';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';

// 与生产 PostgreSqlConnection 一致：禁用 pg 驱动对日期/JSON 的默认解析，
// 否则读到的是 JS Date 对象而非原始文本（dateStrings 语义）。
pg.types.setTypeParser(1114, (val) => val); // TIMESTAMP
pg.types.setTypeParser(1184, (val) => val); // TIMESTAMPTZ
pg.types.setTypeParser(1082, (val) => val); // DATE
pg.types.setTypeParser(114, (val) => val); // JSON
pg.types.setTypeParser(3802, (val) => val); // JSONB

const URL = process.env.PG_TEST_URL;

describe.skipIf(!URL)('db-core PostgreSQL dialect (real db)', () => {
  const dialect = new PostgreSqlDialect();

  it('F 项回归：varchar 列精确比较（裸数字在 PG 直接报错）', async () => {
    const client = new Client({ connectionString: URL! });
    await client.connect();
    const schema = `ztest_${Date.now()}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    try {
      await client.query(`SET search_path TO ${schema}`);
      await client.query(`CREATE TABLE ftest (id varchar(20) PRIMARY KEY, extra varchar(20))`);
      await client.query(`INSERT INTO ftest VALUES ('1','exact'),('01','leading'),(' 1','spaced'),('1abc','suffix')`);

      // 修复后：精确字符串
      const fixed = await client.query(`SELECT id FROM ftest WHERE ${dialect.wrap('id')} = '1'`);
      expect(fixed.rows.map((r) => r.id)).toEqual(['1']);

      // 修复前形态：裸数字 → PG 类型严格，operator does not exist (42883)
      await expect(client.query(`SELECT id FROM ftest WHERE ${dialect.wrap('id')} = 1`))
        .rejects.toMatchObject({ code: '42883' });
    } finally {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  });

  it('indexdef LIKE UNIQUE 误判：列名含 UNIQUE 字样的普通索引', async () => {
    const client = new Client({ connectionString: URL! });
    await client.connect();
    const schema = `ztest_${Date.now()}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    try {
      await client.query(`SET search_path TO ${schema}`);
      await client.query(`CREATE TABLE t (id serial PRIMARY KEY, UNIQUEflag int, created_at timestamptz)`);
      await client.query(`CREATE INDEX idx_plain ON t (UNIQUEflag)`); // 普通索引
      await client.query(`CREATE INDEX idx_created ON t (created_at DESC)`);
      await client.query(`CREATE UNIQUE INDEX uq_flag ON t (UNIQUEflag)`); // 唯一索引

      const sql = dialect.getIndexListSql('t');
      const { rows } = await client.query(sql);
      const parsed = dialect.parseIndexList(rows);
      const byName = new Map(parsed.map((p) => [p.name, p]));

      // 普通索引（列名含 UNIQUE 字样）→ 不应被判唯一
      const plain = byName.get('idx_plain')!;
      expect(plain.isUnique).toBe(false);

      // 唯一索引 → 应为唯一
      expect(byName.get('uq_flag')!.isUnique).toBe(true);

      // DESC 索引 → 列名解析正确
      const created = byName.get('idx_created')!;
      expect(created.columns).toContain('created_at');
    } finally {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  });

  it('缺陷证实：getViewDefinitionSql 对含大写视图名解析失败', async () => {
    const client = new Client({ connectionString: URL! });
    await client.connect();
    const schema = `ztest_${Date.now()}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    try {
      await client.query(`SET search_path TO ${schema}`);
      await client.query(`CREATE TABLE base (id int)`);
      await client.query(`CREATE VIEW "PublicOrders" AS SELECT id FROM base`);

      // 方言 SQL: current_schema() || '.' || 'PublicOrders'
      // current_schema() 已有值，拼接后带点号 → PG 把两侧当裸标识符小写化，
      // 最终解析 "ztest_xxx.publicorders"，找不到大写视图 → 失败。
      const sql = dialect.getViewDefinitionSql('PublicOrders');
      await expect(client.query(sql)).rejects.toThrow(/does not exist/);
    } finally {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  });

  it('escapeValue 写读往返在 PG13 一致', async () => {
    const client = new Client({ connectionString: URL! });
    await client.connect();
    const schema = `ztest_${Date.now()}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    try {
      await client.query(`SET search_path TO ${schema}`);
      await client.query(`CREATE TABLE t (id int PRIMARY KEY, s varchar(255), d date, f real)`);
      const esc = (v: any) => dialect.escapeValue(v);
      await client.query(`INSERT INTO t VALUES (${esc(1)}, ${esc(`a'b\\c`)}, ${esc('2024-01-15')}, ${esc(1.5)})`);
      const { rows } = await client.query(`SELECT s, d, f FROM t`);
      expect(rows[0].s).toBe(`a'b\\c`);
      expect(String(rows[0].d)).toBe('2024-01-15');
    } finally {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  });
}, 30_000);