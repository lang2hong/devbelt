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
/**
 * Operation names emitted by the parsers → i18n key suffix (`wv.explain.op.*`).
 * MySQL JSON / TREE, SQLite EQP and the common PostgreSQL node types.
 */
export const OPERATION_LABEL_KEYS: Record<string, string> = {
  'Query block': 'queryBlock',
  'Query specification': 'querySpecification',
  'Table access': 'tableAccess',
  'Table scan': 'tableScan',
  'Index scan': 'indexScan',
  'Covering index scan': 'coveringIndexScan',
  'Index range scan': 'indexRangeScan',
  'Index lookup': 'indexLookup',
  'Index lookup (or null)': 'indexLookupOrNull',
  'Index search': 'indexSearch',
  'Covering index search': 'coveringIndexSearch',
  'Primary key lookup': 'primaryKeyLookup',
  'Index merge': 'indexMerge',
  'Index subquery': 'indexSubquery',
  'Full-text search': 'fullTextSearch',
  'Nested loop join': 'nestedLoopJoin',
  'Hash join': 'hashJoin',
  'Join item': 'joinItem',
  'Sort': 'sort',
  'Group by': 'groupBy',
  'Distinct': 'distinct',
  'Union': 'union',
  'Window': 'window',
  'Materialized subquery': 'materializedSubquery',
  'Subquery': 'subquery',
  'List subquery': 'listSubquery',
  'Compound query': 'compoundQuery',
  'Constant row': 'constantRow',
  'Coroutine': 'coroutine',
  'Merge': 'merge',
  'Materialize': 'materialize',
  'Temporary B-tree': 'tempBtree',
  'Plan step': 'planStep',
  'Filter': 'filter',
  'Limit': 'limit',
  'Aggregate': 'aggregate',
  'Aggregate using temporary table': 'aggregateTemp',
  'Group aggregate': 'groupAggregate',
  'Stream results': 'streamResults',
  // PostgreSQL node types
  'Seq Scan': 'tableScan',
  'Index Scan': 'indexScan',
  'Index Only Scan': 'coveringIndexScan',
  'Bitmap Heap Scan': 'bitmapHeapScan',
  'Bitmap Index Scan': 'bitmapIndexScan',
  'Nested Loop': 'nestedLoopJoin',
  'Hash Join': 'hashJoin',
  'Merge Join': 'mergeJoin',
  'Hash': 'hash',
  'Incremental Sort': 'incrementalSort',
  'Result': 'result',
  'Append': 'append',
  'Gather': 'gather',
  'Gather Merge': 'gatherMerge',
  'Subquery Scan': 'subqueryScan',
  'CTE Scan': 'cteScan',
  'Function Scan': 'functionScan',
  'Values Scan': 'valuesScan',
  'Unique': 'unique',
  'WindowAgg': 'window',
  'Memoize': 'memoize',
  'SetOp': 'setOp',
  'Group': 'groupBy',
  'LockRows': 'lockRows',
};

/**
 * Localized operation name. Unknown names are shown as reported by the engine;
 * `Head: detail` / `Head (detail)` forms translate the head and keep the detail.
 */
