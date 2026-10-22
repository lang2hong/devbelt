import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import type { ExplainParseResult, ExplainPlan } from '@devbelt/explain-core';
import {
  buildExplainQuery,
  dialectFor,
  parseExplainRows,
  rowsToText,
  shouldSkipExplain,
} from '../../src/explain/explainRunner';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/explain/${name}`, import.meta.url), 'utf8')) as unknown;
}

function planOf(result: ExplainParseResult): ExplainPlan {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

describe('explainRunner', () => {
  it('maps database types to parser dialects', () => {
    expect(dialectFor(DatabaseType.MYSQL)).toBe('mysql');
    expect(dialectFor(DatabaseType.PG)).toBe('postgres');
    expect(dialectFor(DatabaseType.SQLITE)).toBe('sqlite');
    expect(dialectFor(DatabaseType.REDIS)).toBeUndefined();
    expect(dialectFor(DatabaseType.ELASTICSEARCH)).toBeUndefined();
  });

  it('builds structured EXPLAIN SQL with a legacy fallback', () => {
    expect(buildExplainQuery(DatabaseType.MYSQL, 'SELECT 1')).toEqual({
      sql: 'EXPLAIN FORMAT=JSON SELECT 1',
      fallbackSql: 'EXPLAIN SELECT 1',
    });
    expect(buildExplainQuery(DatabaseType.PG, 'SELECT 1')).toEqual({
      sql: 'EXPLAIN (FORMAT JSON) SELECT 1',
      fallbackSql: 'EXPLAIN SELECT 1',
    });
    expect(buildExplainQuery(DatabaseType.SQLITE, 'SELECT 1')).toEqual({
      sql: 'EXPLAIN QUERY PLAN SELECT 1',
      fallbackSql: 'EXPLAIN QUERY PLAN SELECT 1',
    });
    expect(() => buildExplainQuery(DatabaseType.REDIS, 'GET x')).toThrow();
  });

  it('skips DDL statements but not SELECT', () => {
    expect(shouldSkipExplain('CREATE TABLE t (id INT)')).toBe(true);
    expect(shouldSkipExplain('SELECT * FROM t')).toBe(false);
  });

  it('parses MySQL structured rows', () => {
    const plan = planOf(parseExplainRows('mysql', [fixture('mysql-plan.json')]));
    expect(plan.dialect).toBe('mysql');
    expect(plan.roots[0].children[0].operation).toBe('Table scan');
    expect(plan.warnings).toContain('fullTableScan');
  });

  it('parses PostgreSQL structured rows', () => {
    const plan = planOf(parseExplainRows('postgres', fixture('postgres-plan.json') as unknown[]));
    expect(plan.dialect).toBe('postgres');
    expect(plan.roots[0].operation).toBe('Seq Scan');
    expect(plan.warnings).toContain('missingIndex');
  });

  it('parses SQLite EXPLAIN QUERY PLAN rows', () => {
    const plan = planOf(parseExplainRows('sqlite', fixture('sqlite-plan.json') as unknown[]));
    expect(plan.dialect).toBe('sqlite');
    expect(plan.roots[0].operation).toBe('Table scan');
    expect(plan.warnings).toContain('filesort');
  });

  it('returns a fallback result for malformed structured output', () => {
    const result = parseExplainRows('mysql', [{ unexpected: true }]);
    expect(result.ok).toBe(false);
  });

  it('renders single-column legacy rows as text', () => {
    expect(rowsToText([{ 'QUERY PLAN': 'Seq Scan on users' }])).toBe('Seq Scan on users');
    expect(rowsToText([{ a: 1, b: 2 }])).toBe('{"a":1,"b":2}');
  });
});