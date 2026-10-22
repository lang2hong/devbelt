/** SQL engines supported by the unified plan model. */
export type ExplainDialect = 'mysql' | 'postgres' | 'sqlite';

/**
 * High-confidence plan warnings. Rules are intentionally conservative in the
 * first version; the UI may add advisory-only hints later.
 */
export type ExplainWarning =
  | 'fullTableScan'
  | 'filesort'
  | 'temporaryTable'
  | 'highCost'
  | 'nestedLoop'
  | 'missingIndex';

/** One normalized node in an execution plan tree. */
export interface ExplainPlanNode {
  id: string;
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
  /** Condition used to probe an index (PostgreSQL `Index Cond`). */
  indexCondition?: string;
  warnings: ExplainWarning[];
  children: ExplainPlanNode[];
}

/** A complete normalized plan for one statement. */
export interface ExplainPlan {
  dialect: ExplainDialect;
  roots: ExplainPlanNode[];
  warnings: ExplainWarning[];
  raw: unknown;
  planningTimeMs?: number;
  executionTimeMs?: number;
}

export interface ExplainParseOptions {
  /**
   * Mark nodes whose estimated cost is at or above this value as `highCost`.
   * Omitted by default: cost units differ between engines, so the caller
   * decides whether an absolute threshold is meaningful.
   */
  highCostThreshold?: number;
  /**
   * Estimated row count at which a full scan is considered "large". Small
   * scans are often the optimal plan, so index-related warnings are only
   * raised at or above this value. Defaults to `DEFAULT_LARGE_SCAN_ROWS`.
   */
  largeScanRows?: number;
}

export const DEFAULT_LARGE_SCAN_ROWS = 1000;

export type ExplainParseResult =
  | { ok: true; plan: ExplainPlan }
  | { ok: false; dialect: ExplainDialect; error: string; raw: unknown };