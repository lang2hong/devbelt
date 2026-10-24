import { describe, expect, it } from 'vitest';
import { parseMysqlAnalyze } from '../src/index.js';
import type { ExplainParseResult, ExplainPlan, ExplainPlanNode } from '../src/types.js';

/** Captured from MySQL 8.0.36 (db_client_verify, temporary tables). */
const LIMIT_SCAN = `-> Limit: 100 row(s)  (cost=31 rows=100) (actual time=0.821..0.835 rows=100 loops=1)
    -> Table scan on ea_o  (cost=31 rows=300) (actual time=0.0441..0.0523 rows=100 loops=1)
`;

const JOIN_GROUP = `-> Sort: COUNT(*) DESC  (actual time=2.72..2.72 rows=10 loops=1)
    -> Table scan on <temporary>  (actual time=2.07..2.07 rows=10 loops=1)
        -> Aggregate using temporary table  (actual time=2.07..2.07 rows=10 loops=1)
            -> Nested loop inner join  (cost=37 rows=3) (actual time=0.0606..0.436 rows=100 loops=1)
                -> Table scan on u  (cost=4 rows=30) (actual time=0.0174..0.0234 rows=30 loops=1)
                -> Filter: (o.\`status\` = 's1')  (cost=1 rows=0.1) (actual time=0.0118..0.0133 rows=3.33 loops=30)
                    -> Index lookup on o using k_uid (uid=u.id)  (cost=1 rows=1) (actual time=0.00934..0.0118 rows=10 loops=30)
`;

function planOf(result: ExplainParseResult): ExplainPlan {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

function flat(nodes: readonly ExplainPlanNode[]): ExplainPlanNode[] {
  return nodes.flatMap((n) => [n, ...flat(n.children)]);
}

describe('parseMysqlAnalyze', () => {
  it('parses estimates and actuals and nests by indentation', () => {
    const plan = planOf(parseMysqlAnalyze([{ EXPLAIN: LIMIT_SCAN }]));
    expect(plan.dialect).toBe('mysql');
    expect(plan.roots).toHaveLength(1);
    const [limit] = plan.roots;
    expect(limit).toMatchObject({ operation: 'Limit: 100 row(s)', estimatedRows: 100, estimatedCost: 31, actualRows: 100, actualTimeMs: 0.835, loops: 1 });
    expect(limit.children[0]).toMatchObject({ operation: 'Table scan', object: 'ea_o', estimatedRows: 300, actualRows: 100 });
    expect(plan.executionTimeMs).toBeCloseTo(0.835);
    // 300 rows is a small table: no warning.
    expect(plan.warnings).toEqual([]);
  });

  it('maps access steps and keeps conditions', () => {
    const nodes = flat(planOf(parseMysqlAnalyze(JOIN_GROUP)).roots);
    expect(nodes.map((n) => n.operation)).toEqual([
      'Sort: COUNT(*) DESC',
      'Table scan',
      'Aggregate using temporary table',
      'Nested loop join',
      'Table scan',
      'Filter',
      'Index lookup',
    ]);
    const lookup = nodes.find((n) => n.operation === 'Index lookup')!;
    expect(lookup).toMatchObject({ object: 'o', index: 'k_uid', indexCondition: 'uid=u.id', actualRows: 10, loops: 30 });
    expect(nodes.find((n) => n.operation === 'Filter')!.filter).toBe("(o.`status` = 's1')");
    expect(nodes.find((n) => n.operation === 'Aggregate using temporary table')!.warnings).toEqual(['temporaryTable']);
    // The internal temporary table scan is not a table the user can index.
    expect(nodes[1].warnings).toEqual([]);
  });

  it('flags a large filtered scan as missing an index', () => {
    const text = `-> Filter: (t.c = 1)  (cost=500 rows=500) (actual time=0.1..9.5 rows=12 loops=1)
    -> Table scan on t  (cost=500 rows=5000) (actual time=0.05..8.1 rows=5000 loops=1)`;
    const scan = flat(planOf(parseMysqlAnalyze(text)).roots).find((n) => n.operation === 'Table scan')!;
    expect(scan.warnings).toEqual(['fullTableScan', 'missingIndex']);
  });

  it('accepts never-executed steps', () => {
    const text = `-> Nested loop inner join  (cost=2 rows=1) (actual time=0.01..0.01 rows=0 loops=1)
    -> Table scan on a  (cost=1 rows=1) (actual time=0.01..0.01 rows=0 loops=1)
    -> Index lookup on b using PRIMARY (id=a.id)  (cost=1 rows=1) (never executed)`;
    const nodes = flat(planOf(parseMysqlAnalyze(text)).roots);
    expect(nodes[2]).toMatchObject({ operation: 'Index lookup', object: 'b', index: 'PRIMARY', estimatedRows: 1 });
    expect(nodes[2].actualRows).toBeUndefined();
  });

  it('fails on non-TREE input so callers can show the raw text', () => {
    expect(parseMysqlAnalyze('').ok).toBe(false);
    expect(parseMysqlAnalyze('id select_type table').ok).toBe(false);
    expect(parseMysqlAnalyze([{ id: 1, table: 't' }]).ok).toBe(false);
  });
});
