import {
  asArray,
  asRecord,
  bool,
  failure,
  finalizePlan,
  isRecord,
  makeNode,
  num,
  parseJson,
  str,
} from './normalize.js';
import type { ExplainParseOptions, ExplainParseResult, ExplainPlanNode, ExplainWarning } from './types.js';

const OPERATION_KEYS = [
  'nested_loop',
  'hash_join',
  'table',
  'ordering_operation',
  'grouping_operation',
  'duplicates_removal',
  'union_result',
  'query_specifications',
  'windowing',
  'materialized_from_subquery',
  'attached_subqueries',
  'optimized_away_subqueries',
  'select_list_subqueries',
  'having_subqueries',
  'order_by_subqueries',
  'group_by_subqueries',
] as const;

/**
 * Parse MySQL `EXPLAIN FORMAT=JSON` output.
 *
 * Accepts a mysql2 row (`{ EXPLAIN: '{"query_block":...}' }`), a bare JSON
 * string, or the parsed query block. Unknown shapes return `ok:false` with the
 * original input so callers can fall back to raw text.
 */
export function parseMysqlExplain(raw: unknown, options: ExplainParseOptions = {}): ExplainParseResult {
  try {
    const queryBlock = unwrapMysql(raw);
    const root = buildQueryBlock(queryBlock, 'mysql:0', options);
    return { ok: true, plan: finalizePlan('mysql', [root], raw, options) };
  } catch (error) {
    return failure('mysql', raw, error);
  }
}

function unwrapMysql(raw: unknown): Record<string, unknown> {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = parseJson(value);

  const record = asRecord(parsed);
  if (!record) throw new Error('MySQL EXPLAIN: expected a JSON object');

  if ('EXPLAIN' in record) {
    const inner = parseJson(record.EXPLAIN);
    const innerRecord = asRecord(inner);
    if (!innerRecord) throw new Error('MySQL EXPLAIN: EXPLAIN column is not a JSON object');
    return queryBlockOf(innerRecord);
  }
  return queryBlockOf(record);
}

function queryBlockOf(record: Record<string, unknown>): Record<string, unknown> {
  const block = asRecord(record.query_block);
  if (block) return block;
  if ('select_id' in record || 'table' in record || 'nested_loop' in record || 'cost_info' in record) {
    return record;
  }
  throw new Error('MySQL EXPLAIN: missing query_block');
}

function buildQueryBlock(block: Record<string, unknown>, id: string, options: ExplainParseOptions): ExplainPlanNode {
  const costInfo = asRecord(block.cost_info);
  const children = buildContainer(block, id, options);
  return makeNode(id, {
    operation: 'Query block',
    ...(num(costInfo?.query_cost) !== undefined ? { estimatedCost: num(costInfo?.query_cost) } : {}),
    children,
  });
}

function buildContainer(record: Record<string, unknown>, parentId: string, options: ExplainParseOptions): ExplainPlanNode[] {
  const children: ExplainPlanNode[] = [];
  for (const key of OPERATION_KEYS) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === undefined || value === null) continue;
    const built = buildOperation(key, value, `${parentId}.${children.length}`, options);
    children.push(...built);
  }
  return children;
}

function buildOperation(
  key: (typeof OPERATION_KEYS)[number] | string,
  value: unknown,
  id: string,
  options: ExplainParseOptions,
): ExplainPlanNode[] {
  switch (key) {
    case 'table': {
      const table = asRecord(value);
      return table ? [buildTable(table, id, options)] : [];
    }
    case 'nested_loop':
      return [buildNestedLoop(value, id, options)];
    case 'ordering_operation':
      return [buildSort(value, id, options)];
    case 'grouping_operation':
      return [buildGroup(value, id, options)];
    case 'duplicates_removal':
      return [buildDistinct(value, id, options)];
    case 'union_result':
      return [buildUnion(value, id, options)];
    case 'query_specifications':
      return buildQuerySpecifications(value, id, options);
    case 'windowing':
      return [buildWindow(value, id, options)];
    case 'hash_join':
      return [buildHashJoin(value, id, options)];
    case 'materialized_from_subquery':
      return [buildMaterialized(value, id, options)];
    case 'attached_subqueries':
    case 'optimized_away_subqueries':
    case 'select_list_subqueries':
    case 'having_subqueries':
    case 'order_by_subqueries':
    case 'group_by_subqueries':
      return buildSubqueries(value, id, options);
    default:
      return [];
  }
}

function buildTable(table: Record<string, unknown>, id: string, options: ExplainParseOptions): ExplainPlanNode {
  const access = str(table.access_type)?.toLowerCase();
  const key = str(table.key);
  const object = str(table.table_name) ?? str(table.alias);
  const filter = str(table.attached_condition);
  const costInfo = asRecord(table.cost_info);

  let operation = 'Table access';
  if (access === 'all') operation = 'Table scan';
  else if (access === 'index') operation = 'Index scan';
  else if (access === 'range') operation = 'Index range scan';
  else if (access === 'ref' || access === 'eq_ref' || access === 'const' || access === 'system') operation = 'Index lookup';
  else if (access === 'ref_or_null') operation = 'Index lookup (or null)';
  else if (access === 'index_merge') operation = 'Index merge';
  else if (access === 'fulltext') operation = 'Full-text search';
  else if (access === 'unique_subquery' || access === 'index_subquery') operation = 'Index subquery';

  const warnings: ExplainWarning[] = [];
  if (access === 'all') {
    warnings.push('fullTableScan');
    if (filter) warnings.push('missingIndex');
  }
  if (bool(table.using_filesort)) warnings.push('filesort');
  if (bool(table.using_temporary_table)) warnings.push('temporaryTable');
  if (str(table.using_join_buffer)) warnings.push('nestedLoop');

  return makeNode(id, {
    operation,
    ...(object !== undefined ? { object } : {}),
    ...(key !== undefined ? { index: key } : {}),
    ...(num(table.rows_examined_per_scan) !== undefined
      ? { estimatedRows: num(table.rows_examined_per_scan) }
      : num(table.rows_produced_per_join) !== undefined
        ? { estimatedRows: num(table.rows_produced_per_join) }
        : {}),
    ...(num(costInfo?.prefix_cost) !== undefined ? { estimatedCost: num(costInfo?.prefix_cost) } : {}),
    ...(filter !== undefined ? { filter } : {}),
    warnings,
    children: buildContainer(table, id, options),
  });
}

