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

function block(body: Record<string, unknown>): unknown {
  return { query_block: { select_id: 1, ...body } };
}

describe('parseMysqlExplain', () => {
  it('normalizes a large full table scan and its filter', () => {
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
    expect(table.warnings).toEqual(['fullTableScan', 'missingIndex']);
    expect(plan.warnings).toEqual(expect.arrayContaining(['fullTableScan', 'missingIndex']));
  });

  it('does not flag small full scans', () => {
    const plan = planOf(parseMysqlExplain(block({
      table: { table_name: 'flags', access_type: 'ALL', rows_examined_per_scan: 12, attached_condition: '(x = 1)' },
    })));
    expect(plan.roots[0].children[0].operation).toBe('Table scan');
    expect(plan.warnings).toEqual([]);
  });

  it('flags full scans of unknown size without guessing missingIndex', () => {
    const plan = planOf(parseMysqlExplain(block({
      table: { table_name: 't', access_type: 'ALL', attached_condition: '(x = 1)' },
    })));
    expect(plan.roots[0].children[0].warnings).toEqual(['fullTableScan']);
  });

  it('respects a custom largeScanRows threshold', () => {
    const plan = planOf(parseMysqlExplain(block({
      table: { table_name: 't', access_type: 'ALL', rows_examined_per_scan: 50, attached_condition: '(x = 1)' },
    }), { largeScanRows: 10 }));
    expect(plan.roots[0].children[0].warnings).toEqual(['fullTableScan', 'missingIndex']);
  });

  it('keeps ordering outside the join and does not flag an index-driven nested loop', () => {
    const plan = planOf(parseMysqlExplain(fixture('mysql-nested-loop.json')));
    const sort = plan.roots[0].children[0];
    expect(sort.operation).toBe('Sort');
    expect(sort.warnings).toContain('filesort');

    const join = sort.children[0];
    expect(join.operation).toBe('Nested loop join');
    expect(join.warnings).toEqual([]);
    expect(join.children.map((child) => child.object)).toEqual(['orders', 'users']);
    expect(join.children[0].warnings).toContain('fullTableScan');
    expect(join.children[1].operation).toBe('Index lookup');
    expect(join.children[1].index).toBe('PRIMARY');
  });

  it('flags a nested loop whose inner table is a large full scan', () => {
    const plan = planOf(parseMysqlExplain(block({
      nested_loop: [
        { table: { table_name: 'a', access_type: 'const', key: 'PRIMARY', rows_examined_per_scan: 1 } },
        { table: { table_name: 'b', access_type: 'ALL', rows_examined_per_scan: 50000 } },
      ],
    })));
    const join = plan.roots[0].children[0];
    expect(join.warnings).toEqual(['nestedLoop']);
  });

  it('treats block-nested-loop join buffers as nested loops and hash joins as not', () => {
    const bnl = planOf(parseMysqlExplain(block({
      table: { table_name: 'b', access_type: 'index', key: 'k', using_join_buffer: 'Block Nested Loop' },
    })));
    expect(bnl.roots[0].children[0].warnings).toContain('nestedLoop');

    const hash = planOf(parseMysqlExplain(block({
      table: { table_name: 'b', access_type: 'index', key: 'k', using_join_buffer: 'hash join' },
    })));
    expect(hash.roots[0].children[0].warnings).not.toContain('nestedLoop');
  });

  it('preserves the order of sibling operations from the JSON', () => {
    const plan = planOf(parseMysqlExplain(block({
      table: { table_name: 'outer_t', access_type: 'index', key: 'k' },
      nested_loop: [{ table: { table_name: 'inner_t', access_type: 'index', key: 'k' } }],
    })));
    expect(plan.roots[0].children.map((child) => child.operation)).toEqual(['Index scan', 'Nested loop join']);
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