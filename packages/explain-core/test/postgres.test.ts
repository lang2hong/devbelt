import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePostgresExplain } from '../src/index.js';
import type { ExplainParseResult, ExplainPlan } from '../src/types.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

function planOf(result: ExplainParseResult): ExplainPlan {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

function wrap(plan: Record<string, unknown>): unknown {
  return [{ Plan: plan }];
}

describe('parsePostgresExplain', () => {
  it('normalizes a large seq scan and preserves planning/execution time', () => {
    const plan = planOf(parsePostgresExplain(fixture('postgres-seq-scan.json')));
    expect(plan.dialect).toBe('postgres');
    expect(plan.planningTimeMs).toBe(0.2);
    expect(plan.executionTimeMs).toBe(1.5);

    const root = plan.roots[0];
    expect(root.operation).toBe('Seq Scan');
    expect(root.object).toBe('users');
    expect(root.estimatedRows).toBe(1000);
    expect(root.estimatedCost).toBe(35.5);
    expect(root.filter).toContain('active');
    expect(root.warnings).toEqual(['fullTableScan', 'missingIndex']);
  });

  it('does not flag small seq scans or an index-driven nested loop', () => {
    const plan = planOf(parsePostgresExplain(fixture('postgres-nested-loop.json')));
    const root = plan.roots[0];

    expect(root.operation).toBe('Nested Loop');
    expect(root.warnings).toEqual([]);
    expect(root.children).toHaveLength(2);
    expect(root.children[0].operation).toBe('Seq Scan');
    expect(root.children[0].warnings).toEqual([]);
    expect(root.children[1].operation).toBe('Index Scan');
    expect(root.children[1].index).toBe('users_pkey');
    expect(plan.warnings).toEqual([]);
  });

  it('reports Index Cond as an index condition, not a join condition', () => {
    const plan = planOf(parsePostgresExplain(fixture('postgres-nested-loop.json')));
    const index = plan.roots[0].children[1];
    expect(index.indexCondition).toBe('(id = orders.user_id)');
    expect(index.joinCondition).toBeUndefined();
  });

  it('flags a nested loop whose inner side is a large seq scan', () => {
    const plan = planOf(parsePostgresExplain(wrap({
      'Node Type': 'Nested Loop',
      'Plan Rows': 10,
      Plans: [
        { 'Node Type': 'Index Scan', 'Relation Name': 'a', 'Index Name': 'a_pkey', 'Plan Rows': 1 },
        { 'Node Type': 'Seq Scan', 'Relation Name': 'b', 'Plan Rows': 50000 },
      ],
    })));
    expect(plan.roots[0].warnings).toEqual(['nestedLoop']);
  });

  it('flags seq scans of unknown size without guessing missingIndex', () => {
    const plan = planOf(parsePostgresExplain(wrap({
      'Node Type': 'Seq Scan',
      'Relation Name': 't',
      Filter: '(x = 1)',
    })));
    expect(plan.roots[0].warnings).toEqual(['fullTableScan']);
  });

  it('does not flag a sort from a plain EXPLAIN', () => {
    const plan = planOf(parsePostgresExplain(fixture('postgres-sort.json')));
    const root = plan.roots[0];
    expect(root.operation).toBe('Sort');
    expect(root.warnings).toEqual([]);
    expect(root.children[0].object).toBe('logs');
    expect(root.children[0].warnings).toEqual(['fullTableScan']);
  });

  it('flags external sorts and keeps actual metrics from EXPLAIN ANALYZE', () => {
    const plan = planOf(parsePostgresExplain(fixture('postgres-sort-analyze.json')));
    const root = plan.roots[0];
    expect(root.warnings).toContain('filesort');
    expect(root.actualRows).toBe(10000);
    expect(root.actualTimeMs).toBe(42.5);
    expect(root.loops).toBe(1);
    expect(plan.executionTimeMs).toBe(45);
  });

  it('adds highCost when a caller supplies a threshold', () => {
    const plan = planOf(parsePostgresExplain(fixture('postgres-sort.json'), { highCostThreshold: 100 }));
    expect(plan.warnings).toContain('highCost');
  });

  it('accepts a QUERY PLAN row wrapper', () => {
    const wrapped = { 'QUERY PLAN': fixture('postgres-seq-scan.json') };
    expect(planOf(parsePostgresExplain(wrapped)).roots[0].operation).toBe('Seq Scan');
  });

  it('returns a fallback result for an unknown shape', () => {
    const raw = { unexpected: true };
    const result = parsePostgresExplain(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.dialect).toBe('postgres');
      expect(result.error).toContain('Plan');
      expect(result.raw).toBe(raw);
    }
  });
});