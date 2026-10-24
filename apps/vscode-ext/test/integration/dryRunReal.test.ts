import { describe, expect, it } from 'vitest';
import { ConnectionFactory, DatabaseType, QueryService } from '@devbelt/db-core';
import type { ConnectionConfig } from '@devbelt/db-core';
import { dryRunStatement, targetTable } from '../../src/agent/dryRun';

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
const PG_URL = process.env.DEVBELT_DB_TEST_PG_URL;
const STAMP = Date.now();

describe.skipIf(!MYSQL_URL)('dry run on real MySQL', () => {
  const table = `z_dry_${STAMP}`;
  let q: QueryService;

  it('rolls back and leaves the data unchanged', async () => {
    q = await open(DatabaseType.MYSQL, { ...parseMysqlUrl(MYSQL_URL!), database: mysqlDb() });
    try {
      await q.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, v INT)`);
      await q.query(`INSERT INTO \`${table}\` VALUES (1, 10), (2, 20)`);
      const result = await dryRunStatement(`UPDATE \`${table}\` SET v = 99`, { dbType: DatabaseType.MYSQL, session: q });
      expect(result).toMatchObject({ outcome: 'rolled_back', affectedRows: 2 });
      const rows = await q.query(`SELECT id, v FROM \`${table}\` ORDER BY id`);
      expect(rows.rows).toEqual([{ id: '1', v: '10' }, { id: '2', v: '20' }]);
    } finally {
      await q.query(`DROP TABLE IF EXISTS \`${table}\``).catch(() => undefined);
      q.end();
    }
  }, 60_000);
});

describe.skipIf(!PG_URL)('dry run on real PostgreSQL', () => {
  const schema = `ztest_dry_${STAMP}`;
  let q: QueryService;

  it('rolls back and leaves the data unchanged', async () => {
    q = await open(DatabaseType.PG, { host: '', port: 0, user: '', useConnectionString: true, connectionUrl: PG_URL!, schema });
    try {
      await q.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await q.query(`CREATE TABLE ${schema}.t (id int PRIMARY KEY, v int)`);
      await q.query(`INSERT INTO ${schema}.t VALUES (1, 10), (2, 20)`);
      const result = await dryRunStatement('UPDATE t SET v = 99', { dbType: DatabaseType.PG, session: q, schema });
      expect(result).toMatchObject({ outcome: 'rolled_back', affectedRows: 2 });
      const rows = await q.query('SELECT id, v FROM t ORDER BY id');
      expect(rows.rows).toEqual([{ id: '1', v: '10' }, { id: '2', v: '20' }]);
    } finally {
      await q.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      q.end();
    }
  }, 60_000);
});

describe('dry run routing', () => {
  it('only dry-runs single-table DML', () => {
    expect(targetTable('UPDATE `orders` SET a = 1')).toBe('orders');
    expect(targetTable('UPDATE a JOIN b ON a.id = b.id SET a.x = 1')).toBeUndefined();
  });
});