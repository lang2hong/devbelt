import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createConnection, type Connection } from 'mysql2/promise';
import { Client } from 'pg';
import { ConnectionFactory, DatabaseType, QueryService } from '@devbelt/db-core';
import type { ConnectionConfig } from '@devbelt/db-core';
import { runReadOnlyQuery } from '../../src/index.js';
import type { AgentEngine } from '../../src/index.js';

/**
 * Real-database checks for the R1 runtime. The point is the database boundary:
 * statements the static check lets through must still be unable to write,
 * because every call runs in a read-only transaction or on a read-only
 * SQLite session — even when the connection itself is writable.
 *
 * Writes are attempted with `mutate` to bypass `checkReadOnlySql`; this
 * simulates a statement the denylist missed.
 */
async function open(dbType: DatabaseType, config: ConnectionConfig): Promise<QueryService> {
  const { connection, dialect } = ConnectionFactory.createWithDialect(dbType, config);
  await new Promise<void>((resolve, reject) => connection.connect((err) => (err ? reject(err) : resolve())));
  return new QueryService(connection, dialect);
}

/** Run SQL inside the runtime's read-only scope but skip the static check. */
async function mutate(engine: AgentEngine, q: QueryService, sql: string): Promise<void> {
  const control = (s: string) => q.query(s, undefined, { skipHistory: true });
  if (engine === 'PG') await control('BEGIN READ ONLY');
  else await control('START TRANSACTION READ ONLY');
  try {
    await control(sql);
  } finally {
    await control('ROLLBACK').catch(() => undefined);
  }
}

const STAMP = Date.now();

function parseMysqlUrl(url: string) {
  const m = /^mysql:\/\/([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error('bad DEVBELT_DB_TEST_MYSQL_URL');
  return { host: m[3]!, port: m[4] ? Number(m[4]) : 3306, user: decodeURIComponent(m[1]!), password: decodeURIComponent(m[2]!) };
}

/** Same guard as db-core's testDb.ts: never touch the production database. */
function testMysqlDb(): string {
  const name = (process.env.DEVBELT_DB_TEST_MYSQL_DB || 'devbelt_db_verify').trim();
  const prod = (process.env.DEVBELT_DB_MYSQL_DATABASE || '').trim();
  if (!name || (prod && name.toLowerCase() === prod.toLowerCase()) || !/verify|test/i.test(name)) {
    throw new Error(`refusing to use ${JSON.stringify(name)} as the integration test database`);
  }
  return name;
}

const MYSQL_URL = process.env.DEVBELT_DB_TEST_MYSQL_URL;

describe.skipIf(!MYSQL_URL)('R1 runtime on real MySQL', () => {
  const db = MYSQL_URL ? testMysqlDb() : '';
  const table = `z_ro_rt_${STAMP}`;
  let admin: Connection;
  let q: QueryService;

  beforeAll(async () => {
    admin = await createConnection({ ...parseMysqlUrl(MYSQL_URL!), database: db });
    await admin.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, secret VARCHAR(20), password VARCHAR(20))`);
    await admin.query(`INSERT INTO \`${table}\` VALUES (1, 'a', 'p1'), (2, 'b', 'p2'), (3, 'c', 'p3')`);
    // A writable connection: the runtime must not rely on the connection's read-only flag.
    q = await open(DatabaseType.MYSQL, { ...parseMysqlUrl(MYSQL_URL!), database: db, connectTimeout: 10_000 });
  });

  afterAll(async () => {
    q?.end();
    if (admin) {
      await admin.query(`DROP TABLE IF EXISTS \`${table}\``).catch(() => {});
      await admin.end();
    }
  });

  it('reads with row limit and sanitised output', async () => {
    const r = await runReadOnlyQuery({ engine: 'MYSQL', session: q, sessionReadOnly: false }, `SELECT id, password FROM \`${table}\` ORDER BY id`, { maxRows: 2 });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.truncated).toBe(true);
    expect(r.envelope.data.rowCount).toBe(2);
    expect(JSON.stringify(r.envelope)).not.toContain('p1');
  });

  it('cannot write even when the static check is bypassed', async () => {
    await expect(mutate('MYSQL', q, `UPDATE \`${table}\` SET secret = 'x' WHERE id = 1`)).rejects.toThrow(/read[ -]only/i);
    await expect(mutate('MYSQL', q, `INSERT INTO \`${table}\` VALUES (9, 'z', 'z')`)).rejects.toThrow(/read[ -]only/i);
    const [rows] = await admin.query(`SELECT COUNT(*) AS n, MAX(secret) AS s FROM \`${table}\``) as unknown as [Array<{ n: number; s: string }>];
    expect(rows[0]).toMatchObject({ n: 3, s: 'c' });
  });

  it('leaves the session usable and outside any transaction after a failure', async () => {
    const bad = await runReadOnlyQuery({ engine: 'MYSQL', session: q, sessionReadOnly: false }, 'SELECT * FROM no_such_table_x');
    expect(bad.ok).toBe(false);
    // Writable connection, so a plain write now succeeds: the read-only scope was closed.
    await q.query(`UPDATE \`${table}\` SET secret = 'b2' WHERE id = 2`);
    const [rows] = await admin.query(`SELECT secret FROM \`${table}\` WHERE id = 2`) as unknown as [Array<{ secret: string }>];
    expect(rows[0]!.secret).toBe('b2');
  });
});

