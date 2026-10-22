import { describe, expect, it } from 'vitest';
import { formatPlanText } from '../src/index.js';
import type { ExplainPlan, ExplainPlanNode } from '../src/types.js';

function node(id: string, overrides: Partial<ExplainPlanNode> = {}): ExplainPlanNode {
  return { id, operation: 'Op', warnings: [], children: [], ...overrides };
}

function plan(roots: ExplainPlanNode[], warnings: ExplainPlan['warnings'] = []): ExplainPlan {
  return { dialect: 'postgres', roots, warnings, raw: null };
}

describe('formatPlanText', () => {
  it('renders an indented tree with node details and warnings', () => {
    const text = formatPlanText(plan([
      node('1', {
        operation: 'Nested Loop',
        warnings: ['nestedLoop'],
        children: [
          node('2', { operation: 'Seq Scan', object: 'orders', estimatedRows: 5000, estimatedCost: 20, filter: "(status = 'paid')", warnings: ['fullTableScan'] }),
          node('3', { operation: 'Index Scan', object: 'users', index: 'users_pkey', indexCondition: '(id = orders.user_id)' }),
        ],
      }),
    ], ['nestedLoop', 'fullTableScan']));

    expect(text.split('\n')).toEqual([
      'Plan warnings: nestedLoop, fullTableScan',
      '- Nested Loop [warnings: nestedLoop]',
      "  - Seq Scan on orders rows=5000 cost=20 filter=(status = 'paid') [warnings: fullTableScan]",
      '  - Index Scan on users index=users_pkey indexCond=(id = orders.user_id)',
    ]);
  });

  it('includes actual metrics when present', () => {
    const text = formatPlanText(plan([node('1', { actualRows: 10, actualTimeMs: 1.5, loops: 2, joinCondition: '(a = b)' })]));
    expect(text).toBe('- Op actualRows=10 timeMs=1.5 loops=2 joinCond=(a = b)');
  });

  it('truncates by node count and reports omitted nodes', () => {
    const children = Array.from({ length: 5 }, (_, i) => node(`c${i}`));
    const text = formatPlanText(plan([node('root', { children })]), { maxNodes: 3 });
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toBe('… (3 more node(s) omitted)');
  });

  it('truncates by character budget', () => {
    const children = Array.from({ length: 50 }, (_, i) => node(`c${i}`, { filter: 'x'.repeat(40) }));
    const text = formatPlanText(plan([node('root', { children })]), { maxChars: 300 });
    expect(text.length).toBeLessThan(400);
    expect(text).toMatch(/more node\(s\) omitted\)$/);
  });

  it('renders an empty plan as an empty string', () => {
    expect(formatPlanText(plan([]))).toBe('');
  });
});