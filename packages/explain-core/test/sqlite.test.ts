import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSqliteExplain } from '../src/index.js';
import type { ExplainParseResult, ExplainPlan } from '../src/types.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

function planOf(result: ExplainParseResult): ExplainPlan {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

function single(detail: string): ExplainPlan {
  return planOf(parseSqliteExplain([{ id: 1, parent: 0, detail }]));
}

describe('parseSqliteExplain', () => {
  it('rebuilds roots and child plan steps', () => {
    const plan = planOf(parseSqliteExplain(fixture('sqlite-basic.json')));
    expect(plan.dialect).toBe('sqlite');
    expect(plan.roots).toHaveLength(2);

    const scan = plan.roots[0];
    expect(scan.operation).toBe('Table scan');
    expect(scan.object).toBe('users');
    expect(scan.warnings).toContain('fullTableScan');
    expect(scan.children).toHaveLength(1);

    const temp = scan.children[0];
    expect(temp.operation).toContain('Temporary B-tree');
    expect(temp.warnings).toContain('filesort');

    const search = plan.roots[1];
    expect(search.operation).toBe('Index search');
    expect(search.object).toBe('orders');
    expect(search.index).toBe('idx_user');
    expect(search.indexCondition).toBe('user_id=?');
    expect(search.filter).toBeUndefined();
    expect(search.warnings).toEqual([]);
  });

  it('normalizes coroutines, covering indexes and primary-key lookups', () => {
    const plan = planOf(parseSqliteExplain(fixture('sqlite-nested.json')));
    const root = plan.roots[0];

    expect(root.operation).toBe('Coroutine');
    expect(root.object).toBe('2');
    expect(root.children).toHaveLength(3);
    expect(root.children[0].operation).toBe('Table scan');
    expect(root.children[1].operation).toBe('Covering index search');
    expect(root.children[1].index).toBe('idx_u');
    expect(root.children[2].operation).toBe('Primary key lookup');
    expect(root.children[2].index).toBe('INTEGER PRIMARY KEY');
  });

  it('does not flag constant rows or index-ordered scans', () => {
    expect(single('SCAN CONSTANT ROW').roots[0]).toMatchObject({ operation: 'Constant row', warnings: [] });

    const covering = single('SCAN t USING COVERING INDEX idx_t').roots[0];
    expect(covering).toMatchObject({ operation: 'Covering index scan', object: 't', index: 'idx_t', warnings: [] });

    const ordered = single('SCAN t USING INDEX idx_t').roots[0];
    expect(ordered).toMatchObject({ operation: 'Index scan', index: 'idx_t', warnings: [] });
  });

  it('strips the legacy TABLE prefix from older SQLite output', () => {
    expect(single('SCAN TABLE users').roots[0]).toMatchObject({ operation: 'Table scan', object: 'users' });
    expect(single('SEARCH TABLE orders USING INDEX idx_user (user_id=?)').roots[0]).toMatchObject({
      operation: 'Index search',
      object: 'orders',
      index: 'idx_user',
    });
  });

  it('accepts a rows wrapper or a JSON string', () => {
    const rows = fixture('sqlite-basic.json');
    expect(planOf(parseSqliteExplain({ rows })).roots).toHaveLength(2);
    expect(planOf(parseSqliteExplain(JSON.stringify(rows))).roots).toHaveLength(2);
  });

  it('preserves unknown detail text instead of dropping it', () => {
    expect(single('SOMETHING NEW').roots[0].operation).toBe('SOMETHING NEW');
  });

  it('returns a fallback result for an unknown shape', () => {
    const raw = { unexpected: true };
    const result = parseSqliteExplain(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.dialect).toBe('sqlite');
      expect(result.error).toContain('rows');
      expect(result.raw).toBe(raw);
    }
  });
});