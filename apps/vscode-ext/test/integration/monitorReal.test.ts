import { describe, expect, it } from 'vitest';
import { ConnectionFactory, DatabaseType, QueryService } from '@devbelt/db-core';
import type { ConnectionConfig } from '@devbelt/db-core';
import { MonitorExecutor } from '../../src/monitor/monitorExecutor';
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
