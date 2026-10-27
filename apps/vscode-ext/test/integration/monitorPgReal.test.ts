import { afterAll, describe, expect, it } from 'vitest';
import { ConnectionFactory, DatabaseType, MetadataService, QueryService } from '@devbelt/db-core';
import { describeTableReadOnly, MonitorExecutor } from '../../src/monitor/monitorExecutor';
import { MonitorService } from '../../src/monitor/monitorService';
import { MonitorScheduler } from '../../src/monitor/monitorScheduler';
import type { MonitorPoint, MonitorTask } from '../../src/monitor/monitorTypes';

/**
 * P13 在真实 PostgreSQL 上的验证（CI 的 PG 服务；本地无 PG 时跳过）。
 *
 * 监控会话按扩展的方式打开：先模拟 `openIsolatedSql` 把 search_path 固定成 `pg_catalog`，
 * 再由执行器设只读并改回 search_path——这正是 H2 / N5 要覆盖的路径：
 * 有 schema → `"schema", public`；没有 → `RESET search_path`（未限定表名回到 public）。
 */
const PG_URL = process.env.DEVBELT_DB_TEST_PG_URL;

function verifyUrl(url: string): string {
  const db = /\/([^/?]+)(?:\?|$)/.exec(url.replace(/^postgres(?:ql)?:\/\/[^/]+/, ''))?.[1] ?? '';
  if (!/verify|test/i.test(db)) throw new Error(`refusing to use database ${JSON.stringify(db)} for integration tests`);
  return url;
}

async function open(): Promise<QueryService> {
  const { connection, dialect } = ConnectionFactory.createWithDialect(DatabaseType.PG, {
    host: '', port: 0, user: '', useConnectionString: true, connectionUrl: verifyUrl(PG_URL!),
  });
  await new Promise<void>((resolve, reject) => connection.connect((err) => (err ? reject(err) : resolve())));
  return new QueryService(connection, dialect);
}

const STAMP = Date.now();
const SCHEMA = `ztest_mon_${STAMP}`;
const PUBLIC_TABLE = `ztest_mon_public_${STAMP}`;
const opened: QueryService[] = [];
let admin: QueryService | undefined;

afterAll(async () => {
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => undefined);
    await admin.query(`DROP TABLE IF EXISTS public."${PUBLIC_TABLE}"`).catch(() => undefined);
    admin.end();
  }
  for (const q of opened.splice(0)) { try { q.end(); } catch { /* already closed */ } }
});

function harness() {
  const executor = new MonitorExecutor({
    dbTypeOf: () => 'PG',
    timeoutMs: () => 30_000,
    openSession: async () => {
      const q = await open();
      opened.push(q);
      // 与 ConnectionManager.openIsolatedSql 一致：独立会话先固定到 pg_catalog。
      await q.query('SET search_path = pg_catalog', undefined, { skipHistory: true });
      return { session: { query: q, metadata: new MetadataService(q) } as never, close: () => q.end() };
    },
  });
  let saved: MonitorTask[] = [];
  const points: MonitorPoint[] = [];
  const hits: Array<[number | undefined, number]> = [];
  const scheduler = new MonitorScheduler({
    store: {
      loadTasks: async () => saved,
      saveTasks: async (tasks) => { saved = [...tasks]; },
      appendPoint: async (_id, point) => { points.push(point); },
      deleteHistory: async () => undefined,
    },
    run: (task) => executor.run(task),
    canExecute: () => true,
    connectionValid: () => true,
    cooldownMs: () => 0,
    onHit: (_task, previous, value) => { hits.push([previous, value]); },
  });
  const conn = { id: 'pg1', name: 'verify', host: 'h', port: 5432, user: 'u', dbType: 'PG', database: 'verify' } as never;
  const service = new MonitorService({
    scheduler,
    executor,
    getConnection: () => conn,
    fingerprint: () => 'fp',
    allowProduction: () => false,
    maxTasks: () => 20,
    enabled: () => true,
    // 与 monitorSetup 一致：元数据走执行器的只读会话。
    describe: (c, database, schema, table) => executor.trial(
      { connId: (c as { id: string }).id, ...(database ? { database } : {}), ...(schema ? { schema } : {}) },
      (session) => describeTableReadOnly(session, 'PG', database, schema, table),
    ),
    audit: () => undefined,
  });
  const close = () => {
    scheduler.dispose();
    executor.dispose();
  };
  return { executor, scheduler, service, conn, hits, points, close };
}

