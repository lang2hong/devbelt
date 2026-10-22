import type { ExplainPlanNode, ExplainWarning } from '@devbelt/explain-core';

export interface ExplainRow {
  node: ExplainPlanNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/** Flatten a plan tree into rows according to the expanded-id set. */
export function flattenPlan(
  roots: readonly ExplainPlanNode[],
  expanded: ReadonlySet<string>,
): ExplainRow[] {
  const rows: ExplainRow[] = [];
  const walk = (nodes: readonly ExplainPlanNode[], depth: number): void => {
    for (const node of nodes) {
      rows.push({
        node,
        depth,
        hasChildren: node.children.length > 0,
        expanded: expanded.has(node.id),
      });
      if (node.children.length > 0 && expanded.has(node.id)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(roots, 0);
  return rows;
}

export function collectPlanIds(roots: readonly ExplainPlanNode[]): string[] {
  const ids: string[] = [];
  const walk = (nodes: readonly ExplainPlanNode[]): void => {
    for (const node of nodes) {
      ids.push(node.id);
      walk(node.children);
    }
  };
  walk(roots);
  return ids;
}

export function findPlanNode(roots: readonly ExplainPlanNode[], id: string | null): ExplainPlanNode | undefined {
  if (!id) return undefined;
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id) return node;
    stack.push(...node.children);
  }
  return undefined;
}

export const WARNING_LABEL_KEYS: Record<ExplainWarning, string> = {
  fullTableScan: 'wv.explain.warning.fullTableScan',
  filesort: 'wv.explain.warning.filesort',
  temporaryTable: 'wv.explain.warning.temporaryTable',
  highCost: 'wv.explain.warning.highCost',
  nestedLoop: 'wv.explain.warning.nestedLoop',
  missingIndex: 'wv.explain.warning.missingIndex',
};

export function warningClass(warning: ExplainWarning): string {
  return `warn-${warning}`;
}

export function formatNumber(value: number | undefined, digits = 0): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(3)} ms`;
}