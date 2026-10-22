import { DEFAULT_LARGE_SCAN_ROWS } from './types.js';
import type {
  ExplainDialect,
  ExplainParseOptions,
  ExplainParseResult,
  ExplainPlan,
  ExplainPlanNode,
  ExplainWarning,
} from './types.js';

export interface NodeDraft {
  operation: string;
  object?: string;
  index?: string;
  estimatedRows?: number;
  actualRows?: number;
  estimatedCost?: number;
  actualTimeMs?: number;
  loops?: number;
  filter?: string;
  joinCondition?: string;
  indexCondition?: string;
  warnings?: ExplainWarning[];
  children?: ExplainPlanNode[];
}

export function makeNode(id: string, draft: NodeDraft): ExplainPlanNode {
  return {
    id,
    operation: draft.operation,
    ...(draft.object !== undefined ? { object: draft.object } : {}),
    ...(draft.index !== undefined ? { index: draft.index } : {}),
    ...(draft.estimatedRows !== undefined ? { estimatedRows: draft.estimatedRows } : {}),
    ...(draft.actualRows !== undefined ? { actualRows: draft.actualRows } : {}),
    ...(draft.estimatedCost !== undefined ? { estimatedCost: draft.estimatedCost } : {}),
    ...(draft.actualTimeMs !== undefined ? { actualTimeMs: draft.actualTimeMs } : {}),
    ...(draft.loops !== undefined ? { loops: draft.loops } : {}),
    ...(draft.filter !== undefined ? { filter: draft.filter } : {}),
    ...(draft.joinCondition !== undefined ? { joinCondition: draft.joinCondition } : {}),
    ...(draft.indexCondition !== undefined ? { indexCondition: draft.indexCondition } : {}),
    warnings: draft.warnings ?? [],
    children: draft.children ?? [],
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return undefined;
}

export function largeScanRows(options: ExplainParseOptions): number {
  return options.largeScanRows ?? DEFAULT_LARGE_SCAN_ROWS;
}

/** Rows unknown counts as large: without an estimate we cannot rule it out. */
export function isLargeScan(rows: number | undefined, options: ExplainParseOptions): boolean {
  return rows === undefined || rows >= largeScanRows(options);
}

export function walkPlan(nodes: readonly ExplainPlanNode[], visit: (node: ExplainPlanNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walkPlan(node.children, visit);
  }
}

export function collectWarnings(nodes: readonly ExplainPlanNode[]): ExplainWarning[] {
  const seen = new Set<ExplainWarning>();
  const result: ExplainWarning[] = [];
  walkPlan(nodes, (node) => {
    for (const warning of node.warnings) {
      if (seen.has(warning)) continue;
      seen.add(warning);
      result.push(warning);
    }
  });
  return result;
}

function markHighCost(nodes: readonly ExplainPlanNode[], threshold: number): void {
  walkPlan(nodes, (node) => {
    if (node.estimatedCost === undefined || node.estimatedCost < threshold) return;
    if (!node.warnings.includes('highCost')) node.warnings.push('highCost');
  });
}

export function finalizePlan(
  dialect: ExplainDialect,
  roots: ExplainPlanNode[],
  raw: unknown,
  options: ExplainParseOptions,
  timings?: { planningTimeMs?: number; executionTimeMs?: number },
): ExplainPlan {
  if (options.highCostThreshold !== undefined) {
    markHighCost(roots, options.highCostThreshold);
  }
  return {
    dialect,
    roots,
    warnings: collectWarnings(roots),
    raw,
    ...(timings?.planningTimeMs !== undefined ? { planningTimeMs: timings.planningTimeMs } : {}),
    ...(timings?.executionTimeMs !== undefined ? { executionTimeMs: timings.executionTimeMs } : {}),
  };
}

export function failure(dialect: ExplainDialect, raw: unknown, error: unknown): ExplainParseResult {
  return {
    ok: false,
    dialect,
    error: error instanceof Error ? error.message : String(error),
    raw,
  };
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value) as unknown;
}