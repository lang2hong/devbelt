import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionFactory, DatabaseType, MetadataService, QueryService } from '@devbelt/db-core';
import type { ConnectionConfig } from '@devbelt/db-core';
import { MonitorExecutor } from '../../src/monitor/monitorExecutor';
import { MonitorService } from '../../src/monitor/monitorService';
import { MonitorScheduler } from '../../src/monitor/monitorScheduler';
import type { MonitorPoint, MonitorTask } from '../../src/monitor/monitorTypes';

/**
 * P13 第一批真实库验证：在验证库（名字必须含 verify/test，且不是生产库）上建临时表，
 * 用真实的只读独立会话执行行数监控，插入数据后验证检测与通知，最后删表。
 */
function parseMysqlUrl(url: string) {
  const m = /^mysql:\/\/([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error('bad DEVBELT_DB_TEST_MYSQL_URL');
  return { host: m[3]!, port: m[4] ? Number(m[4]) : 3306, user: decodeURIComponent(m[1]!), password: decodeURIComponent(m[2]!) };
}

function mysqlDb(): string {
  const name = (process.env.DEVBELT_DB_TEST_MYSQL_DB || 'devbelt_db_verify').trim();
  const prod = (process.env.DEVBELT_DB_MYSQL_DATABASE || '').trim();
  if (!name || (prod && name.toLowerCase() === prod.toLowerCase()) || !/verify|test/i.test(name)) {
    throw new Error(`refusing to use ${JSON.stringify(name)} for integration tests`);
  }
  return name;
}

async function open(dbType: DatabaseType, config: ConnectionConfig): Promise<QueryService> {
  const { connection, dialect } = ConnectionFactory.createWithDialect(dbType, config);
  await new Promise<void>((resolve, reject) => connection.connect((err) => (err ? reject(err) : resolve())));
  return new QueryService(connection, dialect);
}

const MYSQL_URL = process.env.DEVBELT_DB_TEST_MYSQL_URL;

describe.skipIf(!MYSQL_URL)('row count monitoring on real MySQL', () => {
  it('detects new rows on a read-only isolated session and never writes', async () => {
    const config = { ...parseMysqlUrl(MYSQL_URL!), database: mysqlDb() };
    const table = `z_monitor_${Date.now()}`;
    const admin = await open(DatabaseType.MYSQL, config);
    const opened: QueryService[] = [];
    try {
      await admin.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY)`);
      await admin.query(`INSERT INTO \`${table}\` VALUES (1), (2), (3)`);

      const executor = new MonitorExecutor({
        dbTypeOf: () => 'MYSQL',
        timeoutMs: () => 30_000,
        openSession: async () => {
          const q = await open(DatabaseType.MYSQL, config);
          opened.push(q);
          return { session: { query: q }, close: () => q.end() };
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

      await scheduler.add({
        id: 'mreal1', kind: 'rowCount', connId: 'c1', database: config.database, table,
        intervalMs: 24 * 3_600_000, condition: { type: 'increaseBy', value: 2 }, status: 'running',
        createdAt: Date.now(), consecutiveFailures: 0,
      });
      expect(scheduler.get('mreal1')?.lastError).toBeUndefined();
      expect(scheduler.get('mreal1')?.lastValue).toBe(3);

      await admin.query(`INSERT INTO \`${table}\` VALUES (4)`);
      await scheduler.runNow('mreal1');
      expect(hits).toEqual([]); // +1 is below the threshold

      await admin.query(`INSERT INTO \`${table}\` VALUES (5), (6)`);
      await scheduler.runNow('mreal1');
      expect(hits).toEqual([[4, 6]]);
      expect(points.map((p) => p.value)).toEqual([3, 4, 6]);

      // The monitor session is read-only at the database level.
      const monitorSession = opened[0]!;
      await expect(monitorSession.query(`INSERT INTO \`${table}\` VALUES (99)`)).rejects.toThrow(/read.only|READ ONLY/i);

      scheduler.dispose();
      executor.dispose();
      const final = await admin.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      expect(Number((final.rows[0] as { n: unknown }).n)).toBe(6);
    } finally {
      await admin.query(`DROP TABLE IF EXISTS \`${table}\``).catch(() => undefined);
      admin.end();
      for (const q of opened) { try { q.end(); } catch { /* already closed */ } }
    }
  }, 60_000);
});

/** 共用：内存 store + 调度器 + 执行器（真实会话），返回命中记录与历史点。 */
function harness(dbType: 'MYSQL' | 'SQLITE', openQuery: () => Promise<QueryService>) {
  const opened: QueryService[] = [];
  const executor = new MonitorExecutor({
    dbTypeOf: () => dbType,
    timeoutMs: () => 30_000,
    openSession: async () => {
      const q = await openQuery();
      opened.push(q);
      return { session: { query: q }, close: () => q.end() };
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
  const conn = { id: 'c1', name: 'verify', host: 'h', port: 0, user: 'u', dbType, database: 'main' } as never;
  const service = new MonitorService({
    scheduler,
    executor,
    getConnection: () => conn,
    fingerprint: () => 'fp',
    allowProduction: () => false,
    maxTasks: () => 20,
    enabled: () => true,
    describe: async (_c, database, _s, table) => {
      const q = await openQuery();
      try {
        const meta = new MetadataService(q);
        return { columns: await meta.getColumns(table, database), indexes: await meta.getIndexes(table, database).catch(() => []) };
      } finally {
        q.end();
      }
    },
    audit: () => undefined,
  });
  const close = () => {
    scheduler.dispose();
    executor.dispose();
    for (const q of opened) { try { q.end(); } catch { /* already closed */ } }
  };
  return { service, scheduler, hits, points, conn, close };
}

describe.skipIf(!MYSQL_URL)('metric and new-rows monitoring on real MySQL', () => {
  it('proposes, confirms and runs a freshness metric and a new-rows task', async () => {
    const config = { ...parseMysqlUrl(MYSQL_URL!), database: mysqlDb() };
    const table = `z_monitor_b_${Date.now()}`;
    const admin = await open(DatabaseType.MYSQL, config);
    const h = harness('MYSQL', () => open(DatabaseType.MYSQL, config));
    try {
      await admin.query(`CREATE TABLE \`${table}\` (id BIGINT PRIMARY KEY, received_time BIGINT NOT NULL, kind VARCHAR(10), KEY idx_rt (received_time))`);
      await admin.query(`INSERT INTO \`${table}\` VALUES (1, 1000, 'a'), (2, 2000, 'a'), (3, 2000, 'b')`);

      // A2: the user's freshness query shape, watched on lag.
      const metric = await h.service.propose(h.conn, config.database, undefined, {
        kind: 'metric', table,
        sql: `SELECT COUNT(*) AS total_rows, MAX(received_time) AS latest, MAX(id) AS max_id FROM \`${table}\``,
        watchColumn: 'total_rows', condition: { type: 'increaseBy', value: 1 },
      });
      expect(metric.ok).toBe(true);
      if (!metric.ok) return;
      expect(metric.proposal.preview).toEqual({ total_rows: 3, latest: 2000, max_id: 3 });
      expect(h.scheduler.list()).toHaveLength(0); // proposing never creates a task

      // A write disguised as a metric is rejected before execution.
      expect(await h.service.propose(h.conn, config.database, undefined, { kind: 'metric', table, sql: `DELETE FROM \`${table}\`` }))
        .toMatchObject({ ok: false, reason: 'validation' });

      // B: an invented column is refused; the real one passes.
      expect(await h.service.propose(h.conn, config.database, undefined, { kind: 'newRows', table, cursorColumn: 'create_time' }))
        .toMatchObject({ ok: false, issues: [{ code: 'columnMissing' }] });
      const rows = await h.service.propose(h.conn, config.database, undefined, { kind: 'newRows', table, cursorColumn: 'received_time', condition: { type: 'increaseBy', value: 2 } });
      expect(rows.ok).toBe(true);
      if (!rows.ok) return;
      expect(rows.proposal.warnings).toEqual([]);

      const m = await h.service.confirm(metric.proposal.id);
      const r = await h.service.confirm(rows.proposal.id);
      expect(m.ok && r.ok).toBe(true);
      if (!m.ok || !r.ok) return;
      expect(r.task).toMatchObject({ cursorValue: '2000' });
      expect(r.task.cursorSeen?.length).toBe(2); // ids 2 and 3 share received_time 2000

      // Same cursor value as the baseline plus later rows: only the unseen ones count.
      await admin.query(`INSERT INTO \`${table}\` VALUES (4, 2000, 'c'), (5, 3000, 'c')`);
      await h.scheduler.runNow(r.task.id);
      await h.scheduler.runNow(m.task.id);
      expect(h.scheduler.get(r.task.id)).toMatchObject({ lastValue: 2, cursorValue: '3000' });
      expect(h.scheduler.latestRows(r.task.id)?.rows.map((x) => Number(x.id))).toEqual([4, 5]);
      expect(h.scheduler.get(m.task.id)?.lastValues).toEqual({ total_rows: 5, latest: 3000, max_id: 5 });

      await h.scheduler.runNow(r.task.id);
      expect(h.scheduler.get(r.task.id)?.lastValue).toBe(0);
      expect(h.hits).toEqual([[0, 2], [3, 5]]);
    } finally {
      h.close();
      await admin.query(`DROP TABLE IF EXISTS \`${table}\``).catch(() => undefined);
      admin.end();
    }
  }, 90_000);
});

function hasSqlite(): boolean {
  try { return spawnSync('sqlite3', ['-version']).status === 0; } catch { return false; }
}
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!hasSqlite())('monitoring on real SQLite', () => {
  it('counts rows, reads an integer cursor and refuses TEXT cursors', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-real-'));
    dirs.push(dir);
    const file = path.join(dir, 't.db');
    const exec = (sql: string) => expect(spawnSync('sqlite3', [file, sql]).status).toBe(0);
    exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, created TEXT); INSERT INTO events (created) VALUES ('a'), ('b');`);
    const openQuery = async () => {
      const { connection, dialect } = ConnectionFactory.createWithDialect(DatabaseType.SQLITE, {
        host: '', port: 0, user: '', dbPath: file, sqliteCommand: 'sqlite3',
      } as never);
      await new Promise<void>((resolve, reject) => connection.connect((err) => (err ? reject(err) : resolve())));
      return new QueryService(connection, dialect);
    };
    const h = harness('SQLITE', openQuery);
    try {
      expect(await h.service.propose(h.conn, undefined, undefined, { kind: 'newRows', table: 'events', cursorColumn: 'created' }))
        .toMatchObject({ ok: false, issues: [{ code: 'cursorType' }] });
      const count = await h.service.propose(h.conn, undefined, undefined, { kind: 'rowCount', table: 'events' });
      const rows = await h.service.propose(h.conn, undefined, undefined, { kind: 'newRows', table: 'events', cursorColumn: 'id' });
      expect(count.ok && rows.ok).toBe(true);
      if (!count.ok || !rows.ok) return;
      const c = await h.service.confirm(count.proposal.id);
      const r = await h.service.confirm(rows.proposal.id);
      if (!c.ok || !r.ok) throw new Error('confirm failed');
      expect(h.scheduler.get(c.task.id)?.lastValue).toBe(2);
      exec(`INSERT INTO events (created) VALUES ('c');`);
      await h.scheduler.runNow(c.task.id);
      await h.scheduler.runNow(r.task.id);
      expect(h.scheduler.get(c.task.id)?.lastValue).toBe(3);
      expect(h.scheduler.get(r.task.id)).toMatchObject({ lastValue: 1, cursorValue: '3' });
      // The monitor session refuses writes (PRAGMA query_only).
      const [first] = await Promise.all([openQuery()]);
      try {
        await first.query('PRAGMA query_only = ON');
        await expect(first.query(`INSERT INTO events (created) VALUES ('x')`)).rejects.toThrow(/readonly|read-only|attempt to write/i);
      } finally {
        first.end();
      }
    } finally {
      h.close();
    }
  }, 60_000);
});
