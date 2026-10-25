import { checkReadOnlySql, type AgentEngine } from '@devbelt/agent-core';
import { validateIdent, validateSchemaIdent, type ColumnMeta, type IndexMeta } from '@devbelt/db-core';
import { MAX_METRIC_COLUMNS } from './monitorTypes';

/**
 * A2 / B 的创建前校验（P13 §6）。这里只做纯函数判断；需要数据库的部分（读列/索引、
 * 试执行）由调用方取数后传入，便于单测与复用（Agent 提案与用户确认各校验一次）。
 */

export type ValidationIssue =
  | { level: 'error'; code: MetricErrorCode | CursorErrorCode; detail?: string }
  | { level: 'warning'; code: CursorWarningCode; detail?: string };

export type MetricErrorCode =
  | 'notReadOnly'
  | 'notSelect'
  | 'noRows'
  | 'tooManyRows'
  | 'noColumns'
  | 'tooManyColumns'
  | 'nonNumeric'
  | 'watchColumnMissing'
  | 'trialFailed';

export type CursorErrorCode = 'identifier' | 'columnMissing' | 'cursorType' | 'tableMissing';
export type CursorWarningCode = 'nullable' | 'noIndex' | 'noPrimaryKey' | 'slowQuery';

export interface MetricValidation {
  ok: boolean;
  issues: ValidationIssue[];
  /** 规范化后的单条语句（去掉尾分号）。 */
  statement?: string;
  columns?: string[];
  values?: Record<string, number | null>;
  watchColumn?: string;
}

/** 第一步（不访问数据库）：只读、单条、SELECT。 */
export function checkMetricSql(sql: string, engine: AgentEngine): { ok: true; statement: string } | { ok: false; issue: ValidationIssue } {
  const check = checkReadOnlySql(sql, engine);
  if (!check.ok) return { ok: false, issue: { level: 'error', code: 'notReadOnly', detail: check.reason } };
  if (check.kind !== 'select') return { ok: false, issue: { level: 'error', code: 'notSelect' } };
  return { ok: true, statement: check.statement.trim().replace(/;\s*$/, '') };
}

/** 单元格 → 数值：数字、数字字符串、bigint；NULL → null；其他 → undefined（非数值）。 */
export function toMetricNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 第二步：试执行结果形状（1 行、1–10 列、全部可解析为数值或 NULL）。 */
export function checkMetricResult(rows: unknown[] | undefined, watchColumn: string | undefined): MetricValidation {
  const issues: ValidationIssue[] = [];
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { ok: false, issues: [{ level: 'error', code: 'noRows' }] };
  if (list.length > 1) return { ok: false, issues: [{ level: 'error', code: 'tooManyRows', detail: String(list.length) }] };
  const row = list[0];
  if (!row || typeof row !== 'object') return { ok: false, issues: [{ level: 'error', code: 'noColumns' }] };
  const entries = Object.entries(row as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, issues: [{ level: 'error', code: 'noColumns' }] };
  if (entries.length > MAX_METRIC_COLUMNS) {
    return { ok: false, issues: [{ level: 'error', code: 'tooManyColumns', detail: String(entries.length) }] };
  }
  const values: Record<string, number | null> = {};
  for (const [name, raw] of entries) {
    const n = toMetricNumber(raw);
    if (n === undefined) issues.push({ level: 'error', code: 'nonNumeric', detail: name });
    else values[name] = n;
  }
  const columns = entries.map(([name]) => name);
  const watch = watchColumn ?? columns[0];
  if (!watch || !columns.includes(watch)) issues.push({ level: 'error', code: 'watchColumnMissing', detail: watchColumn ?? '' });
  const ok = !issues.some((i) => i.level === 'error');
  return { ok, issues, columns, values, ...(watch ? { watchColumn: watch } : {}) };
}

/** 游标列类型族：整数 / 时间；其余不支持。SQLite 只接受 INTEGER 亲和类型。 */
export function cursorKindOf(dbType: string, columnType: string): 'integer' | 'temporal' | undefined {
  const engine = dbType.toUpperCase();
  const type = columnType.toLowerCase().trim();
  // SQLite 类型亲和：类型名里含 INT 即整数（INTEGER / BIGINT / TINYINT / UNSIGNED BIG INT …）。
  if (engine === 'SQLITE') return type.includes('int') ? 'integer' : undefined;
  // MySQL 的 tinyint(1) 常作布尔，不适合作游标（必须在整数判断之前）。
  if (/^tinyint\s*\(\s*1\s*\)/.test(type)) return undefined;
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|serial|bigserial|smallserial|int2|int4|int8)\b/.test(type)) return 'integer';
  if (/^(datetime|timestamp|timestamptz|date)\b/.test(type) || /^timestamp(\(\d\))?\s+with(out)?\s+time\s+zone/.test(type)) return 'temporal';
  return undefined;
}

export interface CursorValidation {
  ok: boolean;
  issues: ValidationIssue[];
  cursorKind?: 'integer' | 'temporal';
  primaryKey: string[];
}

/** B：游标列存在、类型受支持；可空 / 无索引首列 / 无主键只提示。 */
export function checkCursorColumn(input: {
  dbType: string;
  table: string;
  schema?: string;
  column: string;
  columns: readonly ColumnMeta[];
  indexes: readonly IndexMeta[];
}): CursorValidation {
  const issues: ValidationIssue[] = [];
  try {
    validateIdent(input.table);
    validateIdent(input.column);
    if (input.schema) validateSchemaIdent(input.schema);
  } catch (err) {
    return { ok: false, issues: [{ level: 'error', code: 'identifier', detail: err instanceof Error ? err.message : String(err) }], primaryKey: [] };
  }
  if (input.columns.length === 0) return { ok: false, issues: [{ level: 'error', code: 'tableMissing', detail: input.table }], primaryKey: [] };
  const column = input.columns.find((c) => c.name === input.column)
    ?? input.columns.find((c) => c.name.toLowerCase() === input.column.toLowerCase());
  const primaryKey = input.columns.filter((c) => c.isPrimary).map((c) => c.name);
  if (!column) return { ok: false, issues: [{ level: 'error', code: 'columnMissing', detail: input.column }], primaryKey };
  const kind = cursorKindOf(input.dbType, column.type || column.simpleType);
  if (!kind) return { ok: false, issues: [{ level: 'error', code: 'cursorType', detail: column.type || column.simpleType }], primaryKey };
  if (!column.isNotNull && !column.isPrimary) issues.push({ level: 'warning', code: 'nullable' });
  const indexed = column.isPrimary || input.indexes.some((i) => i.columns[0]?.toLowerCase() === column.name.toLowerCase());
  if (!indexed) issues.push({ level: 'warning', code: 'noIndex' });
  if (primaryKey.length === 0) issues.push({ level: 'warning', code: 'noPrimaryKey' });
  return { ok: true, issues, cursorKind: kind, primaryKey };
}
