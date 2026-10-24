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