const PG_URL = process.env.DEVBELT_DB_TEST_PG_URL;

describe.skipIf(!PG_URL)('R1 runtime on real PostgreSQL', () => {
  const schema = `ztest_ro_rt_${STAMP}`;
  let admin: Client;
  let q: QueryService;

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL! });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.t (id int PRIMARY KEY, v int)`);
    await admin.query(`INSERT INTO ${schema}.t SELECT g, g * 10 FROM generate_series(1, 5) g`);
    await admin.query(`CREATE SEQUENCE ${schema}.s`);
    q = await open(DatabaseType.PG, { host: '', port: 0, user: '', useConnectionString: true, connectionUrl: PG_URL!, schema });
  });

  afterAll(async () => {
    q?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await admin.end();
    }
  });

  it('reads with row limit', async () => {
    const r = await runReadOnlyQuery({ engine: 'PG', session: q, sessionReadOnly: false }, 'SELECT id FROM t ORDER BY id', { maxRows: 3 });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.envelope.data.rowCount).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it('cannot write, use sequences or run DDL even when the static check is bypassed', async () => {
    for (const sql of ['UPDATE t SET v = 0', 'INSERT INTO t VALUES (99, 0)', "SELECT nextval('s')", 'CREATE TABLE u (a int)']) {
      await expect(mutate('PG', q, sql), sql).rejects.toThrow(/read-only transaction/i);
    }
    const r = await admin.query(`SELECT count(*)::int AS n, sum(v)::int AS s FROM ${schema}.t`);
    expect(r.rows[0]).toEqual({ n: 5, s: 150 });
  });

  it('enforces the statement timeout server-side', async () => {
    // pg_sleep is on the denylist, so run it through the scope directly with a short timeout.
    const started = Date.now();
    await expect((async () => {
      await q.query('BEGIN READ ONLY', undefined, { skipHistory: true });
      try {
        await q.query('SET LOCAL statement_timeout = 200', undefined, { skipHistory: true });
        await q.query('SELECT pg_sleep(5)', undefined, { skipHistory: true });
      } finally {
        await q.query('ROLLBACK', undefined, { skipHistory: true }).catch(() => undefined);
      }
    })()).rejects.toThrow(/statement timeout|canceling statement/i);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('leaves the session outside any transaction after a failure', async () => {
    const bad = await runReadOnlyQuery({ engine: 'PG', session: q, sessionReadOnly: false }, 'SELECT * FROM no_such_table_x');
    expect(bad.ok).toBe(false);
    await q.query('UPDATE t SET v = 21 WHERE id = 2');
    const r = await admin.query(`SELECT v FROM ${schema}.t WHERE id = 2`);
    expect(r.rows[0]).toEqual({ v: 21 });
  });
});

const HAS_SQLITE = (() => {
  try { return spawnSync('sqlite3', ['-version']).status === 0; } catch { return false; }
})();

describe.skipIf(!HAS_SQLITE)('R1 runtime on real SQLite', () => {
  let dir: string;
  let file: string;
  let q: QueryService;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ro-'));
    file = path.join(dir, 't.db');
    const init = spawnSync('sqlite3', [file, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER); INSERT INTO t VALUES (1, 10), (2, 20);']);
    expect(init.status).toBe(0);
    q = await open(DatabaseType.SQLITE, { host: '', port: 0, user: '', dbPath: file, readOnly: true, sqliteCommand: 'sqlite3' });
  });

  afterAll(() => {
    q?.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads on a read-only session', async () => {
    const r = await runReadOnlyQuery({ engine: 'SQLITE', session: q, sessionReadOnly: true }, 'SELECT id FROM t ORDER BY id');
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.envelope.data.rowCount).toBe(2);
  });

  it('cannot write through the session even when the static check is bypassed', async () => {
    await expect(q.query('UPDATE t SET v = 0')).rejects.toThrow(/readonly|read-only/i);
    const check = spawnSync('sqlite3', [file, 'SELECT sum(v) FROM t;']);
    expect(check.stdout.toString().trim()).toBe('30');
  });
});
