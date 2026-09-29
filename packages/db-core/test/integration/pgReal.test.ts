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

const URL = process.env.DEVBELT_DB_TEST_PG_URL;

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

  it('M1：getViewDefinitionSql 对含大写/特殊字符的视图名也能取到定义', async () => {
    const client = new Client({ connectionString: URL! });
    await client.connect();
    const schema = `ztest_${Date.now()}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    try {
      await client.query(`SET search_path TO ${schema}`);
      await client.query(`CREATE TABLE base (id int)`);
      await client.query(`CREATE VIEW "Public-Orders" AS SELECT id FROM base`);

      // 按 relkind + oid 取定义，不经名字解析 —— 大写/`-` 都能命中。
      const sql = dialect.getViewDefinitionSql('Public-Orders', undefined, schema);
      const res = await client.query(sql);
      expect(res.rows).toHaveLength(1);
      expect(String(res.rows[0].definition)).toContain('SELECT');
      // 指定其它 schema 时应查不到。
      const other = await client.query(dialect.getViewDefinitionSql('Public-Orders', undefined, 'public'));
      expect(other.rows).toHaveLength(0);
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

  /**
   * standard_conforming_strings=off 时普通 `'...'` 串里反斜杠是转义字符。
   * 若仍按 on 语义（只翻倍单引号）生成字面量，`a\b` 会写成 `'a\b'`，
   * PG 解析成退格 + 裸字节 → 读回不一致。off 变体翻倍反斜杠后逐字节一致。
   */
  it('standard_conforming_strings=off 时 escapeValue 写读逐字节一致', async () => {
    const client = new Client({ connectionString: URL! });
    await client.connect();
    const schema = `ztest_scs_${Date.now()}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    try {
      await client.query(`SET search_path TO ${schema}`);
      await client.query('CREATE TABLE t (id int PRIMARY KEY, s varchar(255))');
      await client.query('SET standard_conforming_strings = off');

      const offDialect = new PostgreSqlDialect({ standardConformingStrings: false });
      const samples = ['a\\b', "x\\' OR 1=1 -- ", 'back\\slash\\', "quote'and\\back"];
      for (let i = 0; i < samples.length; i++) {
        await client.query(`INSERT INTO t VALUES (${i}, ${offDialect.escapeValue(samples[i])})`);
      }
      const { rows } = await client.query('SELECT id, s FROM t ORDER BY id');
      expect(rows.map((r) => r.s)).toEqual(samples);

      // 对照：on 变体在该会话里只翻倍单引号，反斜杠会被当转义（故需连接期探测换变体）
      expect(new PostgreSqlDialect().escapeValue('a\\b')).toBe("'a\\b'");
    } finally {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  });
}, 30_000);
/**
 * 本阶段（S2-4）修复的 PG 时间类型：DATE/TIMESTAMP 必须原样文本返回，
 * 而不是 pg 默认的 JS Date（经 webview 序列化后会变成 UTC/ISO，DATE 在东八区差一天）。
 * 实库验证，CI 由 DEVBELT_DB_TEST_PG_URL 开启。
 */
describe.skipIf(!URL)('db-core PostgreSQL temporal (real db)', () => {
  it('DATE/TIMESTAMP 以原始文本返回（dateStrings 语义）', async () => {
    const client = new Client({ connectionString: URL! });
    await client.connect();
    const schema = `ztest_ts_${Date.now()}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    try {
      await client.query(`SET search_path TO ${schema}`);
      await client.query('CREATE TABLE ts_test (d date, ts timestamp, tstz timestamptz)');
      await client.query("INSERT INTO ts_test VALUES ('2024-01-14', '2024-01-14 16:00:00', '2024-01-14 16:00:00+08')");

      const res = await client.query('SELECT d, ts, tstz FROM ts_test');
      const row = res.rows[0];
      expect(row.d).toBe('2024-01-14');
      expect(row.ts).toBe('2024-01-14 16:00:00');
      expect(typeof row.d).toBe('string');
      expect(typeof row.ts).toBe('string');
      // 不得是 Date / ISO 串（旧实现会得到 2024-01-14T16:00:00.000Z）
      expect(String(row.ts)).not.toMatch(/T.*Z$/);
    } finally {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  });
});

/**
 * S4 实库真实用例（此前为 skip 占位）：主键识别必须基于 pg_index.indisprimary，
 * 而不是猜 `<table>_pkey` 名字——自定义约束名下主键会被误判为普通唯一索引。
 */
describe.skipIf(!URL)('db-core PostgreSQL dialect S4 (real db)', () => {
  const dialect = new PostgreSqlDialect();

  it('自定义约束名的主键通过 indisprimary 被识别为主键', async () => {
    const client = new Client({ connectionString: URL! });
    await client.connect();
    const schema = `ztest_pk_${Date.now()}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    try {
      await client.query(`SET search_path TO ${schema}`);
      await client.query('CREATE TABLE pk_test (id int, CONSTRAINT pk_custom PRIMARY KEY (id), v text)');
      const res = await client.query(dialect.getIndexListSql('pk_test'));
      const pk = res.rows.filter((r: any) => dialect.parseIndexList([r])[0]?.isPrimary);
      expect(pk.length).toBe(1);
      expect(pk[0].name).toBe('pk_custom');
    } finally {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  });
});
