import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection } from '../../../src/connection/sqliteConnection';
import { SqliteQueryShapeError, toSingleLine } from '../../../src/connection/sqlite/index';
import { QueryService } from '../../../src/query/queryService';
import { SqliteDialect } from '../../../src/dialect/sqliteDialect';

const HAS_SQLITE = (() => {
  try { return spawnSync('sqlite3', ['-version']).status === 0; } catch { return false; }
})();

describe('toSingleLine', () => {
  it('keeps single-line SQL unchanged', () => {
    expect(toSingleLine("SELECT 'a', \"b\" FROM t WHERE x = 1;")).toBe("SELECT 'a', \"b\" FROM t WHERE x = 1;");
  });

  it('flattens code newlines and drops comments', () => {
    expect(toSingleLine('SELECT 1\n  FROM t -- note\nWHERE a /* x\ny */ = 2')).toBe('SELECT 1   FROM t   WHERE a   = 2');
  });

  it('rewrites newlines inside string literals with char()', () => {
    expect(toSingleLine("SELECT 'a\nb'")).toBe("SELECT ('a' || char(10) || 'b')");
    expect(toSingleLine("SELECT 'a\r\nb\rc'")).toBe("SELECT ('a' || char(13, 10) || 'b' || char(13) || 'c')");
    expect(toSingleLine("SELECT 'it''s\nok'")).toBe("SELECT ('it''s' || char(10) || 'ok')");
    expect(toSingleLine("SELECT 'a''\n''b'")).toBe("SELECT ('a''' || char(10) || '''b')");
    expect(toSingleLine("SELECT 'it''s'")).toBe("SELECT 'it''s'");
  });

  it('rejects line breaks inside quoted identifiers', () => {
    expect(() => toSingleLine('SELECT "a\nb" FROM t')).toThrow(SqliteQueryShapeError);
  });

  it('never returns text with a line break or a leading dot, whatever the input', () => {
    const samples = [
      'select 1;\n.shell echo x',
      'select 1;\n#\'\n.shell echo x\n#\'\nselect 2;',
      "select 'x'\nGO\n.shell echo x\nselect 3;",
      "select 1 as [x'];\n.shell echo x",
      'select 1;\r.shell echo x',
      '  .shell echo x',
      '.open /tmp/other.db',
      "select 'a\n.shell echo x\nb';",
    ];
    for (const sql of samples) {
      let out: string | undefined;
      try { out = toSingleLine(sql); } catch (err) { expect(err).toBeInstanceOf(SqliteQueryShapeError); continue; }
      expect(out, sql).not.toMatch(/[\r\n]/);
      expect(out, sql).not.toMatch(/^\s*\./);
    }
  });
});

describe.skipIf(!HAS_SQLITE)('SQLite driver: dot-commands never reach the CLI', () => {
  const conns: SqliteConnection[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const c of conns.splice(0)) { try { c.end(); } catch { /* gone */ } }
    for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  });

  function open(readOnly = false, seed?: (file: string) => void): { q: QueryService; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-ro-'));
    dirs.push(dir);
    const file = path.join(dir, 't.db');
    if (seed) seed(file);
    const conn = new SqliteConnection({ dbPath: file, readOnly } as any, 'sqlite3');
    conns.push(conn);
    return { q: new QueryService(conn, new SqliteDialect()), dir };
  }

  const marker = (dir: string) => path.join(dir, 'PWNED');

  it('does not execute .shell hidden behind CLI-specific line rules', async () => {
    const { q, dir } = open();
    const m = marker(dir);
    const attacks = [
      `select 1;\n.shell touch ${m}`,
      `select 1;\n#'\n.shell touch ${m}\n#'\nselect 2;`,
      `select 'x'\nGO\n.shell touch ${m}\nselect 3;`,
      `select 1 as [x'];\n.shell touch ${m}`,
      `select 1;\r.shell touch ${m}`,
      `.shell touch ${m}`,
      `  .system touch ${m}`,
    ];
    for (const sql of attacks) {
      await q.query(sql).catch(() => { /* syntax errors are expected */ });
      expect(fs.existsSync(m), sql).toBe(false);
    }
    // The connection still works afterwards.
    const r = await q.query('SELECT 42 AS v');
    expect(r.rows).toEqual([{ v: '42' }]);
  });

  it('runs ordinary multi-line SQL and preserves newlines inside strings', async () => {
    const { q } = open();
    await q.query('CREATE TABLE t (\n  id INTEGER PRIMARY KEY, -- key\n  note TEXT\n)');
    await q.query("INSERT INTO t (id, note)\nVALUES (1, 'line1\nline2'), (2, 'it''s\nok')");
    // Check the stored value, not the CLI's TCL rendering (which shows a newline as `\n`).
    const r = await q.query('SELECT id, length(note) AS len, instr(note, char(10)) AS nl\nFROM t\nORDER BY id');
    expect(r.rows).toEqual([{ id: '1', len: '11', nl: '6' }, { id: '2', len: '7', nl: '5' }]);
    const exact = await q.query("SELECT count(*) AS n FROM t WHERE note = 'it''s' || char(10) || 'ok'");
    expect(exact.rows).toEqual([{ n: '1' }]);
  });

  it('keeps affectedRows for DML ending with a line comment', async () => {
    const { q } = open();
    await q.query('CREATE TABLE t (a INTEGER)');
    const r = await q.query('INSERT INTO t VALUES (1), (2) -- two rows');
    expect(r.affectedRows).toBe(2);
  });
});

describe.skipIf(!HAS_SQLITE)('SQLite driver: readOnly is enforced by the database', () => {
  const conns: SqliteConnection[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const c of conns.splice(0)) { try { c.end(); } catch { /* gone */ } }
    for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  });

  function seeded(readOnly: boolean): { q: QueryService; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-ro-'));
    dirs.push(dir);
    const file = path.join(dir, 't.db');
    const init = spawnSync('sqlite3', [file, 'CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);']);
    expect(init.status).toBe(0);
    const conn = new SqliteConnection({ dbPath: file, readOnly } as any, 'sqlite3');
    conns.push(conn);
    return { q: new QueryService(conn, new SqliteDialect()), dir };
  }

  it('reads but refuses writes, DDL and ATTACH on a read-only connection', async () => {
    const { q, dir } = seeded(true);
    expect((await q.query('SELECT a FROM t')).rows).toEqual([{ a: '1' }]);
    await expect(q.query('INSERT INTO t VALUES (2)')).rejects.toThrow(/readonly|read-only|query_only/i);
    await expect(q.query('UPDATE t SET a = 3')).rejects.toThrow(/readonly|read-only|query_only/i);
    await expect(q.query('CREATE TABLE u (b INTEGER)')).rejects.toThrow(/readonly|read-only|query_only/i);
    await expect(q.query(`ATTACH '${path.join(dir, 'x.db')}' AS x`)).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'x.db'))).toBe(false);
    // Data is untouched.
    expect((await q.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: '1' }]);
  });

  it('cannot be switched back to writable from SQL', async () => {
    const { q } = seeded(true);
    await q.query('PRAGMA query_only=OFF').catch(() => { /* may or may not error */ });
    await expect(q.query('INSERT INTO t VALUES (9)')).rejects.toThrow(/readonly|read-only/i);
  });

  it('stays writable when readOnly is off', async () => {
    const { q } = seeded(false);
    await q.query('INSERT INTO t VALUES (2)');
    expect((await q.query('SELECT count(*) AS n FROM t')).rows).toEqual([{ n: '2' }]);
  });
});