export function operationLabel(operation: string, t: (key: string) => string): string {
  const exact = OPERATION_LABEL_KEYS[operation];
  if (exact) return t(`wv.explain.op.${exact}`);
  const m = /^([^:(]+?)(\s*[:(].*)$/.exec(operation);
  if (m) {
    const head = OPERATION_LABEL_KEYS[m[1]!.trim()];
    if (head) return `${t(`wv.explain.op.${head}`)}${m[2]}`;
  }
  return operation;
}

/** Plain-language explanation of each warning (`wv.explain.warningHelp.*`). */
export const WARNING_HELP_KEYS: Record<ExplainWarning, string> = {
  fullTableScan: 'wv.explain.warningHelp.fullTableScan',
  filesort: 'wv.explain.warningHelp.filesort',
  temporaryTable: 'wv.explain.warningHelp.temporaryTable',
  highCost: 'wv.explain.warningHelp.highCost',
  nestedLoop: 'wv.explain.warningHelp.nestedLoop',
  missingIndex: 'wv.explain.warningHelp.missingIndex',
};

/**
 * A full scan without any condition on that table is what the query asked
 * for (read every row); only a filtered full scan points at a missing index.
 */
export function warningSeverity(warning: ExplainWarning, node: ExplainPlanNode): 'warn' | 'info' {
  if (warning === 'fullTableScan' && !node.filter) return 'info';
  if (warning === 'highCost') return 'info';
  return 'warn';
}

export interface PlanTableRow {
  node: ExplainPlanNode;
  depth: number;
}

/** Plan steps worth a table row: wrapper steps that carry no information are skipped. */
export function planTableRows(roots: readonly ExplainPlanNode[]): PlanTableRow[] {
  const out: PlanTableRow[] = [];
  const walk = (nodes: readonly ExplainPlanNode[], depth: number): void => {
    for (const node of nodes) {
      const informative = node.object !== undefined
        || node.index !== undefined
        || node.estimatedRows !== undefined
        || node.actualRows !== undefined
        || node.warnings.length > 0;
      if (informative) out.push({ node, depth });
      walk(node.children, informative ? depth + 1 : depth);
    }
  };
  walk(roots, 0);
  return out;
}

export function planHasActuals(roots: readonly ExplainPlanNode[]): boolean {
  return roots.some((node) => node.actualRows !== undefined || planHasActuals(node.children));
}

export interface SummaryItem {
  level: 'ok' | 'info' | 'warn';
  key: string;
  vars?: Record<string, string | number>;
}

function walkNodes(roots: readonly ExplainPlanNode[], visit: (node: ExplainPlanNode) => void): void {
  for (const node of roots) {
    visit(node);
    walkNodes(node.children, visit);
  }
}

function allNodes(roots: readonly ExplainPlanNode[]): ExplainPlanNode[] {
  const out: ExplainPlanNode[] = [];
  walkNodes(roots, (node) => out.push(node));
  return out;
}

/** Time spent in a step across all loops (MySQL/PostgreSQL report per-loop time). */
function totalTime(node: ExplainPlanNode): number | undefined {
  return node.actualTimeMs === undefined ? undefined : node.actualTimeMs * (node.loops ?? 1);
}

/**
 * The one or two sentences shown above the table, most important first.
 * Each item is an i18n key plus variables; the estimate/executed state is
 * shown by the mode badge, not repeated here.
 */
export function buildPlanSummary(
  plan: { roots: readonly ExplainPlanNode[]; executionTimeMs?: number },
  options: { analyzed: boolean; suggestionCount: number },
): SummaryItem[] {
  const warn: SummaryItem[] = [];
  const info: SummaryItem[] = [];
  const rows = (n: ExplainPlanNode): string => formatNumber(n.actualRows ?? n.estimatedRows);
  const seen = new Set<string>();
  const push = (list: SummaryItem[], item: SummaryItem): void => {
    const id = `${item.key}:${JSON.stringify(item.vars ?? {})}`;
    if (seen.has(id)) return;
    seen.add(id);
    list.push(item);
  };

  walkNodes(plan.roots, (node) => {
    const table = node.object ?? '?';
    if (node.warnings.includes('fullTableScan')) {
      if (node.filter) push(warn, { level: 'warn', key: 'wv.explain.summary.scanFiltered', vars: { table, rows: rows(node) } });
      else push(info, { level: 'info', key: 'wv.explain.summary.scanAll', vars: { table, rows: rows(node) } });
    }
    if (node.warnings.includes('filesort')) push(warn, { level: 'warn', key: 'wv.explain.summary.filesort' });
    if (node.warnings.includes('temporaryTable')) push(warn, { level: 'warn', key: 'wv.explain.summary.temporaryTable' });
    if (node.warnings.includes('nestedLoop')) push(warn, { level: 'warn', key: 'wv.explain.summary.nestedLoop' });
    // A ≥10x row misestimate on a non-trivial step usually means stale statistics.
    if (options.analyzed && node.estimatedRows !== undefined && node.actualRows !== undefined) {
      const est = Math.max(node.estimatedRows, 1);
      const act = Math.max(node.actualRows, 1);
      if (Math.max(est, act) >= 100 && (est / act >= 10 || act / est >= 10)) {
        push(info, {
          level: 'info',
          key: 'wv.explain.summary.misestimate',
          vars: { step: node.object ?? node.operation, est: formatNumber(node.estimatedRows), actual: formatNumber(node.actualRows) },
        });
      }
    }
  });

  const head: SummaryItem[] = [];
  if (options.analyzed) {
    let slowest: ExplainPlanNode | undefined;
    walkNodes(plan.roots, (node) => {
      if (node.object === undefined) return;
      if ((totalTime(node) ?? -1) > (slowest ? totalTime(slowest) ?? -1 : -1)) slowest = node;
    });
    if (slowest && totalTime(slowest) !== undefined) {
      head.push({ level: 'info', key: 'wv.explain.summary.slowest', vars: { table: slowest.object!, ms: totalTime(slowest)!.toFixed(3) } });
    }
  }

  const tail: SummaryItem[] = [];
  if (options.suggestionCount > 0) tail.push({ level: 'info', key: 'wv.explain.summary.seeSuggestions', vars: { n: options.suggestionCount } });
  if (warn.length === 0 && info.length === 0) tail.unshift({ level: 'ok', key: 'wv.explain.summary.noProblem' });
  return [...warn, ...head, ...info, ...tail];
}

// ─────────────────────────── plan table (grid) ───────────────────────────

export type GridCellKind = 'text' | 'num' | 'code' | 'op';

export interface GridColumn {
  key: string;
  /** i18n key, or the engine's own column name when `literal`. */
  label: string;
  literal?: boolean;
  kind: GridCellKind;
}

export interface GridRow {
  cells: Record<string, string>;
  /** Indentation level of the first column (plan-node tables). */
  depth: number;
  /** `warn` rows are highlighted; `info` rows only carry a grey note. */
  level?: 'warn' | 'info';
  /** i18n keys of the notes shown in the last column. */
  notes: string[];
  /** Hover text for abbreviated cells, by column key. */
  titles: Record<string, string>;
}

export interface PlanGrid {
  /**
   * classic: MySQL traditional EXPLAIN rows · derived: the same columns built
   * from EXPLAIN FORMAT=JSON · steps: normalized steps (MySQL EXPLAIN ANALYZE) ·
   * postgres / sqlite: one row per engine plan row · flat: legacy fallback rows.
   */
  kind: 'classic' | 'derived' | 'steps' | 'postgres' | 'sqlite' | 'flat';
  columns: GridColumn[];
  rows: GridRow[];
  /** Plan-level figures (i18n label key → value). */
  figures: Array<{ key: string; value: string }>;
}

/** Same threshold as the parsers' DEFAULT_LARGE_SCAN_ROWS: small full scans are often optimal. */
const LARGE_SCAN_ROWS = 1000;

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function cell(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'boolean') return value ? '✓' : '';
  if (typeof value === 'number') return formatNumber(value, Number.isInteger(value) ? 0 : 2);
  if (Array.isArray(value)) return value.map((v) => cell(v)).join(',');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Numeric strings ("283.15", "100.00") formatted like numbers; anything else verbatim. */
function numCell(value: unknown): string {
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value);
    return formatNumber(n, value.includes('.') ? 2 : 0);
  }
  return cell(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Drop columns that are empty in every row (`keep` columns always stay). */
function compact(columns: GridColumn[], rows: GridRow[], keep: readonly string[] = []): GridColumn[] {
  return columns.filter((c) => keep.includes(c.key) || rows.some((r) => r.cells[c.key]));
}

const CLASSIC_KEYS = ['id', 'select_type', 'table', 'partitions', 'type', 'possible_keys', 'key', 'key_len', 'ref', 'rows', 'filtered', 'Extra'] as const;
const CLASSIC_NUMERIC = new Set(['id', 'key_len', 'rows', 'filtered']);
const CLASSIC_ALWAYS = ['id', 'select_type', 'table', 'type', 'possible_keys', 'key', 'key_len', 'ref', 'rows', 'filtered', 'Extra'];

/** Highlight rules for one classic MySQL EXPLAIN row. */
export function classicRowFlags(type: string, rows: number | undefined, extra: string): Pick<GridRow, 'level' | 'notes'> {
  const notes: string[] = [];
  let level: GridRow['level'];
  const where = /\busing where\b/i.test(extra);
  if (type.toUpperCase() === 'ALL' && (rows === undefined || rows >= LARGE_SCAN_ROWS)) {
    if (where) { level = 'warn'; notes.push('wv.explain.note.scanFiltered'); }
    else { level = 'info'; notes.push('wv.explain.note.scanAll'); }
  }
  if (/\busing filesort\b/i.test(extra)) { level = 'warn'; notes.push('wv.explain.note.filesort'); }
  if (/\busing temporary\b/i.test(extra)) { level = 'warn'; notes.push('wv.explain.note.temporary'); }
  return { ...(level ? { level } : {}), notes };
}

function classicGrid(rows: ReadonlyArray<Record<string, unknown>>, kind: 'classic' | 'derived', figures: PlanGrid['figures']): PlanGrid {
  const gridRows: GridRow[] = rows.map((row) => {
    const cells: Record<string, string> = {};
    for (const key of CLASSIC_KEYS) {
      cells[key] = CLASSIC_NUMERIC.has(key) ? numCell(row[key]) : cell(row[key]);
    }
    if (cells.filtered) cells.filtered = `${cells.filtered}%`;
    const flags = classicRowFlags(cells.type, toNumber(row.rows), cells.Extra);
    const titles: Record<string, string> = cells.Extra.length > 40 ? { Extra: cells.Extra } : {};
    return { cells, depth: 0, ...flags, titles };
  });
  const columns = CLASSIC_KEYS.map((key): GridColumn => ({ key, label: key, literal: true, kind: CLASSIC_NUMERIC.has(key) ? 'num' : 'text' }));
  return { kind, columns: compact(columns, gridRows, CLASSIC_ALWAYS), rows: gridRows, figures };
}

const EXTRA_ORDER = ['Using where', 'Using index', 'Using temporary', 'Using filesort'];

function mysqlBlock(raw: unknown): Record<string, unknown> | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  let top = rec(parseMaybeJson(first));
  if (top && 'EXPLAIN' in top) top = rec(parseMaybeJson(top.EXPLAIN));
  const block = rec(top?.query_block) ?? top;
  return block && ('select_id' in block || 'table' in block || 'nested_loop' in block || 'cost_info' in block) ? block : undefined;
}

function mysqlFigures(block: Record<string, unknown> | undefined): PlanGrid['figures'] {
  const cost = rec(block?.cost_info)?.query_cost;
  return cost !== undefined ? [{ key: 'wv.explain.figure.queryCost', value: numCell(cost) }] : [];
}

/**
 * Classic EXPLAIN columns rebuilt from EXPLAIN FORMAT=JSON, used when the
 * traditional EXPLAIN could not be read. `select_type` is not in the JSON and
 * `Extra` only covers the flags the JSON carries.
 */
export function deriveClassicRows(raw: unknown): Array<Record<string, unknown>> | undefined {
  const block = mysqlBlock(raw);
  if (!block) return undefined;
  const out: Array<Record<string, unknown>> = [];
  const SKIP = new Set(['cost_info', 'used_columns', 'table']);
  // Sort/temporary flags sit on the enclosing ordering/grouping operation;
  // the classic EXPLAIN prints them on the first table below it.
  const visit = (value: unknown, selectId: unknown, pending: string[]): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, selectId, pending);
      return;
    }
    const node = rec(value);
    if (!node) return;
    const id = node.select_id ?? selectId;
    if (node.using_temporary_table === true && !pending.includes('Using temporary')) pending.push('Using temporary');
    if (node.using_filesort === true && !pending.includes('Using filesort')) pending.push('Using filesort');
    const table = rec(node.table);
    if (table && typeof table.table_name === 'string') {
      const extra: string[] = [];
      if (typeof table.attached_condition === 'string') extra.push('Using where');
      if (table.using_index === true) extra.push('Using index');
      for (const flag of pending.splice(0)) if (!extra.includes(flag)) extra.push(flag);
      // Same order as MySQL prints them ("Using where; Using temporary; Using filesort").
      extra.sort((a, b) => EXTRA_ORDER.indexOf(a) - EXTRA_ORDER.indexOf(b));
      out.push({
        id,
        table: table.table_name,
        type: table.access_type,
        possible_keys: table.possible_keys,
        key: table.key,
        key_len: table.key_length,
        ref: table.ref,
        rows: table.rows_examined_per_scan,
        filtered: table.filtered,
        Extra: extra.join('; ') || null,
      });
      // Derived tables / subqueries attached to this table.
      for (const [key, child] of Object.entries(table)) {
        if (!SKIP.has(key) && child && typeof child === 'object') visit(child, id, []);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (!SKIP.has(key) && child && typeof child === 'object') visit(child, id, pending);
    }
  };
  visit(block, block.select_id, []);
  return out.length ? out : undefined;
}

