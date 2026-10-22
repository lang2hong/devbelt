import {
  asArray,
  asRecord,
  failure,
  finalizePlan,
  makeNode,
  parseJson,
  str,
} from './normalize.js';
import type { ExplainParseOptions, ExplainParseResult, ExplainPlanNode, ExplainWarning } from './types.js';

interface SqliteRow {
  id: string;
  parent?: string;
  index: number;
  detail: string;
  row: Record<string, unknown>;
}

/**
 * Parse SQLite `EXPLAIN QUERY PLAN` rows.
 *
 * SQLite returns a flat row set (`id`, `parent`, `notused`, `detail`); this
 * rebuilds the tree and normalizes the most common detail strings. Unknown
 * detail text is preserved verbatim instead of being dropped.
 */
export function parseSqliteExplain(raw: unknown, options: ExplainParseOptions = {}): ExplainParseResult {
  try {
    const rows = unwrapSqlite(raw);
    const roots = buildSqliteTree(rows);
    return { ok: true, plan: finalizePlan('sqlite', roots, raw, options) };
  } catch (error) {
    return failure('sqlite', raw, error);
  }
}

function unwrapSqlite(raw: unknown): SqliteRow[] {
  const parsed = parseJson(raw);
  if (Array.isArray(parsed)) return normalizeRows(parsed);
  const record = asRecord(parsed);
  if (!record) throw new Error('SQLite EXPLAIN: expected rows');
  const rows = asArray(record.rows);
  if (rows) return normalizeRows(rows);
  if ('detail' in record) return normalizeRows([record]);
  throw new Error('SQLite EXPLAIN: expected an array of rows');
}

function normalizeRows(values: unknown[]): SqliteRow[] {
  return values.flatMap((value, index) => {
    const row = asRecord(value);
    if (!row) return [];
    const rawId = row.id;
    const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : String(index);
    const rawParent = row.parent;
    const parent =
      typeof rawParent === 'string' || typeof rawParent === 'number'
        ? String(rawParent)
        : undefined;
    return [{
      id,
      ...(parent !== undefined && parent !== '0' && parent !== 'null' ? { parent } : {}),
      index,
      detail: str(row.detail) ?? '',
      row,
    }];
  });
}

function buildSqliteTree(rows: SqliteRow[]): ExplainPlanNode[] {
  const byId = new Map<string, { row: SqliteRow; node: ExplainPlanNode }>();
  for (const row of rows) {
    byId.set(row.id, { row, node: buildSqliteNode(row) });
  }

  const roots: ExplainPlanNode[] = [];
  for (const row of rows) {
    const entry = byId.get(row.id);
    if (!entry) continue;
    const parent = row.parent ? byId.get(row.parent) : undefined;
    if (parent && parent.row.id !== row.id) {
      parent.node.children.push(entry.node);
    } else {
      roots.push(entry.node);
    }
  }

  // A malformed parent chain can leave every row orphaned; showing them is
  // better than returning an empty tree.
  return roots.length > 0 ? roots : rows.map((row) => buildSqliteNode(row));
}

function buildSqliteNode(row: SqliteRow): ExplainPlanNode {
  const detail = row.detail.trim();
  const id = `sqlite:${row.id}`;
  const warnings: ExplainWarning[] = [];

  const temp = /^USE TEMP B-TREE FOR (.+)$/i.exec(detail);
  if (temp) {
    const purpose = temp[1].toUpperCase();
    if (purpose.includes('ORDER BY')) warnings.push('filesort');
    else warnings.push('temporaryTable');
    return makeNode(id, {
      operation: `Temporary B-tree (${temp[1]})`,
      warnings,
      children: [],
    });
  }

  const scan = /^SCAN\s+(.+?)(?:\s+USING\s+(?:COVERING\s+)?INDEX\s+([^\s(]+))?(?:\s+\(.*\))?$/i.exec(detail);
  if (scan) {
    warnings.push('fullTableScan');
    return makeNode(id, {
      operation: scan[2] ? 'Index scan' : 'Table scan',
      ...(scan[1] !== undefined ? { object: scan[1] } : {}),
      ...(scan[2] !== undefined ? { index: scan[2] } : {}),
      warnings,
      children: [],
    });
  }

  const search = /^SEARCH\s+(.+?)\s+USING\s+(.+?)(?:\s+\((.*)\))?$/i.exec(detail);
  if (search) {
    const table = search[1];
    const using = search[2];
    const condition = search[3];
    const covering = /^COVERING\s+INDEX\s+/i.test(using);
    const index = using.replace(/^(?:COVERING\s+)?INDEX\s+/i, '').replace(/^INTEGER\s+PRIMARY\s+KEY$/i, 'INTEGER PRIMARY KEY');
    return makeNode(id, {
      operation: /^INTEGER\s+PRIMARY\s+KEY$/i.test(using)
        ? 'Primary key lookup'
        : covering
          ? 'Covering index search'
          : 'Index search',
      ...(table !== undefined ? { object: table } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(condition !== undefined ? { filter: condition } : {}),
      children: [],
    });
  }

  const coroutine = /^CO-ROUTINE\s+(.+)$/i.exec(detail);
  if (coroutine) {
    return makeNode(id, { operation: 'Coroutine', object: coroutine[1], warnings, children: [] });
  }
  const subquery = /^SUBQUERY\s+(.+)$/i.exec(detail);
  if (subquery) {
    return makeNode(id, { operation: 'Subquery', object: subquery[1], warnings, children: [] });
  }
  if (/^COMPOUND QUERY$/i.test(detail)) {
    return makeNode(id, { operation: 'Compound query', warnings, children: [] });
  }
  if (/^LIST SUBQUERY/i.test(detail)) {
    return makeNode(id, { operation: 'List subquery', warnings, children: [] });
  }
  if (/^MERGE/i.test(detail)) {
    return makeNode(id, { operation: 'Merge', warnings, children: [] });
  }
  if (/^MATERIALIZE/i.test(detail)) {
    return makeNode(id, { operation: 'Materialize', warnings, children: [] });
  }

  return makeNode(id, {
    operation: detail || 'Plan step',
    warnings,
    children: [],
  });
}