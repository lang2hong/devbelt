import {
  asArray,
  asRecord,
  failure,
  finalizePlan,
  makeNode,
  num,
  parseJson,
  str,
} from './normalize.js';
import type { ExplainParseOptions, ExplainParseResult, ExplainPlanNode, ExplainWarning } from './types.js';

/**
 * Parse PostgreSQL `EXPLAIN (FORMAT JSON)` output.
 *
 * node-postgres returns the JSON column already parsed as an array:
 * `[{ Plan: {...}, "Planning Time": ..., "Execution Time": ... }]`.
 * A JSON string or a row wrapper is also accepted.
 */
export function parsePostgresExplain(raw: unknown, options: ExplainParseOptions = {}): ExplainParseResult {
  try {
    const { top, plan } = unwrapPostgres(raw);
    const root = buildPostgresNode(plan, 'pg:0', options);
    return {
      ok: true,
      plan: finalizePlan('postgres', [root], raw, options, {
        ...(num(top['Planning Time']) !== undefined ? { planningTimeMs: num(top['Planning Time']) } : {}),
        ...(num(top['Execution Time']) !== undefined ? { executionTimeMs: num(top['Execution Time']) } : {}),
      }),
    };
  } catch (error) {
    return failure('postgres', raw, error);
  }
}

function unwrapPostgres(raw: unknown): { top: Record<string, unknown>; plan: Record<string, unknown> } {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const parsed = parseJson(first);
  const record = asRecord(parsed);
  if (!record) throw new Error('PostgreSQL EXPLAIN: expected a JSON object');

  if ('QUERY PLAN' in record) {
    const inner = parseJson(record['QUERY PLAN']);
    const innerArray = asArray(inner);
    const innerFirst = innerArray ? innerArray[0] : inner;
    const innerRecord = asRecord(innerFirst);
    if (!innerRecord) throw new Error('PostgreSQL EXPLAIN: QUERY PLAN is not a JSON object');
    return unwrapPostgres(innerRecord);
  }

  const plan = asRecord(record.Plan);
  if (plan) return { top: record, plan };
  if (str(record['Node Type'])) return { top: record, plan: record };
  throw new Error('PostgreSQL EXPLAIN: missing Plan');
}

function buildPostgresNode(plan: Record<string, unknown>, id: string, options: ExplainParseOptions): ExplainPlanNode {
  const nodeType = str(plan['Node Type']) ?? 'Plan';
  const filter = str(plan.Filter) ?? str(plan['Join Filter']);
  const joinCondition = str(plan['Hash Cond']) ?? str(plan['Merge Cond']) ?? str(plan['Index Cond']);
  const object = str(plan['Relation Name']) ?? str(plan.Alias) ?? str(plan['CTE Name']);
  const index = str(plan['Index Name']);
  const warnings: ExplainWarning[] = [];

  if (nodeType === 'Seq Scan') {
    warnings.push('fullTableScan');
    if (filter) warnings.push('missingIndex');
  }
  if (nodeType === 'Sort' && str(plan['Sort Method'])?.toLowerCase().includes('external')) {
    warnings.push('filesort');
  }
  if (nodeType === 'Nested Loop') warnings.push('nestedLoop');

  const children = (asArray(plan.Plans) ?? [])
    .flatMap((child, index) => {
      const record = asRecord(child);
      return record ? [buildPostgresNode(record, `${id}.${index}`, options)] : [];
    });

  return makeNode(id, {
    operation: nodeType,
    ...(object !== undefined ? { object } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(num(plan['Plan Rows']) !== undefined ? { estimatedRows: num(plan['Plan Rows']) } : {}),
    ...(num(plan['Actual Rows']) !== undefined ? { actualRows: num(plan['Actual Rows']) } : {}),
    ...(num(plan['Total Cost']) !== undefined ? { estimatedCost: num(plan['Total Cost']) } : {}),
    ...(num(plan['Actual Total Time']) !== undefined ? { actualTimeMs: num(plan['Actual Total Time']) } : {}),
    ...(num(plan['Actual Loops']) !== undefined ? { loops: num(plan['Actual Loops']) } : {}),
    ...(filter !== undefined ? { filter } : {}),
    ...(joinCondition !== undefined ? { joinCondition } : {}),
    warnings,
    children,
  });
}