import { describe, expect, it } from 'vitest';
import { extractPredicates, suggestIndexes, suggestedIndexName } from '../src/index.js';
import type { AdvisorTable, ExplainPlan, ExplainPlanNode, ExplainWarning } from '../src/index.js';

function scan(table: string, warnings: ExplainWarning[] = ['fullTableScan']): ExplainPlanNode {
  return { id: table, operation: 'Seq Scan', object: table, estimatedRows: 50000, warnings, children: [] };
}

function plan(...roots: ExplainPlanNode[]): ExplainPlan {
  const warnings = [...new Set(roots.flatMap((r) => [...r.warnings, ...r.children.flatMap((c) => c.warnings)]))];
  return { dialect: 'postgres', roots, warnings, raw: null };
}

function table(name: string, columns: Array<string | [string, Partial<AdvisorTable['columns'][number]>]>, indexes: AdvisorTable['indexes'] = []): AdvisorTable {
  return {
    name,
    columns: columns.map((c) => (typeof c === 'string' ? { name: c } : { name: c[0], ...c[1] })),
    indexes,
  };
}

function advise(sql: string, p: ExplainPlan, tables: AdvisorTable[]) {
  return suggestIndexes({ plan: p, extraction: extractPredicates(sql), tables });
}

describe('suggestIndexes — fixed cases', () => {
  it('1. single equality column on a full scan', () => {
    const r = advise("SELECT * FROM orders WHERE status = 'paid'", plan(scan('orders')), [
      table('orders', [['id', { isPrimary: true }], 'status']),
    ]);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({
      table: 'orders',
      columns: ['status'],
      confidence: 'medium',
      reasons: ['fullScanWithFilter'],
    });
    expect(r.suggestions[0].risks).toEqual(['writeAmplification', 'lockOnBuild', 'selectivityUnknown']);
  });

  it('2. equality then range forms a composite in that order', () => {
    const r = advise(
      "SELECT * FROM orders WHERE created_at >= '2026-01-01' AND customer_id = 9",
      plan(scan('orders')),
      [table('orders', ['id', 'customer_id', 'created_at'])],
    );
    expect(r.suggestions[0].columns).toEqual(['customer_id', 'created_at']);
    expect(r.suggestions[0].reasons).toEqual(expect.arrayContaining(['equalityFirst', 'rangeAfterEquality']));
  });

  it('3. equality then ORDER BY when the plan sorts', () => {
    const sort: ExplainPlanNode = { id: 's', operation: 'Sort', warnings: ['filesort'], children: [scan('orders')] };
    const r = advise('SELECT * FROM orders WHERE customer_id = 9 ORDER BY created_at DESC', plan(sort), [
      table('orders', ['id', 'customer_id', 'created_at']),
    ]);
    expect(r.suggestions[0].columns).toEqual(['customer_id', 'created_at']);
    expect(r.suggestions[0].reasons).toEqual(expect.arrayContaining(['filesort', 'orderAfterEquality']));
  });

  it('4. skips a candidate already covered by an existing index prefix', () => {
    const r = advise("SELECT * FROM orders WHERE status = 'paid'", plan(scan('orders')), [
      table('orders', ['id', 'status', 'created_at'], [{ name: 'idx_status_created', columns: ['status', 'created_at'] }]),
    ]);
    expect(r.suggestions).toEqual([]);
  });

  it('5. excludes primary-key and unique columns', () => {
    const r = advise('SELECT * FROM users WHERE id = 1 AND email = 2', plan(scan('users')), [
      table('users', [['id', { isPrimary: true }], ['email', { isUnique: true }]]),
    ]);
    expect(r.suggestions).toEqual([]);
  });
});