describe.skipIf(!PG_URL)('monitoring on real PostgreSQL', () => {
  it('prepares fixtures', async () => {
    admin = await open();
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.query(`CREATE TABLE "${SCHEMA}".orders (id BIGINT PRIMARY KEY, amount INT NOT NULL)`);
    await admin.query(`INSERT INTO "${SCHEMA}".orders VALUES (1, 10), (2, 20), (3, 30)`);
    await admin.query(`CREATE TABLE "${SCHEMA}".events (id BIGINT PRIMARY KEY, at TIMESTAMPTZ NOT NULL, kind TEXT)`);
    await admin.query(`CREATE INDEX ON "${SCHEMA}".events (at)`);
    await admin.query(`INSERT INTO "${SCHEMA}".events VALUES (1, '2026-01-01 00:00:00+00', 'a'), (2, '2026-01-01 00:00:00+00', 'b')`);
    await admin.query(`CREATE TABLE public."${PUBLIC_TABLE}" (id BIGINT PRIMARY KEY)`);
    await admin.query(`INSERT INTO public."${PUBLIC_TABLE}" VALUES (1), (2)`);
  }, 60_000);

  it('counts rows in a schema and, without one, resolves unqualified names to public', async () => {
    const h = harness();
    try {
      await h.scheduler.add({
        id: 'pg-count-schema', kind: 'rowCount', connId: 'pg1', database: 'verify', schema: SCHEMA, table: 'orders',
        intervalMs: 24 * 3_600_000, condition: { type: 'anyChange' }, status: 'running', createdAt: Date.now(), consecutiveFailures: 0,
      });
      await h.scheduler.add({
        id: 'pg-count-public', kind: 'rowCount', connId: 'pg1', database: 'verify', table: PUBLIC_TABLE,
        intervalMs: 24 * 3_600_000, condition: { type: 'anyChange' }, status: 'running', createdAt: Date.now(), consecutiveFailures: 0,
      });
      expect(h.scheduler.get('pg-count-schema')).toMatchObject({ lastValue: 3 });
      expect(h.scheduler.get('pg-count-schema')?.lastError).toBeUndefined();
      expect(h.scheduler.get('pg-count-public')).toMatchObject({ lastValue: 2 });
      expect(h.scheduler.get('pg-count-public')?.lastError).toBeUndefined();
    } finally {
      h.close();
    }
  }, 60_000);

  it('reads metadata on the read-only monitor session, with and without a schema', async () => {
    const h = harness();
    try {
      const inSchema = await h.executor.trial({ connId: 'pg1', database: 'verify', schema: SCHEMA }, (s) => describeTableReadOnly(s, 'PG', 'verify', SCHEMA, 'events'));
      expect(inSchema.columns.map((c) => c.name)).toEqual(['id', 'at', 'kind']);
      // 无 schema：元数据里的 current_schema() 必须是 public，而不是 pg_catalog。
      const inPublic = await h.executor.trial({ connId: 'pg1', database: 'verify' }, (s) => describeTableReadOnly(s, 'PG', 'verify', undefined, PUBLIC_TABLE));
      expect(inPublic.columns.map((c) => c.name)).toEqual(['id']);
      const current = await h.executor.trial({ connId: 'pg1', database: 'verify' }, async (s) =>
        (await s.query.query('SELECT current_schema() AS s', undefined, { skipHistory: true })).rows);
      expect(current).toEqual([{ s: 'public' }]);
    } finally {
      h.close();
    }
  }, 60_000);

  it('proposes, confirms and runs a metric with unqualified names in the schema', async () => {
    const h = harness();
    try {
      const metric = await h.service.propose(h.conn, 'verify', SCHEMA, {
        kind: 'metric', table: 'orders',
        sql: 'SELECT COUNT(*) AS total_rows, MAX(id) AS max_id, SUM(amount) AS total_amount FROM orders',
        watchColumn: 'total_rows', condition: { type: 'increaseBy', value: 1 },
      });
      expect(metric).toMatchObject({ ok: true });
      if (!metric.ok) return;
      expect(metric.proposal.preview).toEqual({ total_rows: 3, max_id: 3, total_amount: 60 });
      const created = await h.service.confirm(metric.proposal.id);
      if (!created.ok) throw new Error(`confirm failed: ${created.reason}`);
      await admin!.query(`INSERT INTO "${SCHEMA}".orders VALUES (4, 40)`);
      await h.scheduler.runNow(created.task.id);
      expect(h.scheduler.get(created.task.id)?.lastValues).toEqual({ total_rows: 4, max_id: 4, total_amount: 100 });
      expect(h.hits).toEqual([[3, 4]]);
    } finally {
      h.close();
    }
  }, 60_000);

  it('tracks new rows on a bigint and a timestamptz cursor with de-duplication', async () => {
    const h = harness();
    try {
      // 编造的列被拒绝
      expect(await h.service.propose(h.conn, 'verify', SCHEMA, { kind: 'newRows', table: 'events', cursorColumn: 'created_at' }))
        .toMatchObject({ ok: false, issues: [{ code: 'columnMissing' }] });
      // TEXT 不能当游标
      expect(await h.service.propose(h.conn, 'verify', SCHEMA, { kind: 'newRows', table: 'events', cursorColumn: 'kind' }))
        .toMatchObject({ ok: false, issues: [{ code: 'cursorType' }] });

      const byTime = await h.service.propose(h.conn, 'verify', SCHEMA, { kind: 'newRows', table: 'events', cursorColumn: 'at', condition: { type: 'anyChange' } });
      const byId = await h.service.propose(h.conn, 'verify', SCHEMA, { kind: 'newRows', table: 'orders', cursorColumn: 'id', condition: { type: 'anyChange' } });
      expect(byTime.ok && byId.ok).toBe(true);
      if (!byTime.ok || !byId.ok) return;
      expect(byTime.proposal.cursorKind).toBe('temporal');
      expect(byId.proposal.cursorKind).toBe('integer');

      const t = await h.service.confirm(byTime.proposal.id);
      const i = await h.service.confirm(byId.proposal.id);
      if (!t.ok || !i.ok) throw new Error(`confirm failed: t=${JSON.stringify(t)} i=${JSON.stringify(i)}`);
      expect(t.task.cursorSeen?.length).toBe(2); // ids 1 and 2 share the same timestamp
      // 用例按顺序执行：上一个用例插入了 id=4，所以基线是 4。
      expect(i.task.cursorValue).toBe('4');

      // 与基线同一时间戳的新行 + 更晚的行：只算没见过的
      await admin!.query(`INSERT INTO "${SCHEMA}".events VALUES (3, '2026-01-01 00:00:00+00', 'c'), (4, '2026-01-02 00:00:00+00', 'd')`);
      await admin!.query(`INSERT INTO "${SCHEMA}".orders VALUES (10, 1), (11, 1)`);
      await h.scheduler.runNow(t.task.id);
      await h.scheduler.runNow(i.task.id);
      expect(h.scheduler.get(t.task.id)?.lastValue).toBe(2);
      expect(h.scheduler.latestRows(t.task.id)?.rows.map((r) => Number(r.id))).toEqual([3, 4]);
      expect(h.scheduler.get(i.task.id)).toMatchObject({ lastValue: 2, cursorValue: '11' });

      // 再跑一次：没有新行
      await h.scheduler.runNow(t.task.id);
      expect(h.scheduler.get(t.task.id)?.lastValue).toBe(0);
    } finally {
      h.close();
    }
  }, 90_000);

  it('refuses writes on the monitor session', async () => {
    const h = harness();
    try {
      await expect(h.executor.trial({ connId: 'pg1', database: 'verify', schema: SCHEMA }, (s) =>
        s.query.query('INSERT INTO orders VALUES (99, 1)', undefined, { skipHistory: true })))
        .rejects.toThrow(/read-only|read only/i);
      const rows = await admin!.query(`SELECT COUNT(*) AS n FROM "${SCHEMA}".orders WHERE id = 99`);
      expect(Number((rows.rows[0] as { n: unknown }).n)).toBe(0);
    } finally {
      h.close();
    }
  }, 60_000);
});
