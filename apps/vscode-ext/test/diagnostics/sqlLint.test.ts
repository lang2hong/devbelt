import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import { lintSql, maskSql } from '../../src/diagnostics/sqlLint';
import { dialectScanOptions } from '../../src/utils/sqlDialectOptions';

function rules(sql: string, opts: Parameters<typeof lintSql>[1] = {}): string[] {
  return lintSql(sql, opts).map((f) => f.rule);
}

function flagged(sql: string, opts: Parameters<typeof lintSql>[1] = {}): string[] {
  return lintSql(sql, opts).map((f) => sql.slice(f.start, f.end));
}

describe('maskSql', () => {
  it('keeps length and newlines while blanking strings and comments', () => {
    const sql = "SELECT 'a;b' -- x\nFROM t /* y */";
    const masked = maskSql(sql);
    expect(masked).toHaveLength(sql.length);
    expect(masked.split('\n')).toHaveLength(2);
    expect(masked).not.toContain('a;b');
    expect(masked).not.toContain('x');
    expect(masked).toContain('FROM t');
  });
});

describe('lintSql', () => {
  it('flags UPDATE/DELETE without WHERE at the verb', () => {
    const sql = 'UPDATE t SET a = 1;\nDELETE FROM t;';
    expect(rules(sql)).toEqual(['updateDeleteWithoutWhere', 'updateDeleteWithoutWhere']);
    expect(flagged(sql)).toEqual(['UPDATE', 'DELETE']);
    expect(lintSql(sql)[0].args).toEqual({ verb: 'UPDATE' });
  });

  it('accepts UPDATE/DELETE with WHERE, including WHERE inside the statement only', () => {
    expect(rules('UPDATE t SET a = 1 WHERE id = 2')).toEqual([]);
    expect(rules('DELETE FROM t WHERE id IN (SELECT id FROM s)')).toEqual([]);
  });

  it('does not treat a WHERE inside a sub-query as the statement WHERE', () => {
    expect(rules('UPDATE t SET a = (SELECT b FROM s WHERE s.id = 1)')).toEqual(['updateDeleteWithoutWhere']);
  });

  it('does not flag keywords inside strings or comments', () => {
    expect(rules("SELECT 'DELETE FROM t' AS x; -- DROP TABLE t\n/* UPDATE t SET a=1 */ SELECT 1")).toEqual([]);
  });

  it('flags DROP/TRUNCATE as warning and ALTER as info', () => {
    const findings = lintSql('DROP TABLE t; TRUNCATE t; ALTER TABLE t ADD c INT;');
    expect(findings.map((f) => [f.rule, f.severity, f.messageKey])).toEqual([
      ['dangerousDdl', 'warning', 'diag.sql.destructiveDdl'],
      ['dangerousDdl', 'warning', 'diag.sql.destructiveDdl'],
      ['dangerousDdl', 'info', 'diag.sql.alter'],
    ]);
  });

  it('does not flag DROP used as a column name', () => {
    expect(rules('SELECT drop_flag FROM t WHERE id = 1')).toEqual([]);
  });

  it('flags NOT IN (subquery) with the whole sub-query range', () => {
    const sql = 'SELECT a FROM t WHERE id NOT IN (SELECT tid FROM s)';
    expect(rules(sql)).toEqual(['notInSubquery']);
    expect(flagged(sql)).toEqual(['NOT IN (SELECT tid FROM s)']);
    expect(rules('SELECT a FROM t WHERE id NOT IN (1, 2)')).toEqual([]);
  });

  it('flags the outermost SELECT * only', () => {
    expect(rules('SELECT * FROM t')).toEqual(['selectStar']);
    expect(flagged('SELECT DISTINCT * FROM t')).toEqual(['*']);
    expect(rules('WITH x AS (SELECT * FROM s) SELECT * FROM x')).toEqual(['selectStar']);
    expect(rules('SELECT COUNT(*) FROM t')).toEqual([]);
    expect(rules('SELECT t.* FROM t')).toEqual([]);
    expect(rules('SELECT a FROM (SELECT * FROM t) x')).toEqual([]);
  });

  it('applies dialect rules only when the connection is known', () => {
    const pg = 'SELECT `a` FROM t LIMIT 10, 5';
    expect(rules(pg)).toEqual([]);
    expect(flagged(pg, { dbType: DatabaseType.PG })).toEqual(['`a`', 'LIMIT 10, 5']);

    const my = "SELECT a::int FROM t WHERE b ILIKE 'x%'";
    expect(rules(my)).toEqual([]);
    expect(flagged(my, { dbType: DatabaseType.MYSQL, scanOptions: dialectScanOptions(DatabaseType.MYSQL) }))
      .toEqual(['ILIKE', '::int']);
  });

  it('does not flag dialect syntax inside strings', () => {
    expect(rules("SELECT 'a::int ILIKE' FROM t", { dbType: DatabaseType.MYSQL })).toEqual([]);
  });

  it('honours per-rule severity overrides and off', () => {
    const sql = 'DELETE FROM t; SELECT * FROM t';
    const findings = lintSql(sql, { rules: { updateDeleteWithoutWhere: 'error', selectStar: 'off' } });
    expect(findings.map((f) => [f.rule, f.severity])).toEqual([['updateDeleteWithoutWhere', 'error']]);
  });

  it('ignores invalid override values', () => {
    expect(lintSql('DELETE FROM t', { rules: { updateDeleteWithoutWhere: 'loud' } })[0].severity).toBe('warning');
  });

  it('reports offsets relative to the whole document across statements', () => {
    const sql = 'SELECT 1;\n\n  DELETE FROM t';
    const [f] = lintSql(sql);
    expect(sql.slice(f.start, f.end)).toBe('DELETE');
    expect(f.start).toBe(sql.indexOf('DELETE'));
  });

  it('uses MySQL hash comments only with MySQL scan options', () => {
    const sql = 'SELECT 1 # DELETE FROM t\n';
    expect(rules(sql, { scanOptions: dialectScanOptions(DatabaseType.MYSQL) })).toEqual([]);
  });

  it('does not flag MySQL # comments in documents without a bound connection', () => {
    expect(rules('SELECT 1; # DELETE FROM t\nSELECT 2')).toEqual([]);
    // Code before the # on the same line is still checked.
    expect(rules('DELETE FROM t # cleanup')).toEqual(['updateDeleteWithoutWhere']);
  });

  it('keeps PostgreSQL # operators visible when the connection is PG', () => {
    // `#` is XOR in PG; the statement after it is still a DELETE without WHERE.
    expect(rules('SELECT 1 # 2;\nDELETE FROM t', { dbType: DatabaseType.PG })).toEqual(['updateDeleteWithoutWhere']);
  });
});
