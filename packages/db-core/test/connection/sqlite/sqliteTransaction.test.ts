import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { SQLite } from '../../../src/connection/sqlite/index';

/**
 * Real CLI integration: the SQLite driver spawns one sqlite3 process per query().
 * These tests assert that a single query() carrying BEGIN/COMMIT/ROLLBACK keeps
 * the whole transaction inside one process, so the atomicity guarantee holds.
 */
describe('SQLite single-process transaction (real sqlite3 CLI)', () => {
  const dbPath = path.join(os.tmpdir(), `db-transfer-${Date.now()}.db`);

  it('commits a batch of statements sent in one query', async () => {
    const sqlite = new SQLite(dbPath, 'sqlite3');
    await sqlite.query('CREATE TABLE t(id INTEGER, name TEXT);');
    await sqlite.query("BEGIN; INSERT INTO t VALUES(1,'a'); INSERT INTO t VALUES(2,'b'); COMMIT;");
    const result = await sqlite.query('SELECT COUNT(*) AS c FROM t;');
    expect(Number((result as any).rows[0].c)).toBe(2);
  });

  it('rolls back statements sent in one query when the transaction is rolled back', async () => {
    const sqlite = new SQLite(dbPath, 'sqlite3');
    await sqlite.query("BEGIN; INSERT INTO t VALUES(3,'c'); INSERT INTO t VALUES(4,'d'); ROLLBACK;");
    const result = await sqlite.query('SELECT COUNT(*) AS c FROM t;');
    expect(Number((result as any).rows[0].c)).toBe(2);
  });
});