const NOTE_BY_WARNING: Partial<Record<ExplainWarning, string>> = {
  filesort: 'wv.explain.note.filesort',
  temporaryTable: 'wv.explain.note.temporary',
  nestedLoop: 'wv.explain.note.nestedLoop',
};

/** Row level and notes from a normalized node's warnings. */
export function nodeRowFlags(node: ExplainPlanNode): Pick<GridRow, 'level' | 'notes'> {
  const notes: string[] = [];
  let level: GridRow['level'];
  for (const warning of node.warnings) {
    if (warning === 'fullTableScan') notes.push(node.filter ? 'wv.explain.note.scanFiltered' : 'wv.explain.note.scanAll');
    else if (NOTE_BY_WARNING[warning]) notes.push(NOTE_BY_WARNING[warning]!);
    else continue;
    if (warningSeverity(warning, node) === 'warn') level = 'warn';
    else if (!level) level = 'info';
  }
  return { ...(level ? { level } : {}), notes };
}

function stepsGrid(roots: readonly ExplainPlanNode[], figures: PlanGrid['figures']): PlanGrid {
  const rows: GridRow[] = planTableRows(roots).map(({ node, depth }) => ({
    cells: {
      step: node.operation,
      object: [node.object, node.index ? `(${node.index})` : ''].filter(Boolean).join(' '),
      estRows: formatNumber(node.estimatedRows),
      actualRows: node.actualRows === undefined ? '' : formatNumber(node.actualRows, Number.isInteger(node.actualRows) ? 0 : 2),
      actualTime: node.actualTimeMs === undefined ? '' : node.actualTimeMs.toFixed(3),
      loops: node.loops === undefined ? '' : formatNumber(node.loops),
    },
    depth,
    ...nodeRowFlags(node),
    titles: (node.filter ? { step: node.filter } : {}) as Record<string, string>,
  }));
  for (const row of rows) if (row.cells.estRows === '—') row.cells.estRows = '';
  const columns: GridColumn[] = [
    { key: 'step', label: 'wv.explain.col.operation', kind: 'op' },
    { key: 'object', label: 'wv.explain.col.object', kind: 'text' },
    { key: 'estRows', label: 'wv.explain.col.estRows', kind: 'num' },
    { key: 'actualRows', label: 'wv.explain.col.actualRows', kind: 'num' },
    { key: 'actualTime', label: 'wv.explain.col.actualTime', kind: 'num' },
    { key: 'loops', label: 'wv.explain.col.loops', kind: 'num' },
  ];
  return { kind: 'steps', columns: compact(columns, rows, ['step', 'object']), rows, figures };
}

