import { failure, finalizePlan, isLargeScan, largeScanRows, makeNode, num } from './normalize.js';
import type { ExplainParseOptions, ExplainParseResult, ExplainPlanNode } from './types.js';

const LINE = /^(\s*)->\s*(.*)$/;
const ACTUAL = /\s*\(actual time=(\d[\d.eE+-]*?)\.\.(\d[\d.eE+-]*) rows=(\d[\d.eE+-]*) loops=(\d+)\)\s*$/;
const NEVER = /\s*\(never executed\)\s*$/;
const COST = /\s*\(cost=(\d[\d.eE+-]*?)(?:\.\.(\d[\d.eE+-]*))? rows=(\d[\d.eE+-]*)\)\s*$/;

/**
 * Parse MySQL 8 `EXPLAIN ANALYZE` output (TREE text).
 *
 * Every step is one `-> <step>  (cost=… rows=…) (actual time=a..b rows=… loops=…)`
 * line, nested by indentation. Access steps are mapped onto the operation names
 * the JSON parser uses (`Table scan`, `Index lookup` …); other steps keep their
 * text (`Sort: …`, `Limit: …`) so nothing is hidden.
 *
 * Accepts the text itself or the mysql2 rows (`[{ EXPLAIN: '…' }]`).
 */
export function parseMysqlAnalyze(raw: unknown, options: ExplainParseOptions = {}): ExplainParseResult {
  try {
    const text = textOf(raw);
    const roots: ExplainPlanNode[] = [];
    const stack: Array<{ indent: number; node: ExplainPlanNode }> = [];
    let count = 0;

    for (const line of text.split(/\r?\n/)) {
      const match = LINE.exec(line);
      if (!match) {
        if (line.trim() && stack.length === 0) throw new Error('MySQL EXPLAIN ANALYZE: unexpected text before the first step');
        continue;
      }
      const indent = match[1].length;
      const node = buildStep(match[2], `mysql-analyze:${count++}`);
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1]?.node;
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push({ indent, node });
    }
    if (roots.length === 0) throw new Error('MySQL EXPLAIN ANALYZE: no plan steps found');

    for (const root of roots) annotate(root, undefined, options);
    const root = roots[0];
    return {
      ok: true,
      plan: finalizePlan('mysql', roots, text, options, {
        ...(root.actualTimeMs !== undefined ? { executionTimeMs: root.actualTimeMs * (root.loops ?? 1) } : {}),
      }),
    };
  } catch (error) {
    return failure('mysql', raw, error);
  }
}

function textOf(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows
    .map((row) => {
      if (typeof row === 'string') return row;
      if (row && typeof row === 'object') {
        const record = row as Record<string, unknown>;
        if (typeof record.EXPLAIN === 'string') return record.EXPLAIN;
        const values = Object.values(record);
        if (values.length === 1 && typeof values[0] === 'string') return values[0];
      }
      throw new Error('MySQL EXPLAIN ANALYZE: expected TREE text');
    })
    .join('\n');
}

function buildStep(text: string, id: string): ExplainPlanNode {
  let step = text.trim();
  let actual: { timeMs?: number; rows?: number; loops?: number } = {};
  const actualMatch = ACTUAL.exec(step);
  if (actualMatch) {
    actual = { timeMs: num(actualMatch[2]), rows: num(actualMatch[3]), loops: num(actualMatch[4]) };
    step = step.slice(0, actualMatch.index);
  } else if (NEVER.test(step)) {
    step = step.replace(NEVER, '');
  }
  let cost: number | undefined;
  let estimatedRows: number | undefined;
  const costMatch = COST.exec(step);
  if (costMatch) {
    cost = num(costMatch[2] ?? costMatch[1]);
    estimatedRows = num(costMatch[3]);
    step = step.slice(0, costMatch.index);
  }
  step = step.trim();

  return makeNode(id, {
    ...classify(step),
    ...(estimatedRows !== undefined ? { estimatedRows } : {}),
    ...(cost !== undefined ? { estimatedCost: cost } : {}),
    ...(actual.rows !== undefined ? { actualRows: actual.rows } : {}),
    ...(actual.timeMs !== undefined ? { actualTimeMs: actual.timeMs } : {}),
    ...(actual.loops !== undefined ? { loops: actual.loops } : {}),
  });
}

type StepFields = Pick<ExplainPlanNode, 'operation' | 'object' | 'index' | 'filter' | 'joinCondition' | 'indexCondition'>;

function classify(step: string): StepFields {
  let m: RegExpExecArray | null;
  if ((m = /^Table scan on (\S+)/i.exec(step))) {
    return { operation: 'Table scan', object: m[1] };
  }
  if ((m = /^(?:Single-row )?(?:covering )?index lookup on (\S+) using (\S+)(?: \((.*)\))?/i.exec(step))) {
    return { operation: 'Index lookup', object: m[1], index: m[2], ...(m[3] ? { indexCondition: m[3] } : {}) };
  }
  if ((m = /^(?:Covering )?index range scan on (\S+) using (\S+)(?: over \((.*)\))?/i.exec(step))) {
    return { operation: 'Index range scan', object: m[1], index: m[2], ...(m[3] ? { indexCondition: m[3] } : {}) };
  }
  if ((m = /^(?:Covering )?index scan on (\S+) using (\S+)/i.exec(step))) {
    return { operation: 'Index scan', object: m[1], index: m[2] };
  }
  if ((m = /^Filter: (.*)$/i.exec(step))) {
    return { operation: 'Filter', filter: m[1] };
  }
  if (/^Nested loop /i.test(step)) {
    return { operation: 'Nested loop join' };
  }
  if ((m = /^(?:Inner |Left |Outer |Anti |Semi )?hash join(?: \((.*)\))?/i.exec(step))) {
    return { operation: 'Hash join', ...(m[1] ? { joinCondition: m[1] } : {}) };
  }
  return { operation: step };
}

/** Second pass: needs the parent (a `Filter` step owns its child scan's condition). */
function annotate(node: ExplainPlanNode, parent: ExplainPlanNode | undefined, options: ExplainParseOptions): void {
  if (node.operation === 'Table scan' && parent?.operation === 'Filter' && parent.filter && node.filter === undefined) {
    node.filter = parent.filter;
  }
  for (const child of node.children) annotate(child, node, options);

  if (node.operation === 'Table scan' && node.object !== '<temporary>') {
    const rows = node.estimatedRows ?? node.actualRows;
    if (isLargeScan(rows, options)) {
      node.warnings.push('fullTableScan');
      if (node.filter && rows !== undefined) node.warnings.push('missingIndex');
    }
  }
  if (/^Aggregate using temporary table/i.test(node.operation) || /^Temporary table/i.test(node.operation)) {
    node.warnings.push('temporaryTable');
  }
  // In TREE output a Sort step only appears when MySQL really sorts; flag the large ones.
  if (/^Sort\b/i.test(node.operation)) {
    const rows = node.actualRows ?? node.estimatedRows;
    if (rows !== undefined && rows >= largeScanRows(options)) node.warnings.push('filesort');
  }
  if (node.operation === 'Nested loop join' && node.children.slice(1).some((child) => hasLargeScan(child))) {
    node.warnings.push('nestedLoop');
  }
}

function hasLargeScan(node: ExplainPlanNode): boolean {
  return node.warnings.includes('fullTableScan') || node.children.some(hasLargeScan);
}
