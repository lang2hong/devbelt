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

describe('parsePostgresExplain', () => {
  it('normalizes a seq scan and preserves planning/execution time', () => {
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
    expect(root.warnings).toContain('fullTableScan');
    expect(root.warnings).toContain('missingIndex');
  });

  it('normalizes nested loops and index scans', () => {
    const plan = planOf(parsePostgresExplain(fixture('postgres-nested-loop.json')));
    const root = plan.roots[0];

    expect(root.operation).toBe('Nested Loop');
    expect(root.warnings).toContain('nestedLoop');
    expect(root.children).toHaveLength(2);
    expect(root.children[0].operation).toBe('Seq Scan');
    expect(root.children[1].operation).toBe('Index Scan');
    expect(root.children[1].index).toBe('users_pkey');
  });

  it('flags external sorts', () => {
    const plan = planOf(parsePostgresExplain(fixture('postgres-sort.json')));
    const root = plan.roots[0];

    expect(root.operation).toBe('Sort');
    expect(root.warnings).toContain('filesort');
    expect(root.children[0].operation).toBe('Seq Scan');
    expect(root.children[0].object).toBe('logs');
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