const PG_COLUMNS: GridColumn[] = [
  { key: 'nodeType', label: 'wv.explain.rawCol.nodeType', kind: 'op' },
  { key: 'table', label: 'wv.explain.rawCol.table', kind: 'text' },
  { key: 'alias', label: 'wv.explain.rawCol.alias', kind: 'text' },
  { key: 'key', label: 'wv.explain.rawCol.key', kind: 'text' },
  { key: 'joinType', label: 'wv.explain.rawCol.joinType', kind: 'text' },
  { key: 'startupCost', label: 'wv.explain.rawCol.startupCost', kind: 'num' },
  { key: 'totalCost', label: 'wv.explain.rawCol.totalCost', kind: 'num' },
  { key: 'planRows', label: 'wv.explain.rawCol.planRows', kind: 'num' },
  { key: 'planWidth', label: 'wv.explain.rawCol.planWidth', kind: 'num' },
  { key: 'actualRows', label: 'wv.explain.rawCol.actualRows', kind: 'num' },
  { key: 'actualTime', label: 'wv.explain.rawCol.actualTime', kind: 'num' },
  { key: 'loops', label: 'wv.explain.rawCol.loops', kind: 'num' },
  { key: 'sharedHit', label: 'wv.explain.rawCol.sharedHit', kind: 'num' },
  { key: 'sharedRead', label: 'wv.explain.rawCol.sharedRead', kind: 'num' },
  { key: 'condition', label: 'wv.explain.rawCol.condition', kind: 'code' },
];

