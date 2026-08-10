/**
 * 表格筛选操作符 — 单源常量（纯模块，无 vscode 依赖）。
 *
 * 供 vscode-ext 进程（tableQuerySql 的 SQL 构建）与 webview（ResultGrid 的筛选 UI）
 * 共用同一份操作符标识，避免字符串字面量漂移。
 */

export const FILTER_OP = {
  eq: 'eq',
  ne: 'ne',
  contains: 'contains',
  notContains: 'notContains',
  startsWith: 'startsWith',
  notStartsWith: 'notStartsWith',
  endsWith: 'endsWith',
  notEndsWith: 'notEndsWith',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  between: 'between',
  notBetween: 'notBetween',
  isNull: 'isNull',
  notNull: 'notNull',
  isEmpty: 'isEmpty',
  notEmpty: 'notEmpty',
  in: 'in',
  notIn: 'notIn',
} as const;

export type FilterOp = (typeof FILTER_OP)[keyof typeof FILTER_OP];