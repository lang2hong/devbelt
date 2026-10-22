import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMysqlExplain } from '../src/index.js';
import type { ExplainParseResult, ExplainPlan } from '../src/types.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

function planOf(result: ExplainParseResult): ExplainPlan {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

describe('parseMysqlExplain', () => {
  it('normalizes a full table scan and its filter', () => {
    const plan = planOf(parseMysqlExplain(fixture('mysql-table-scan.json')));
    expect(plan.dialect).toBe('mysql');
    expect(plan.roots).toHaveLength(1);

    const root = plan.roots[0];
    expect(root.operation).toBe('Query block');
    expect(root.estimatedCost).toBe(42.5);

    const table = root.children[0];
    expect(table.operation).toBe('Table scan');
    expect(table.object).toBe('users');
    expect(table.estimatedRows).toBe(1000);
    expect(table.estimatedCost).toBe(12);
    expect(table.filter).toContain('active');
    expect(table.warnings).toContain('fullTableScan');
    expect(table.warnings).toContain('missingIndex');
    expect(plan.warnings).toEqual(expect.arrayContaining(['fullTableScan', 'missingIndex']));
  });

  it('normalizes nested loops, index lookups and filesort', () => {
    const plan = planOf(parseMysqlExplain(fixture('mysql-nested-loop.json')));
    const join = plan.roots[0].children[0];

    expect(join.operation).toBe('Nested loop join');
    expect(join.warnings).toContain('nestedLoop');
    expect(join.children).toHaveLength(3);

    expect(join.children[0].operation).toBe('Table scan');
    expect(join.children[0].object).toBe('orders');
    expect(join.children[1].operation).toBe('Index lookup');
    expect(join.children[1].index).toBe('PRIMARY');

    const sort = join.children[2];
    expect(sort.operation).toBe('Sort');
    expect(sort.warnings).toContain('filesort');
    expect(sort.children[0].operation).toBe('Index scan');
    expect(sort.children[0].index).toBe('idx_created');
  });

  it('flags temporary tables used for grouping', () => {
    const plan = planOf(parseMysqlExplain(fixture('mysql-temp-table.json')));
    const group = plan.roots[0].children[0];

    expect(group.operation).toBe('Group by');
    expect(group.warnings).toContain('temporaryTable');
    expect(group.children[0].operation).toBe('Index range scan');
    expect(plan.warnings).toContain('temporaryTable');
  });

  it('adds highCost when a caller supplies a threshold', () => {
    const plan = planOf(parseMysqlExplain(fixture('mysql-table-scan.json'), { highCostThreshold: 10 }));
    expect(plan.warnings).toContain('highCost');
    expect(plan.roots[0].warnings).toContain('highCost');
  });

  it('accepts a bare query block and a parsed EXPLAIN column', () => {
    const wrapper = fixture('mysql-table-scan.json') as { EXPLAIN: string };
    const bare = JSON.parse(wrapper.EXPLAIN) as unknown;
    expect(planOf(parseMysqlExplain(bare)).roots[0].operation).toBe('Query block');
    expect(planOf(parseMysqlExplain({ EXPLAIN: bare })).roots[0].operation).toBe('Query block');
  });

  it('returns a fallback result for an unknown shape', () => {
    const raw = { unexpected: true };
    const result = parseMysqlExplain(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.dialect).toBe('mysql');
      expect(result.error).toContain('query_block');
      expect(result.raw).toBe(raw);
    }
  });
});