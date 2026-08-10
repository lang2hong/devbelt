/**
 * SQL 比较/匹配操作符 — 单源词汇表。
 *
 * 供两处复用，避免各自维护漂移：
 *  - SQL 补全引擎（`where_operator` 候选、`where_value` 触发）
 *  - 表格筛选 SQL 构建（`result/tableQuerySql.ts` 的 buildCondition）
 *
 * 注意：filter 的复合操作符（contains / startsWith / NOT BETWEEN 语义等）不在本表，
 * 它们由 filter 单独用 LIKE/BETWEEN 组合生成，不直接作为补全候选。
 */

export const EQ = '=' as const;
export const NE = '<>' as const;
export const NE_ALT = '!=' as const;
export const GT = '>' as const;
export const GTE = '>=' as const;
export const LT = '<' as const;
export const LTE = '<=' as const;
export const LIKE = 'LIKE' as const;
export const NOT_LIKE = 'NOT LIKE' as const;
export const IN = 'IN' as const;
export const NOT_IN = 'NOT IN' as const;
export const BETWEEN = 'BETWEEN' as const;
export const NOT_BETWEEN = 'NOT BETWEEN' as const;
export const IS_NULL = 'IS NULL' as const;
export const IS_NOT_NULL = 'IS NOT NULL' as const;

/** 补全 `where_operator` 提供的原始 SQL 操作符候选。 */
export const SQL_OPERATORS = [
  EQ, NE_ALT, NE, GT, GTE, LT, LTE,
  LIKE, NOT_LIKE, IN, NOT_IN, BETWEEN, IS_NULL, IS_NOT_NULL,
] as const;

export type SqlOperator = (typeof SQL_OPERATORS)[number];