describe('suggestIndexes — guard rails', () => {
  it('does nothing for tables the plan does not flag', () => {
    const r = advise("SELECT * FROM orders WHERE status = 'paid'", plan(scan('orders', [])), [
      table('orders', ['id', 'status']),
    ]);
    expect(r.suggestions).toEqual([]);
  });

  it('does not stack ORDER BY after a range column', () => {
    const sort: ExplainPlanNode = { id: 's', operation: 'Sort', warnings: ['filesort'], children: [scan('t')] };
    const r = advise('SELECT * FROM t WHERE a = 1 AND b > 2 ORDER BY c', plan(sort), [table('t', ['a', 'b', 'c'])]);
    expect(r.suggestions[0].columns).toEqual(['a', 'b']);
  });

  it('lowers confidence and flags low-cardinality columns', () => {
    const r = advise('SELECT * FROM t WHERE active = 1', plan(scan('t')), [
      table('t', [['active', { type: 'tinyint(1)' }]]),
    ]);
    expect(r.suggestions[0].confidence).toBe('low');
    expect(r.suggestions[0].risks).toContain('lowCardinality');
  });

  it('gives no advice for OR conditions', () => {
    const r = advise('SELECT * FROM t WHERE a = 1 OR b = 2', plan(scan('t')), [table('t', ['a', 'b'])]);
    expect(r.suggestions).toEqual([]);
  });

  it('suggests a join-column index on the scanned side of a join', () => {
    const r = advise(
      'SELECT * FROM users u JOIN orders o ON o.user_id = u.id',
      plan({ id: 'j', operation: 'Nested Loop', warnings: ['nestedLoop'], children: [{ ...scan('users', []) }, scan('orders')] }),
      [table('users', [['id', { isPrimary: true }]]), table('orders', ['id', 'user_id'])],
    );
    expect(r.suggestions).toEqual([
      expect.objectContaining({ table: 'orders', columns: ['user_id'], reasons: ['joinColumn'] }),
    ]);
  });

  it('caps columns and suggestions per table', () => {
    const r = suggestIndexes({
      plan: plan(scan('t')),
      extraction: extractPredicates('SELECT * FROM t WHERE a = 1 AND b = 2 AND c = 3 AND d = 4'),
      tables: [table('t', ['a', 'b', 'c', 'd'])],
      maxColumns: 2,
    });
    expect(r.suggestions[0].columns).toEqual(['a', 'b']);
  });

  it('reports redundant prefix indexes', () => {
    const r = advise('SELECT 1 FROM t', plan(), [
      table('t', ['a', 'b'], [
        { name: 'idx_a', columns: ['a'] },
        { name: 'idx_a_b', columns: ['a', 'b'] },
        { name: 'pk', columns: ['a'], isPrimary: true },
      ]),
    ]);
    expect(r.redundant).toEqual([{ table: 't', index: 'idx_a', coveredBy: 'idx_a_b' }]);
  });
});

describe('suggestedIndexName', () => {
  it('builds a deterministic, sanitized name', () => {
    expect(suggestedIndexName('Orders', ['customer_id', 'created_at'])).toBe('idx_orders_customer_id_created_at');
    expect(suggestedIndexName('my-table', ['a b'])).toBe('idx_my_table_a_b');
  });

  it('clips to the identifier limit', () => {
    const name = suggestedIndexName('t'.repeat(40), ['c'.repeat(40)]);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith('_')).toBe(false);
  });
});

describe('suggestIndexes — aliases in plans', () => {
  it('matches MySQL/SQLite plan nodes that report the alias', () => {
    const r = advise("SELECT * FROM orders o WHERE o.status = 'paid'", plan(scan('o')), [
      table('orders', [['id', { isPrimary: true }], 'status']),
    ]);
    expect(r.suggestions).toEqual([expect.objectContaining({ table: 'orders', columns: ['status'] })]);
  });

  it('maps join aliases on both sides', () => {
    const r = advise(
      'SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE o.status = 1',
      plan({ id: 'j', operation: 'Nested loop join', warnings: [], children: [scan('u', []), scan('o')] }),
      [table('users', [['id', { isPrimary: true }]]), table('orders', ['id', 'user_id', 'status'])],
    );
    // Only the flagged side (orders via alias `o`) gets advice; equality and join columns combine.
    expect(r.suggestions.map((s) => [s.table, s.columns])).toEqual([['orders', ['user_id', 'status']]]);
  });

  it('still matches plans that report the real table name', () => {
    const r = advise("SELECT * FROM orders o WHERE o.status = 'paid'", plan(scan('orders')), [
      table('orders', [['id', { isPrimary: true }], 'status']),
    ]);
    expect(r.suggestions).toHaveLength(1);
  });
});