function pgGrid(raw: unknown, roots: readonly ExplainPlanNode[]): PlanGrid | undefined {
  let top = rec(parseMaybeJson(Array.isArray(raw) ? raw[0] : raw));
  if (top && 'QUERY PLAN' in top) {
    const inner = parseMaybeJson(top['QUERY PLAN']);
    top = rec(Array.isArray(inner) ? inner[0] : inner);
  }
  const root = rec(top?.Plan);
  if (!top || !root) return undefined;
  // The parser walks `Plans` in the same depth-first order: node i ↔ row i.
  const nodes = allNodes(roots);
  const rows: GridRow[] = [];
  const visit = (plan: Record<string, unknown>, depth: number): void => {
    const conditions = ['Index Cond', 'Hash Cond', 'Merge Cond', 'Filter', 'Join Filter', 'Recheck Cond']
      .filter((k) => typeof plan[k] === 'string')
      .map((k) => `${k}: ${plan[k] as string}`);
    const node = nodes[rows.length];
    rows.push({
      cells: {
        nodeType: cell(plan['Node Type']),
        table: cell(plan['Relation Name'] ?? plan['CTE Name'] ?? plan['Function Name']),
        alias: plan.Alias !== plan['Relation Name'] ? cell(plan.Alias) : '',
        key: cell(plan['Index Name']),
        joinType: cell(plan['Join Type']),
        startupCost: numCell(plan['Startup Cost']),
        totalCost: numCell(plan['Total Cost']),
        planRows: numCell(plan['Plan Rows']),
        planWidth: numCell(plan['Plan Width']),
        actualRows: numCell(plan['Actual Rows']),
        actualTime: numCell(plan['Actual Total Time']),
        loops: numCell(plan['Actual Loops']),
        sharedHit: numCell(plan['Shared Hit Blocks']),
        sharedRead: numCell(plan['Shared Read Blocks']),
        condition: conditions.join('; '),
      },
      depth,
      ...(node ? nodeRowFlags(node) : { notes: [] }),
      titles: conditions.length ? { condition: conditions.join('\n') } : {},
    });
    for (const child of Array.isArray(plan.Plans) ? plan.Plans : []) {
      const r = rec(child);
      if (r) visit(r, depth + 1);
    }
  };
  visit(root, 0);
  if (rows.length !== nodes.length) for (const row of rows) { delete row.level; row.notes = []; }

  const figures: PlanGrid['figures'] = [];
  if (top['Planning Time'] !== undefined) figures.push({ key: 'wv.explain.figure.planningTime', value: `${numCell(top['Planning Time'])} ms` });
  if (top['Execution Time'] !== undefined) figures.push({ key: 'wv.explain.figure.executionTime', value: `${numCell(top['Execution Time'])} ms` });
  return { kind: 'postgres', columns: compact(PG_COLUMNS, rows, ['nodeType']), rows, figures };
}

