import { describe, expect, it } from 'vitest';
import { extractPredicates } from '../src/index.js';

function kinds(sql: string): string[] {
  return extractPredicates(sql).predicates.map((p) => `${p.table}.${p.column}:${p.kind}`);
}

describe('extractPredicates', () => {
  it('extracts equality and range on a single table', () => {
    expect(kinds("SELECT * FROM orders WHERE status = 'paid' AND created_at >= '2026-01-01'"))
      .toEqual(['orders.status:eq', 'orders.created_at:range']);
  });

  it('handles IN, IS NULL, BETWEEN and prefix LIKE', () => {
    expect(kinds("SELECT * FROM t WHERE a IN (1,2) AND b IS NULL AND c BETWEEN 1 AND 5 AND d LIKE 'ab%'"))
      .toEqual(['t.a:eq', 't.b:eq', 't.c:range', 't.d:range']);
  });

  it('skips leading-wildcard LIKE, inequality and function-wrapped columns', () => {
    expect(kinds("SELECT * FROM t WHERE d LIKE '%ab' AND e <> 1 AND LOWER(f) = 'x'")).toEqual([]);
  });

  it('resolves aliases and join conditions', () => {
    const r = extractPredicates(
      'SELECT o.id FROM orders o JOIN users AS u ON u.id = o.user_id WHERE o.status = 1 ORDER BY o.created_at DESC',
    );
    expect(r.tables).toEqual(['orders', 'users']);
    expect(r.predicates.map((p) => `${p.table}.${p.column}:${p.kind}`)).toEqual([
      'users.id:join',
      'orders.user_id:join',
      'orders.status:eq',
      'orders.created_at:order',
    ]);
  });

  it('does not attribute unqualified columns when several tables are in scope', () => {
    expect(kinds('SELECT * FROM a JOIN b ON a.id = b.a_id WHERE status = 1')).toEqual(['a.id:join', 'b.a_id:join']);
  });

  it('ignores WHERE clauses containing OR', () => {
    const r = extractPredicates('SELECT * FROM t WHERE a = 1 OR b = 2');
    expect(r.hasOr).toBe(true);
    expect(r.predicates).toEqual([]);
  });

  it('ignores sub-queries and keywords inside string literals', () => {
    expect(kinds("SELECT * FROM t WHERE a = 'x OR y' AND b IN (SELECT id FROM s WHERE z = 1)"))
      .toEqual(['t.a:eq', 't.b:eq']);
  });

  it('stops ORDER BY extraction at expressions', () => {
    expect(kinds('SELECT * FROM t ORDER BY a, LENGTH(b), c')).toEqual(['t.a:order']);
  });

  it('extracts GROUP BY and quoted identifiers', () => {
    expect(kinds('SELECT `Type`, COUNT(*) FROM `events` WHERE "day" = 1 GROUP BY `Type`'))
      .toEqual(['events.day:eq', 'events.type:group']);
  });

  it('supports UPDATE statements', () => {
    expect(kinds("UPDATE accounts SET balance = 0 WHERE owner_id = 7")).toEqual(['accounts.owner_id:eq']);
  });
});