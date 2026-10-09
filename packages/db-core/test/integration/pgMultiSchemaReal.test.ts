import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg, { Client } from 'pg';
import { IConnection } from '../../src/connection/connection';
import { QueryService } from '../../src/query/queryService';
import { MetadataService } from '../../src/query/metadataService';
import { DataService } from '../../src/query/dataService';
import { TableService } from '../../src/query/tableService';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { BackupService } from '../../src/query/backupService';
import { SchemaDiffService } from '../../src/query/schemaDiffService';
import { DataDiffService } from '../../src/query/dataDiffService';
import { DataTransferService } from '../../src/query/dataTransferService';
import { withDatabaseInUrl } from '../../src/utils/connectionUrl';

// 与生产 PostgreSqlConnection 一致：禁用 pg 对日期/JSON 的默认解析。
pg.types.setTypeParser(1114, (val) => val);
pg.types.setTypeParser(1184, (val) => val);
pg.types.setTypeParser(1082, (val) => val);

const URL = process.env.DEVBELT_DB_TEST_PG_URL;

/** 把真实 pg.Client 适配成 db-core 的 IConnection（单连接、无参数绑定路径）。 */
class PgClientConnection extends IConnection {
  constructor(private readonly client: Client) { super({ host: '', port: 0, user: '' }); }
  query(sql: string, callback: any): void;
  query(sql: string, values: any, callback: any): void;
  query(sql: string, values: any, callback?: any): void {
    const cb = typeof values === 'function' ? values : callback;
    const params = typeof values === 'function' ? undefined : values;
    this.client.query(sql, params as any[], (err: any, res: any) => {
      if (err) return cb(err);
      const result = Array.isArray(res) ? res[res.length - 1] : res;
      cb(null, { rows: result?.rows ?? [], rowCount: result?.rowCount ?? 0 }, (result?.fields ?? []).map((f: any) => ({ name: f.name })));
    });
  }
  connect(cb: (e: any) => void): void { cb(null); }
  beginTransaction(cb: (e: any) => void): void { cb(null); }
  rollback(): void {}
  commit(): void {}
  end(): void {}
  isAlive(): boolean { return true; }
}

/**
 * D28：真实 PG 多 schema 集成门禁。
 *
 * B1 的缺陷全部落在「多个 schema 下存在同名对象」这类场景，单测难以覆盖：
 * 两个 schema 各放同名表、同名外键约束、同名触发器，验证限定、隔离与往返。
 * CI 由 DEVBELT_DB_TEST_PG_URL 开启；本地无 PG 时整体 skip。
 */
const stamp = Date.now();
const S1 = `zms_a_${stamp}`;
const S2 = `zms_b_${stamp}`;

