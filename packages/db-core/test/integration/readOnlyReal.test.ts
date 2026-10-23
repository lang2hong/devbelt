import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, type Connection } from 'mysql2/promise';
import { Client } from 'pg';
import { ConnectionFactory } from '../../src/factory/connectionFactory';
import { QueryService } from '../../src/query/queryService';
import { DatabaseType, type ConnectionConfig } from '../../src/types/connection';
import { parseMysqlUrl, resolveTestDb } from './testDb.js';

/**
 * Read-only connections are enforced by the database, not only by client-side
 * SQL classification. Goes through ConnectionFactory + QueryService, the same
 * path the extension uses.
 */
async function open(dbType: DatabaseType, config: ConnectionConfig): Promise<QueryService> {
  const { connection, dialect } = ConnectionFactory.createWithDialect(dbType, config);
  await new Promise<void>((resolve, reject) => connection.connect((err) => (err ? reject(err) : resolve())));
  return new QueryService(connection, dialect);
}

const MYSQL_URL = process.env.DEVBELT_DB_TEST_MYSQL_URL;
const MYSQL_DB = MYSQL_URL ? resolveTestDb() : 'skipped';
const STAMP = Date.now();

describe.skipIf(!MYSQL_URL)('MySQL read-only connection (real db)', () => {
  const table = `z_ro_${STAMP}`;
  let admin: Connection;
  const sessions: QueryService[] = [];
  const base = (): ConnectionConfig => ({ ...parseMysqlUrl(MYSQL_URL!), database: MYSQL_DB, connectTimeout: 10_000 });

  beforeAll(async () => {
    admin = await createConnection({ ...parseMysqlUrl(MYSQL_URL!), database: MYSQL_DB });
    await admin.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, v INT)`);
    await admin.query(`INSERT INTO \`${table}\` VALUES (1, 10)`);
  });

  afterAll(async () => {
    for (const s of sessions) s.end();
    if (admin) {
      await admin.query(`DROP TABLE IF EXISTS \`${table}\``).catch(() => {});
      await admin.end();
    }
  });

  it('reads but rejects INSERT, UPDATE and DELETE', async () => {
    const q = await open(DatabaseType.MYSQL, { ...base(), readOnly: true });
    sessions.push(q);
    expect((await q.query(`SELECT v FROM \`${table}\` WHERE id = 1`)).rows).toEqual([{ v: '10' }]);
    for (const sql of [
      `INSERT INTO \`${table}\` VALUES (2, 20)`,
      `UPDATE \`${table}\` SET v = 11 WHERE id = 1`,
      `DELETE FROM \`${table}\` WHERE id = 1`,
    ]) {
      await expect(q.query(sql), sql).rejects.toThrow(/read[ -]only/i);
    }
    const [rows] = await admin.query(`SELECT COUNT(*) AS n, MAX(v) AS v FROM \`${table}\``) as unknown as [Array<{ n: number; v: number }>];
    expect(rows[0]).toMatchObject({ n: 1, v: 10 });
  });

  it('keeps writes working when readOnly is off', async () => {
    const q = await open(DatabaseType.MYSQL, base());
    sessions.push(q);
    await q.query(`UPDATE \`${table}\` SET v = 12 WHERE id = 1`);
    expect((await q.query(`SELECT v FROM \`${table}\` WHERE id = 1`)).rows).toEqual([{ v: '12' }]);
  });
});

const PG_URL = process.env.DEVBELT_DB_TEST_PG_URL;

describe.skipIf(!PG_URL)('PostgreSQL read-only connection (real db)', () => {
  const schema = `ztest_ro_${STAMP}`;
  let admin: Client;
  const sessions: QueryService[] = [];
  const base = (): ConnectionConfig => ({ host: '', port: 0, user: '', useConnectionString: true, connectionUrl: PG_URL!, schema });

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL! });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.t (id int PRIMARY KEY, v int)`);
    await admin.query(`INSERT INTO ${schema}.t VALUES (1, 10)`);
    await admin.query(`CREATE SEQUENCE ${schema}.s`);
  });

  afterAll(async () => {
    for (const s of sessions) s.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await admin.end();
    }
  });

  it('reads but rejects writes, DDL and nextval', async () => {
    const q = await open(DatabaseType.PG, { ...base(), readOnly: true });
    sessions.push(q);
    // search_path still applies alongside the read-only setting.
    expect((await q.query('SELECT v FROM t WHERE id = 1')).rows).toEqual([{ v: 10 }]);
    for (const sql of [
      'INSERT INTO t VALUES (2, 20)',
      'UPDATE t SET v = 11 WHERE id = 1',
      'DELETE FROM t WHERE id = 1',
      'CREATE TABLE u (a int)',
      "SELECT nextval('s')",
    ]) {
      await expect(q.query(sql), sql).rejects.toThrow(/read-only transaction/i);
    }
    const r = await admin.query(`SELECT count(*)::int AS n, max(v) AS v FROM ${schema}.t`);
    expect(r.rows[0]).toEqual({ n: 1, v: 10 });
  });

  it('keeps writes working when readOnly is off', async () => {
    const q = await open(DatabaseType.PG, base());
    sessions.push(q);
    await q.query('UPDATE t SET v = 12 WHERE id = 1');
    expect((await q.query('SELECT v FROM t WHERE id = 1')).rows).toEqual([{ v: 12 }]);
  });
});
