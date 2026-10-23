import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMysqlExplain } from '../src/index.js';
import type { ExplainPlanNode } from '../src/types.js';

/**
 * Regression on real MySQL 8.0.36 EXPLAIN FORMAT=JSON output captured from a
 * development database (P10 S9). Identifiers and literals are anonymized.
 */
function load(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

function flat(nodes: readonly ExplainPlanNode[]): ExplainPlanNode[] {
  return nodes.flatMap((n) => [n, ...flat(n.children)]);
}

describe('real MySQL 8.0.36 plans', () => {
  it('small full scan: parsed, not flagged', () => {
    const r = parseMysqlExplain(load('real-mysql-1.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scan = flat(r.plan.roots).find((n) => n.object === 't1');
    expect(scan).toMatchObject({ operation: 'Table scan', estimatedRows: 10 });
    expect(r.plan.warnings).toEqual([]);
  });

  it('ORDER BY satisfied by an index: Sort node without filesort warning', () => {
    for (const name of ['real-mysql-2.json', 'real-mysql-3.json']) {
      const r = parseMysqlExplain(load(name));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const nodes = flat(r.plan.roots);
      const sort = nodes.find((n) => n.operation === 'Sort');
      expect(sort?.warnings).toEqual([]);
      const table = nodes.find((n) => n.object === 't1');
      expect(table).toMatchObject({ operation: 'Index scan', index: 'PRIMARY' });
      expect(table?.filter).toMatch(/`t1`\.`c\d+` = 1/);
      expect(r.plan.warnings).toEqual([]);
    }
  });
});
