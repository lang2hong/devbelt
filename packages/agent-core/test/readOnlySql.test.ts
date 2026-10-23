import { describe, expect, it } from 'vitest';
import { checkReadOnlySql } from '../src/index.js';
import type { AgentEngine } from '../src/index.js';

const ENGINES: AgentEngine[] = ['MYSQL', 'PG', 'SQLITE'];

function rejected(sql: string, engine: AgentEngine = 'PG') {
  const r = checkReadOnlySql(sql, engine);
  if (r.ok) throw new Error(`expected rejection for: ${sql}`);
  return r;
}

describe('checkReadOnlySql — allowed', () => {
  it('accepts plain reads on every engine', () => {
    const reads = [
      'SELECT 1',
      'SELECT id, name FROM users WHERE id = 1;',
      'select count(*) from orders o join users u on u.id = o.user_id',
      'WITH recent AS (SELECT * FROM orders WHERE created_at > now()) SELECT count(*) FROM recent',
      'VALUES (1), (2)',
      'EXPLAIN SELECT * FROM orders WHERE status = 1',
      '/* leading comment */ SELECT 1 -- trailing',
    ];
    for (const engine of ENGINES) {
      for (const sql of reads) {
        const r = checkReadOnlySql(sql, engine);
        expect(r.ok, `${engine}: ${sql}`).toBe(true);
      }
    }
  });

  it('does not reject forbidden words inside strings, comments or quoted identifiers', () => {
    for (const sql of [
      "SELECT 'DELETE FROM t; UPDATE x' AS note",
      'SELECT 1 /* INSERT INTO t */',
      'SELECT "update", "lock" FROM t',
      "SELECT * FROM t WHERE note = 'pg_sleep(10)'",
    ]) {
      expect(checkReadOnlySql(sql, 'PG').ok, sql).toBe(true);
    }
    expect(checkReadOnlySql('SELECT `update` FROM t', 'MYSQL').ok).toBe(true);
  });

  it('returns the single statement and its kind', () => {
    expect(checkReadOnlySql('SELECT 1;', 'PG')).toEqual({ ok: true, statement: 'SELECT 1', kind: 'select' });
    expect(checkReadOnlySql('EXPLAIN SELECT 1', 'MYSQL')).toMatchObject({ ok: true, kind: 'explain' });
  });
});