function sqliteGrid(raw: unknown): PlanGrid | undefined {
  const list = Array.isArray(raw) ? raw : rec(raw)?.rows;
  if (!Array.isArray(list)) return undefined;
  const rows: GridRow[] = list
    .map(rec)
    .filter((r): r is Record<string, unknown> => !!r && 'detail' in r)
    .map((r) => {
      const detail = cell(r.detail);
      const notes: string[] = [];
      let level: GridRow['level'];
      if (/^SCAN\s/i.test(detail) && !/\bUSING\s+(?:COVERING\s+)?INDEX\b/i.test(detail) && !/CONSTANT ROW/i.test(detail)) {
        level = 'info';
        notes.push('wv.explain.note.sqliteScan');
      }
      if (/^USE TEMP B-TREE/i.test(detail)) {
        level = 'warn';
        notes.push(/ORDER BY/i.test(detail) ? 'wv.explain.note.filesort' : 'wv.explain.note.temporary');
      }
      return { cells: { id: cell(r.id), parent: cell(r.parent), detail }, depth: 0, ...(level ? { level } : {}), notes, titles: {} };
    });
  if (rows.length === 0) return undefined;
  return {
    kind: 'sqlite',
    columns: [
      { key: 'id', label: 'id', literal: true, kind: 'num' },
      { key: 'parent', label: 'parent', literal: true, kind: 'num' },
      { key: 'detail', label: 'detail', literal: true, kind: 'code' },
    ],
    rows,
    figures: [],
  };
}

