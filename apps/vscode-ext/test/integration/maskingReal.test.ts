import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConnectionFactory, DatabaseType, MetadataService, QueryService } from '@devbelt/db-core';
import { parseMaskingConfig } from '@devbelt/masking-core';
import { collectMaskedSubset } from '../../src/masking/subset';

const HAS_SQLITE = (() => {
  try { return spawnSync('sqlite3', ['-version']).status === 0; } catch { return false; }
})();

const dirs: string[] = [];
const sessions: QueryService[] = [];
afterEach(() => {
  for (const q of sessions.splice(0)) { try { q.end(); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function sqliteDb(): Promise<{ q: QueryService; metadata: MetadataService; file: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'masking-real-'));
  dirs.push(dir);
  const file = path.join(dir, 't.db');
  const seed = spawnSync('sqlite3', [file, `
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), note TEXT);
    INSERT INTO users VALUES (1, 'a@x.test'), (2, 'b@x.test');
    INSERT INTO orders VALUES (10, 1, 'n1'), (11, 2, 'n2');
  `]);
  expect(seed.status).toBe(0);
  const { connection, dialect } = ConnectionFactory.createWithDialect(DatabaseType.SQLITE, {
    host: '', port: 0, user: '', dbPath: file, readOnly: true, sqliteCommand: 'sqlite3',
  } as never);
  await new Promise<void>((resolve, reject) => connection.connect((err) => (err ? reject(err) : resolve())));
  const q = new QueryService(connection, dialect);
  sessions.push(q);
  return { q, metadata: new MetadataService(q), file };
}

function config(tables: Record<string, unknown>) {
  const parsed = parseMaskingConfig({ version: 1, tables });
  if (!parsed.ok) throw new Error(parsed.errors.join(', '));
  return parsed.config;
}

describe.skipIf(!HAS_SQLITE)('masked subset on real SQLite', () => {
  it('pulls the parent row and keeps the FK value aligned after masking', async () => {
    const { q, metadata } = await sqliteDb();
    const result = await collectMaskedSubset({
      query: q,
      dialect: q.dialect,
      metadata,
      config: config({
        orders: { where: 'id = 10', referenced: true, columns: {} },
        users: { columns: { id: 'hash', email: 'email' } },
      }),
      salt: 'integration-salt',
      rootTable: 'orders',
    });
    expect(result.tables.map((t) => t.name)).toEqual(['users', 'orders']);
    const users = result.tables.find((t) => t.name === 'users')!;
    const orders = result.tables.find((t) => t.name === 'orders')!;
    expect(users.rows).toHaveLength(1);
    expect(orders.rows).toHaveLength(1);
    expect(orders.rows[0]!.user_id).toBe(users.rows[0]!.id);
    expect(String(users.rows[0]!.email)).toMatch(/@masked\.invalid$/);
    expect(String(users.rows[0]!.email)).not.toContain('a@x.test');
  });

  it('refuses a large subset when the row budget is exceeded', async () => {
    const { q, metadata, file } = await sqliteDb();
    const bulk = spawnSync('sqlite3', [file, `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 300)
      INSERT INTO orders (id, user_id, note) SELECT 1000+x, 1, 'bulk' FROM n;`]);
    expect(bulk.status).toBe(0);
    const parsed = parseMaskingConfig({
      version: 1,
      maxRowsTotal: 100,
      tables: {
        orders: { where: 'id > 0', referenced: true, columns: {} },
        users: { columns: { id: 'hash', email: 'email' } },
      },
    });
    if (!parsed.ok) throw new Error(parsed.errors.join(','));
    await expect(collectMaskedSubset({
      query: q, dialect: q.dialect, metadata, config: parsed.config, salt: 's', rootTable: 'orders',
    })).rejects.toThrow(/more than 100|budget/i);
  });

  it('refuses when a pulled-in table has PII and no rule', async () => {
    const { q, metadata } = await sqliteDb();
    await expect(collectMaskedSubset({
      query: q,
      dialect: q.dialect,
      metadata,
      config: config({ orders: { where: 'id = 10', referenced: true, columns: {} } }),
      salt: 's',
      rootTable: 'orders',
    })).rejects.toThrow(/PII columns.*users/);
  });
});
function parseMysqlUrl(url: string) {
  const m = /^mysql:\/\/([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error('bad DEVBELT_DB_TEST_MYSQL_URL');
  return { host: m[3]!, port: m[4] ? Number(m[4]) : 3306, user: decodeURIComponent(m[1]!), password: decodeURIComponent(m[2]!) };
}
function mysqlDb(): string {
  const name = (process.env.DEVBELT_DB_TEST_MYSQL_DB || 'devbelt_db_verify').trim();
  const prod = (process.env.DEVBELT_DB_MYSQL_DATABASE || '').trim();
  if (!name || (prod && name.toLowerCase() === prod.toLowerCase()) || !/verify|test/i.test(name)) throw new Error('refusing unsafe test database');
  return name;
}
async function openService(dbType: DatabaseType, config: unknown): Promise<QueryService> {
  const { connection, dialect } = ConnectionFactory.createWithDialect(dbType, config as never);
  await new Promise<void>((resolve, reject) => connection.connect((err) => (err ? reject(err) : resolve())));
  const q = new QueryService(connection, dialect);
  sessions.push(q);
  return q;
}
const MYSQL_URL = process.env.DEVBELT_DB_TEST_MYSQL_URL;
const PG_URL = process.env.DEVBELT_DB_TEST_PG_URL;

describe.skipIf(!MYSQL_URL)('masked subset on real MySQL', () => {
  it('keeps masked FK values aligned', async () => {
    const stamp = Date.now();
    const q = await openService(DatabaseType.MYSQL, { ...parseMysqlUrl(MYSQL_URL!), database: mysqlDb() });
    try {
      await q.query(`CREATE TABLE \`z_mu_users_${stamp}\` (id INT PRIMARY KEY, email VARCHAR(120))`);
      await q.query(`CREATE TABLE \`z_mu_orders_${stamp}\` (id INT PRIMARY KEY, user_id INT, FOREIGN KEY (user_id) REFERENCES \`z_mu_users_${stamp}\`(id))`);
      await q.query(`INSERT INTO \`z_mu_users_${stamp}\` VALUES (1,'a@x.test'),(2,'b@x.test')`);
      await q.query(`INSERT INTO \`z_mu_orders_${stamp}\` VALUES (10,1),(11,2)`);
      const result = await collectMaskedSubset({
        query: q, dialect: q.dialect, metadata: new MetadataService(q),
        config: config({
          [`z_mu_orders_${stamp}`]: { where: 'id = 10', referenced: true, columns: {} },
          [`z_mu_users_${stamp}`]: { columns: { id: 'hash', email: 'email' } },
        }),
        salt: 'mysql-int', rootTable: `z_mu_orders_${stamp}`,
      });
      const users = result.tables.find((t) => t.name.startsWith('z_mu_users'))!;
      const orders = result.tables.find((t) => t.name.startsWith('z_mu_orders'))!;
      expect(orders.rows[0]!.user_id).toBe(users.rows[0]!.id);
      expect(String(users.rows[0]!.email)).toMatch(/@masked\.invalid$/);
    } finally {
      await q.query(`DROP TABLE IF EXISTS \`z_mu_orders_${stamp}\``).catch(() => undefined);
      await q.query(`DROP TABLE IF EXISTS \`z_mu_users_${stamp}\``).catch(() => undefined);
    }
  }, 60_000);
});

describe.skipIf(!PG_URL)('masked subset on real PostgreSQL', () => {
  it('keeps masked FK values aligned', async () => {
    const schema = `ztest_mask_${Date.now()}`;
    const q = await openService(DatabaseType.PG, { host: '', port: 0, user: '', useConnectionString: true, connectionUrl: PG_URL!, schema });
    try {
      await q.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await q.query(`CREATE TABLE ${schema}.users (id int PRIMARY KEY, email varchar(120))`);
      await q.query(`CREATE TABLE ${schema}.orders (id int PRIMARY KEY, user_id int REFERENCES ${schema}.users(id))`);
      await q.query(`INSERT INTO ${schema}.users VALUES (1,'a@x.test'),(2,'b@x.test')`);
      await q.query(`INSERT INTO ${schema}.orders VALUES (10,1),(11,2)`);
      const result = await collectMaskedSubset({
        query: q, dialect: q.dialect, metadata: new MetadataService(q),
        config: config({ orders: { where: 'id = 10', referenced: true, columns: {} }, users: { columns: { id: 'hash', email: 'email' } } }),
        salt: 'pg-int', rootTable: 'orders',
      });
      const users = result.tables.find((t) => t.name === 'users')!;
      const orders = result.tables.find((t) => t.name === 'orders')!;
      expect(Number(orders.rows[0]!.user_id)).toBe(Number(users.rows[0]!.id));
    } finally {
      await q.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    }
  }, 60_000);
});