describe.skipIf(!URL)('db-core PG 多 schema（real db）', () => {
  const dialect = new PostgreSqlDialect();
  let raw: Client;
  let query: QueryService;
  let meta: MetadataService;
  let data: DataService;
  let table: TableService;

  beforeAll(async () => {
    raw = new Client({ connectionString: URL! });
    await raw.connect();
    for (const s of [S1, S2]) {
      await raw.query(`CREATE SCHEMA ${s}`);
      await raw.query(`CREATE TABLE ${s}.dept (id int PRIMARY KEY, name text)`);
      await raw.query(`CREATE TABLE ${s}.orders (id int PRIMARY KEY, dept_id int, note text)`);
      await raw.query(`INSERT INTO ${s}.dept VALUES (10, 'd'), (20, 'e')`);
      await raw.query(`INSERT INTO ${s}.orders VALUES (1, 10, 'a'), (2, 20, 'b')`);
      // 两个 schema 里放**同名外键约束**（PG 约束名只在 schema 内唯一）。
      await raw.query(`ALTER TABLE ${s}.orders ADD CONSTRAINT fk_dept FOREIGN KEY (dept_id) REFERENCES ${s}.dept(id)`);
      // 两个 schema 里放**同名触发器**，但函数体不同，用于区分命中的是哪张表。
      await raw.query(`CREATE FUNCTION ${s}.${s}_fn() RETURNS trigger AS $$ BEGIN NEW.note := NEW.note || '-${s}'; RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await raw.query(`CREATE TRIGGER trg_orders BEFORE INSERT ON ${s}.orders FOR EACH ROW EXECUTE FUNCTION ${s}.${s}_fn()`);
    }
    query = new QueryService(new PgClientConnection(raw), dialect);
    meta = new MetadataService(query);
    data = new DataService(query);
    table = new TableService(query);
  }, 30_000);

  afterAll(async () => {
    if (!raw) return;
    for (const s of [S1, S2]) {
      try { await raw.query(`DROP SCHEMA ${s} CASCADE`); } catch { /* noop */ }
    }
    await raw.end();
  }, 30_000);

  it('浏览：每个 schema 只返回自己的表', async () => {
    const a = (await meta.getTables(undefined, S1)).map((t) => t.name).sort();
    const b = (await meta.getTables(undefined, S2)).map((t) => t.name).sort();
    expect(a).toEqual(['dept', 'orders']);
    expect(b).toEqual(['dept', 'orders']);
    // 列元数据按 schema 限定（两个 schema 同名表都存在，不能混淆）。
    const cols = await meta.getColumns('orders', undefined, S2);
    expect(cols.map((c) => c.name)).toEqual(['id', 'dept_id', 'note']);
  });

  it('编辑：写到目标 schema，另一个 schema 不受影响', async () => {
    await data.updateCell('orders', ['id'], [1], 'note', 'edited', undefined, S1);
    const s1 = await raw.query(`SELECT note FROM ${S1}.orders WHERE id = 1`);
    const s2 = await raw.query(`SELECT note FROM ${S2}.orders WHERE id = 1`);
    expect(s1.rows[0].note).toBe('edited');
    expect(s2.rows[0].note).toBe('a');
    // 归位
    await data.updateCell('orders', ['id'], [1], 'note', 'a', undefined, S1);
  });

  it('导出→导入 round-trip：DDL/INSERT 都带 schema 限定，恢复落在原 schema', async () => {
    // 用**独立临时表**，避免动到既有 orders（其上有外键/触发器，且被其它用例依赖）。
    const t = `rt_${stamp}`;
    await raw.query(`CREATE TABLE ${S1}."${t}" (id int PRIMARY KEY, v text)`);
    await raw.query(`INSERT INTO ${S1}."${t}" VALUES (1,'a'),(2,'b')`);
    try {
      const ddl = await table.getCreateSql(t, undefined, S1);
      // quote_ident 对安全名字不加引号：正则允许引号可选。
      expect(ddl).toMatch(new RegExp(`CREATE TABLE "?${S1}"?\\.("?${t}"?)`));
      const rows = (await query.queryAll(`SELECT * FROM ${dialect.wrap(S1)}.${dialect.wrap(t)}`)).rows;
      const inserts = dialect.buildInsertSql(rows as any[], ['id', 'v'], t, undefined, S1);
      expect(inserts).toMatch(new RegExp(`INSERT INTO "${S1}"\\."${t}"`));

      await raw.query(`DROP TABLE ${S1}."${t}"`);
      await raw.query(ddl);
      await raw.query(inserts);
      const back = await raw.query(`SELECT count(*)::int AS n FROM ${S1}."${t}"`);
      expect(back.rows[0].n).toBe(2);
      // 未被限定到 search_path（public）里。
      const stray = await raw.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
        [t],
      );
      expect(stray.rows[0].n).toBe(0);
    } finally {
      await raw.query(`DROP TABLE IF EXISTS ${S1}."${t}"`);
    }
  });

  it('外键：同名约束不跨 schema 错配，且带 refSchema', async () => {
    const a = await meta.getForeignKeys(undefined, S1);
    const b = await meta.getForeignKeys(undefined, S2);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toMatchObject({ tableName: 'orders', refTable: 'dept', constraintName: 'fk_dept', refSchema: S1 });
    expect(b[0]).toMatchObject({ tableName: 'orders', refTable: 'dept', constraintName: 'fk_dept', refSchema: S2 });
  });

  it('触发器定义：同名触发器按 schema + 表定位到正确的对象', async () => {
    const a = await meta.getTriggerDefinition('trg_orders', undefined, S1, 'orders');
    const b = await meta.getTriggerDefinition('trg_orders', undefined, S2, 'orders');
    expect(a).toContain(S1);
    expect(b).toContain(S2);
    expect(a).not.toBe(b);
  });

  it('搜索覆盖：逐 schema 枚举可命中非默认 schema 的对象', async () => {
    // 模拟全局搜索的遍历口径（库 × schema），确认两个 schema 的 orders 都能被搜到。
    const schemas = await meta.getSchemas();
    const found: { schema: string; name: string }[] = [];
    for (const schema of schemas) {
      for (const t of await meta.getTables(undefined, schema)) {
        if (t.name.includes('orders')) found.push({ schema, name: t.name });
      }
    }
    // 只断言本测试创建的两个 schema（库里可能有残留 schema 的同名表）。
    const ours = found.filter((f) => f.schema === S1 || f.schema === S2);
    expect(new Set(ours.map((f) => f.schema))).toEqual(new Set([S1, S2]));
  });

  it('C1：按 schema 备份读取目标 schema 的表（public 同名表不干扰），并可 round-trip 恢复', async () => {
    const t = `c1_rt_${stamp}`;
    const S3 = `zms_c1_${stamp}`;
    // public 放一张**同名但数据不同**的表：C1 缺陷下备份会静默读到它。
    await raw.query(`CREATE TABLE public."${t}" (id int PRIMARY KEY, v text)`);
    await raw.query(`INSERT INTO public."${t}" VALUES (1,'PUBLIC-ROW')`);
    await raw.query(`CREATE TABLE ${S2}."${t}" (id int PRIMARY KEY, v text)`);
    await raw.query(`INSERT INTO ${S2}."${t}" VALUES (1,'s2-1'),(2,'s2-2')`);
    try {
      const dbName = (await raw.query('SELECT current_database() AS d')).rows[0].d as string;
      const dump = await BackupService.databaseDump(query, meta, table, dbName, { schema: S2, tables: [t] });
      expect(dump).toContain('s2-1');
      expect(dump).not.toContain('PUBLIC-ROW');

      // dump 目标相对（不带 schema 前缀）→ 用 search_path 恢复到全新 schema。
      await raw.query(`CREATE SCHEMA ${S3}`);
      await raw.query(`SET search_path TO ${S3}`);
      await raw.query(dump);
      await raw.query('SET search_path TO public');
      const back = await raw.query(`SELECT v FROM ${S3}."${t}" ORDER BY id`);
      expect(back.rows.map((r) => r.v)).toEqual(['s2-1', 's2-2']);
    } finally {
      await raw.query('SET search_path TO public');
      await raw.query(`DROP TABLE IF EXISTS ${S2}."${t}"`);
      await raw.query(`DROP TABLE IF EXISTS public."${t}"`);
      await raw.query(`DROP SCHEMA IF EXISTS ${S3} CASCADE`);
    }
  });

  it('重载函数：按 identity args 导出全部重载定义（不再只取第一个）', async () => {
    await raw.query(`CREATE FUNCTION ${S2}.ovl(a int) RETURNS int AS $$ SELECT a $$ LANGUAGE sql`);
    await raw.query(`CREATE FUNCTION ${S2}.ovl(a int, b int) RETURNS int AS $$ SELECT a + b $$ LANGUAGE sql`);
    try {
      const dbName = (await raw.query('SELECT current_database() AS d')).rows[0].d as string;
      const dump = await BackupService.databaseDump(query, meta, table, dbName, { schema: S2 });
      const defs = dump.match(/CREATE OR REPLACE FUNCTION[^\n]*?ovl/gi) ?? [];
      expect(defs.length).toBe(2);
    } finally {
      await raw.query(`DROP FUNCTION IF EXISTS ${S2}.ovl(int)`);
      await raw.query(`DROP FUNCTION IF EXISTS ${S2}.ovl(int, int)`);
    }
  });

  it('多库（B2）：可见库列表含新建库；按库会话读到该库自己的对象', async () => {
    const db2 = `zms_db_${stamp}`;
    await raw.query(`CREATE DATABASE ${db2}`);
    let client2: Client | undefined;
    try {
      const names = (await query.queryAll(dialect.getDatabaseListSql())).rows.map((r: any) => r.name);
      expect(names).toContain(db2);

      // 用 withDatabaseInUrl（兼容 `?sslmode=` 等 query），而非脆弱的尾部正则。
      client2 = new Client({ connectionString: withDatabaseInUrl(URL!, db2) });
      await client2.connect();
      await client2.query('CREATE SCHEMA s1');
      await client2.query('CREATE TABLE s1.t (id int)');
      const q2 = new QueryService(new PgClientConnection(client2), dialect);
      const m2 = new MetadataService(q2);
      expect((await m2.getTables(undefined, 's1')).map((t) => t.name)).toEqual(['t']);
    } finally {
      if (client2) await client2.end();
      await raw.query(`DROP DATABASE ${db2} WITH (FORCE)`);
    }
  });

  it('A6：含空格/双引号的合法 schema 可浏览、可操作（放松白名单后）', async () => {
    const SS = `zms sp"ace_${stamp}`;
    const ssQ = `"${SS.replace(/"/g, '""')}"`;
    await raw.query(`CREATE SCHEMA ${ssQ}`);
    await raw.query(`CREATE TABLE ${ssQ}."sp_tbl" (id int PRIMARY KEY, v text)`);
    await raw.query(`INSERT INTO ${ssQ}."sp_tbl" VALUES (1, 'x')`);
    try {
      // 列表：放松白名单后应能看到（旧实现被字符正则过滤掉）。
      expect(await meta.getSchemas()).toContain(SS);
      // 浏览：按 schema 限定返回该表。
      expect((await meta.getTables(undefined, SS)).map((t) => t.name)).toEqual(['sp_tbl']);
      // 编辑：写到该 schema（schema 名作为双引号标识符安全引用）。
      await data.updateCell('sp_tbl', ['id'], [1], 'v', 'edited', undefined, SS);
      const r = await raw.query(`SELECT v FROM ${ssQ}."sp_tbl" WHERE id = 1`);
      expect(r.rows[0].v).toBe('edited');
    } finally {
      await raw.query(`DROP SCHEMA IF EXISTS ${ssQ} CASCADE`);
    }
  });

  it('4B：同连接跨 schema 结构对比 + 目标 schema 同步 SQL 可执行', async () => {
    const dbName = (await raw.query('SELECT current_database() AS d')).rows[0].d as string;
    // S1/S2 基础结构相同 → 给 S1.orders 加一列，制造差异。
    await raw.query(`ALTER TABLE ${S1}.orders ADD COLUMN extra text`);
    try {
      const diffs = await SchemaDiffService.diff(meta, dbName, meta, dbName, S1, S2);
      const orders = diffs.find((d) => d.tableName === 'orders')!;
      expect(orders.status).toBe('changed');
      expect(orders.columns.some((c) => c.columnName === 'extra' && c.status === 'added')).toBe(true);

      const sql = await SchemaDiffService.generateSyncSql(diffs, dbName, table, dbName, dialect, { sourceSchema: S1, targetSchema: S2 });
      // DDL 限定到目标 schema，绝不串到源 schema。
      expect(sql).toContain(`"${S2}"."orders"`);
      expect(sql).not.toContain(`"${S1}"."orders"`);

      await raw.query(sql);
      const cols = await meta.getColumns('orders', undefined, S2);
      expect(cols.map((c) => c.name)).toContain('extra');
    } finally {
      await raw.query(`ALTER TABLE IF EXISTS ${S2}.orders DROP COLUMN IF EXISTS extra`);
      await raw.query(`ALTER TABLE IF EXISTS ${S1}.orders DROP COLUMN IF EXISTS extra`);
    }
  });

  it('P1：新增含 serial 列的表，同步 SQL 的目标默认值指向目标 schema 序列（非源）', async () => {
    const dbName = (await raw.query('SELECT current_database() AS d')).rows[0].d as string;
    const t = `p1ser_${stamp}`;
    await raw.query(`CREATE TABLE ${S1}."${t}" (id serial PRIMARY KEY, v text)`);
    try {
      const diffs = await SchemaDiffService.diff(meta, dbName, meta, dbName, S1, S2);
      const sql = await SchemaDiffService.generateSyncSql(diffs, dbName, table, dbName, dialect, { sourceSchema: S1, targetSchema: S2 });
      // 默认值经 pg_depend 完全限定后改写到目标 schema（目标 schema 带引号，H1）。
      expect(sql).toContain(`nextval('"${S2}".`);
      expect(sql).not.toContain(`nextval('${S1}.`);
    } finally {
      await raw.query(`DROP TABLE IF EXISTS ${S1}."${t}"`);
    }
  });

  it('4B：同连接跨 schema 数据对比（限定各 schema）并同步到目标 schema', async () => {
    const dbName = (await raw.query('SELECT current_database() AS d')).rows[0].d as string;
    // S1/S2 的 dept 初始相同；改 S1 一行制造差异。
    await raw.query(`UPDATE ${S1}.dept SET name = 'changed' WHERE id = 10`);
    try {
      const r = await DataDiffService.diff(
        query, meta, dbName, query, dbName, ['dept'],
        { sourceSchema: S1, targetSchema: S2 },
      );
      const dept = r.diffs.find((d) => d.tableName === 'dept')!;
      expect(dept.rows.some((row) => row.status === 'changed')).toBe(true);

      const sql = DataDiffService.generateSyncSql(r, dbName, query, S2);
      expect(sql).toContain(`"${S2}"."dept"`);
      await raw.query(sql);
      const back = await raw.query(`SELECT name FROM ${S2}.dept WHERE id = 10`);
      expect(back.rows[0].name).toBe('changed');
    } finally {
      await raw.query(`UPDATE ${S2}.dept SET name = 'd' WHERE id = 10`);
      await raw.query(`UPDATE ${S1}.dept SET name = 'd' WHERE id = 10`);
    }
  });

  it('P3 真库执行：transferDatabase 生成并执行脚本，校验结构/序列/setval', async () => {
    const dbName = (await raw.query('SELECT current_database() AS d')).rows[0].d as string;
    const A = `zms_p3a_${stamp}_t`;
    const B = `zms_p3b_${stamp}_t`;
    await raw.query(`CREATE TABLE ${S1}."${A}" (id bigserial PRIMARY KEY, name text UNIQUE, data jsonb)`);
    await raw.query(`CREATE TABLE ${S1}."${B}" (id int PRIMARY KEY, a_id bigint REFERENCES ${S1}."${A}"(id))`);
    await raw.query(`CREATE INDEX "${A}_lower" ON ${S1}."${A}" (lower(name))`);
    await raw.query(`CREATE INDEX "${A}_gin" ON ${S1}."${A}" USING gin (data)`);
    await raw.query(`INSERT INTO ${S1}."${A}" (name, data) VALUES ('a','{"k":1}'),('b','{"k":2}')`);
    await raw.query(`INSERT INTO ${S1}."${B}" VALUES (1, 1)`);
    try {
      const res = await DataTransferService.transferDatabase(
        query, meta, table, dbName,
        query, meta, dbName,
        { sourceSchema: S1, targetSchema: S2, haltOnError: true },
      );
      expect(res.errors).toEqual([]);
      // 结构：列。
      const cols = (await raw.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
        [S2, A],
      )).rows.map((r) => r.column_name);
      expect(cols).toEqual(['id', 'name', 'data']);
      // 约束：PK + UNIQUE。
      const contypes = (await raw.query(
        `SELECT c.contype FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2`,
        [S2, A],
      )).rows.map((r) => r.contype);
      expect(contypes).toEqual(expect.arrayContaining(['p', 'u']));
      // 索引：表达式 + GIN。
      const idxdefs = (await raw.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2`, [S2, A])).rows.map((r) => r.indexdef).join('\n');
      expect(idxdefs).toMatch(/lower\(/);
      expect(idxdefs).toMatch(/USING gin/i);
      // 外键（B→A）。
      const fk = (await raw.query(
        `SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2 AND c.contype='f'`,
        [S2, B],
      )).rowCount;
      expect(fk).toBe(1);
      // 数据导入 + 序列归属 S2 + setval 推进：插入一行不冲突。
      expect((await raw.query(`SELECT count(*)::int AS n FROM ${S2}."${A}"`)).rows[0].n).toBe(2);
      const seq = (await raw.query(`SELECT pg_get_serial_sequence($1,'id') AS s`, [`${S2}."${A}"`])).rows[0].s as string;
      expect(seq).toContain(S2);
      const ins = await raw.query(`INSERT INTO ${S2}."${A}" (name) VALUES ('c') RETURNING id`);
      expect(Number(ins.rows[0].id)).toBe(3);
    } finally {
      await raw.query(`DROP TABLE IF EXISTS ${S1}."${B}"`);
      await raw.query(`DROP TABLE IF EXISTS ${S1}."${A}"`);
      await raw.query(`DROP TABLE IF EXISTS ${S2}."${B}"`);
      await raw.query(`DROP TABLE IF EXISTS ${S2}."${A}"`);
    }
  });

  it('H2 真库：dump 在源 schema 位于 search_path 时不写死源 schema 的 nextval', async () => {
    const dbName = (await raw.query('SELECT current_database() AS d')).rows[0].d as string;
    const T = `zms_h2_${stamp}_t`;
    await raw.query(`CREATE TABLE ${S1}."${T}" (id bigserial PRIMARY KEY, v text)`);
    const prev = (await raw.query('SHOW search_path')).rows[0].search_path as string;
    try {
      await raw.query(`SET search_path TO ${S1}, public`);
      const dump = await BackupService.databaseDump(query, meta, table, dbName, { schema: S1, tables: [T] });
      // H2：未传 targetSchema → pg_get_expr，不带源 schema 的 nextval。
      expect(dump).not.toMatch(new RegExp(`nextval\\('"?${S1}`));
    } finally {
      await raw.query(`SET search_path TO ${prev}`);
      await raw.query(`DROP TABLE IF EXISTS ${S1}."${T}"`);
    }
  });
}, 60_000);