function buildNestedLoop(value: unknown, id: string, options: ExplainParseOptions): ExplainPlanNode {
  const items = asArray(value) ?? [];
  const children: ExplainPlanNode[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const childKeys = ['table', 'nested_loop', 'hash_join', 'ordering_operation', 'grouping_operation'] as const;
    let built = false;
    for (const key of childKeys) {
      if (!(key in record)) continue;
      const child = buildOperation(key, record[key], `${id}.${children.length}`, options);
      children.push(...child);
      built = true;
    }
    if (!built) {
      const child = buildGeneric(record, `${id}.${children.length}`, 'Join item', options);
      children.push(child);
    }
  }
  return makeNode(id, {
    operation: 'Nested loop join',
    warnings: ['nestedLoop'],
    children,
  });
}

function buildHashJoin(value: unknown, id: string, options: ExplainParseOptions): ExplainPlanNode {
  const record = asRecord(value) ?? {};
  return makeNode(id, {
    operation: 'Hash join',
    children: buildContainer(record, id, options),
  });
}

function buildSort(value: unknown, id: string, options: ExplainParseOptions): ExplainPlanNode {
  const record = asRecord(value) ?? {};
  const warnings: ExplainWarning[] = [];
  if (bool(record.using_filesort)) warnings.push('filesort');
  if (bool(record.using_temporary_table)) warnings.push('temporaryTable');
  return makeNode(id, {
    operation: 'Sort',
    warnings,
    children: buildContainer(record, id, options),
  });
}

function buildGroup(value: unknown, id: string, options: ExplainParseOptions): ExplainPlanNode {
  const record = asRecord(value) ?? {};
  const warnings: ExplainWarning[] = [];
  if (bool(record.using_temporary_table)) warnings.push('temporaryTable');
  return makeNode(id, {
    operation: 'Group by',
    warnings,
    children: buildContainer(record, id, options),
  });
}

function buildDistinct(value: unknown, id: string, options: ExplainParseOptions): ExplainPlanNode {
  const record = asRecord(value) ?? {};
  const warnings: ExplainWarning[] = [];
  if (bool(record.using_temporary_table)) warnings.push('temporaryTable');
  return makeNode(id, {
    operation: 'Distinct',
    warnings,
    children: buildContainer(record, id, options),
  });
}

function buildUnion(value: unknown, id: string, options: ExplainParseOptions): ExplainPlanNode {
  const record = asRecord(value) ?? {};
  const warnings: ExplainWarning[] = [];
  if (bool(record.using_temporary_table)) warnings.push('temporaryTable');
  const children = buildQuerySpecifications(record.query_specifications, id, options);
  return makeNode(id, { operation: 'Union', warnings, children });
}

function buildQuerySpecifications(value: unknown, id: string, options: ExplainParseOptions): ExplainPlanNode[] {
  const specs = asArray(value) ?? [];
  return specs.flatMap((spec, index) => {
    const record = asRecord(spec);
    if (!record) return [];
    const queryBlock = asRecord(record.query_block);
    if (queryBlock) return [buildQueryBlock(queryBlock, `${id}.${index}`, options)];
    return [buildGeneric(record, `${id}.${index}`, 'Query specification', options)];
  });
}

function buildWindow(value: unknown, id: string, options: ExplainParseOptions): ExplainPlanNode {
  const record = asRecord(value) ?? {};
  return makeNode(id, {
    operation: 'Window',
    children: buildContainer(record, id, options),
  });
}

function buildMaterialized(value: unknown, id: string, options: ExplainParseOptions): ExplainPlanNode {
  const record = asRecord(value) ?? {};
  const queryBlock = asRecord(record.query_block);
  const children = queryBlock
    ? [buildQueryBlock(queryBlock, `${id}.0`, options)]
    : buildContainer(record, id, options);
  return makeNode(id, {
    operation: 'Materialized subquery',
    children,
  });
}

function buildSubqueries(value: unknown, id: string, options: ExplainParseOptions): ExplainPlanNode[] {
  const items = asArray(value) ?? [];
  return items.flatMap((item, index) => {
    const record = asRecord(item);
    if (!record) return [];
    const queryBlock = asRecord(record.query_block);
    if (queryBlock) return [buildQueryBlock(queryBlock, `${id}.${index}`, options)];
    if (isRecord(record.table)) {
      return [buildTable(record.table, `${id}.${index}`, options)];
    }
    return [buildGeneric(record, `${id}.${index}`, 'Subquery', options)];
  });
}

function buildGeneric(
  record: Record<string, unknown>,
  id: string,
  operation: string,
  options: ExplainParseOptions,
): ExplainPlanNode {
  const costInfo = asRecord(record.cost_info);
  return makeNode(id, {
    operation,
    ...(str(record.table_name) !== undefined ? { object: str(record.table_name) } : {}),
    ...(num(costInfo?.prefix_cost) !== undefined ? { estimatedCost: num(costInfo?.prefix_cost) } : {}),
    children: buildContainer(record, id, options),
  });
}