describe('checkReadOnlySql — rejected', () => {
  it('rejects empty and multi-statement input', () => {
    expect(rejected('').reason).toBe('empty');
    expect(rejected(' ; -- only a comment').reason).toBe('empty');
    expect(rejected('SELECT 1; SELECT 2').reason).toBe('multiple_statements');
    expect(rejected('SELECT 1; DELETE FROM t').reason).toBe('multiple_statements');
  });

  it('rejects statements that are not reads', () => {
    for (const sql of ['UPDATE t SET a = 1', 'DELETE FROM t', 'SHOW TABLES', 'TABLE t', 'DESCRIBE t', 'CALL p()']) {
      expect(rejected(sql).reason, sql).toBe('not_a_read');
    }
  });

  it('rejects EXPLAIN ANALYZE in every spelling', () => {
    for (const sql of ['EXPLAIN ANALYZE SELECT 1', 'explain analyse select 1', 'EXPLAIN (ANALYZE, BUFFERS) SELECT 1', 'EXPLAIN (FORMAT JSON) SELECT 1']) {
      expect(rejected(sql).reason, sql).toBe('explain_analyze');
    }
  });

  it('rejects data-modifying CTEs and writes hidden in a read', () => {
    expect(rejected('WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x')).toMatchObject({ reason: 'forbidden_keyword', detail: 'UPDATE' });
    expect(rejected('WITH d AS (DELETE FROM t RETURNING id) SELECT count(*) FROM d')).toMatchObject({ detail: 'DELETE' });
    expect(rejected('WITH i AS (INSERT INTO t VALUES (1) RETURNING id) SELECT 1')).toMatchObject({ reason: 'forbidden_keyword' });
  });

  it('rejects result redirection', () => {
    expect(rejected('SELECT * INTO new_table FROM t')).toMatchObject({ detail: 'INTO' });
    expect(rejected("SELECT * FROM t INTO OUTFILE '/tmp/x'", 'MYSQL')).toMatchObject({ reason: 'forbidden_keyword' });
    expect(rejected("SELECT 1 INTO DUMPFILE '/tmp/x'", 'MYSQL')).toMatchObject({ reason: 'forbidden_keyword' });
    expect(rejected('SELECT 1 INTO @v', 'MYSQL')).toMatchObject({ detail: 'INTO' });
  });

  it('rejects locking reads', () => {
    for (const sql of [
      'SELECT * FROM t FOR UPDATE',
      'SELECT * FROM t FOR SHARE',
      'SELECT * FROM t FOR NO KEY UPDATE',
      'SELECT * FROM t FOR KEY SHARE',
      'SELECT * FROM t FOR UPDATE NOWAIT',
    ]) {
      expect(rejected(sql).reason, sql).toBe('forbidden_keyword');
    }
    expect(rejected('SELECT * FROM t LOCK IN SHARE MODE', 'MYSQL').reason).toBe('forbidden_keyword');
  });

  it('rejects session, transaction and maintenance words inside a read', () => {
    for (const sql of ['SELECT 1 FROM t; COMMIT', 'WITH a AS (SELECT 1) SELECT * FROM a WHERE EXISTS (SELECT 1) SET x = 1']) {
      expect(checkReadOnlySql(sql, 'PG').ok, sql).toBe(false);
    }
  });

  it('rejects functions with side effects, bare, qualified, quoted or spaced', () => {
    const cases: Array<[string, AgentEngine, string]> = [
      ["SELECT nextval('s')", 'PG', 'nextval'],
      ["SELECT setval('s', 1)", 'PG', 'setval'],
      ['SELECT pg_sleep(10)', 'PG', 'pg_sleep'],
      ['SELECT pg_catalog.pg_sleep(1)', 'PG', 'pg_sleep'],
      ['SELECT "pg_sleep"(1)', 'PG', 'pg_sleep'],
      ['SELECT pg_sleep /* c */ (1)', 'PG', 'pg_sleep'],
      ['SELECT PG_ADVISORY_LOCK(1)', 'PG', 'pg_advisory_lock'],
      ['SELECT pg_try_advisory_xact_lock(1)', 'PG', 'pg_try_advisory_xact_lock'],
      ['SELECT pg_terminate_backend(123)', 'PG', 'pg_terminate_backend'],
      ["SELECT pg_read_file('/etc/passwd')", 'PG', 'pg_read_file'],
      ["SELECT lo_import('/etc/passwd')", 'PG', 'lo_import'],
      ["SELECT * FROM dblink('host=x', 'select 1') AS t(a int)", 'PG', 'dblink'],
      ["SELECT set_config('a', 'b', false)", 'PG', 'set_config'],
      ["SELECT current_setting('data_directory')", 'PG', 'current_setting'],
      ["SELECT pg_notify('c', 'x')", 'PG', 'pg_notify'],
      ["SELECT query_to_xml('select 1', true, true, '')", 'PG', 'query_to_xml'],
      ['SELECT sleep(5)', 'MYSQL', 'sleep'],
      ['SELECT `sleep`(5)', 'MYSQL', 'sleep'],
      ["SELECT benchmark(1000000, md5('a'))", 'MYSQL', 'benchmark'],
      ["SELECT get_lock('a', 10)", 'MYSQL', 'get_lock'],
      ["SELECT load_file('/etc/passwd')", 'MYSQL', 'load_file'],
      ["SELECT load_extension('x')", 'SQLITE', 'load_extension'],
      ["SELECT writefile('/tmp/x', 'y')", 'SQLITE', 'writefile'],
      ["SELECT readfile('/etc/passwd')", 'SQLITE', 'readfile'],
    ];
    for (const [sql, engine, fn] of cases) {
      expect(rejected(sql, engine), sql).toMatchObject({ reason: 'forbidden_function', detail: fn });
    }
  });

  it('does not mistake strings or columns named like functions for calls', () => {
    expect(checkReadOnlySql("SELECT 'sleep(1)' AS s", 'MYSQL').ok).toBe(true);
    expect(checkReadOnlySql('SELECT sleep_minutes FROM jobs', 'MYSQL').ok).toBe(true);
    expect(checkReadOnlySql('SELECT nextval_count FROM stats', 'PG').ok).toBe(true);
  });

  it('rejects MySQL executable comments', () => {
    expect(rejected('SELECT 1 /*!50000 , sleep(5) */', 'MYSQL').reason).toBe('executable_comment');
    expect(rejected('SELECT /*! STRAIGHT_JOIN */ 1', 'MYSQL').reason).toBe('executable_comment');
  });

  it('fails closed on bare column names that collide with forbidden keywords', () => {
    // Quote the identifier to use such a column.
    expect(rejected('SELECT lock FROM t').reason).toBe('forbidden_keyword');
    expect(checkReadOnlySql('SELECT "lock" FROM t', 'PG').ok).toBe(true);
  });

  it('uses MySQL comment rules on MySQL', () => {
    expect(checkReadOnlySql('SELECT 1 # DELETE FROM t', 'MYSQL').ok).toBe(true);
    // In PG `#` is an operator, so the rest is code.
    expect(checkReadOnlySql('SELECT 1 # DELETE FROM t', 'PG').ok).toBe(false);
  });
});