/** Legacy fallback rows are already flat records: show them with the engine's own column names. */
function flatGrid(rows: unknown): PlanGrid | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const records = rows.map(rec);
  if (records.some((r) => !r)) return undefined;
  if (records.some((r) => Object.values(r!).some((v) => v !== null && typeof v === 'object'))) return undefined;
  const keys = [...new Set(records.flatMap((r) => Object.keys(r!)))];
  if (keys.length === 0) return undefined;
  if (keys.includes('select_type') && keys.includes('Extra')) return classicGrid(records as Array<Record<string, unknown>>, 'classic', []);
  return {
    kind: 'flat',
    columns: keys.map((key) => ({ key, label: key, literal: true, kind: 'text' as const })),
    rows: records.map((r) => ({ cells: Object.fromEntries(keys.map((k) => [k, cell(r![k])])), depth: 0, notes: [], titles: {} })),
    figures: [],
  };
}

export interface PlanGridInput {
  plan: { dialect: 'mysql' | 'postgres' | 'sqlite'; roots: readonly ExplainPlanNode[]; raw: unknown } | null;
  classicRows?: ReadonlyArray<Record<string, unknown>>;
  fallback?: { rows: unknown[] };
}

/**
 * The default "Table" tab for one statement. Built only from data already in
 * the payload; nothing here talks to the database.
 */
export function buildPlanGrid(view: PlanGridInput, analyzed: boolean): PlanGrid | undefined {
  const plan = view.plan;
  if (!plan) return flatGrid(view.fallback?.rows);
  if (plan.dialect === 'mysql') {
    const block = mysqlBlock(plan.raw);
    if (!analyzed && view.classicRows?.length) return classicGrid(view.classicRows, 'classic', mysqlFigures(block));
    const derived = !analyzed ? deriveClassicRows(plan.raw) : undefined;
    if (derived) return classicGrid(derived, 'derived', mysqlFigures(block));
    return stepsGrid(plan.roots, []);
  }
  if (plan.dialect === 'postgres') return pgGrid(plan.raw, plan.roots) ?? stepsGrid(plan.roots, []);
  return sqliteGrid(plan.raw) ?? stepsGrid(plan.roots, []);
}

/** i18n keys a grid can use as column labels (for the catalog completeness test). */
export const GRID_LABEL_KEYS: readonly string[] = [
  ...PG_COLUMNS.map((c) => c.label),
  'wv.explain.col.operation', 'wv.explain.col.object', 'wv.explain.col.estRows',
  'wv.explain.col.actualRows', 'wv.explain.col.actualTime', 'wv.explain.col.loops',
];
