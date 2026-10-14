import { sqlSkeleton, classifyWriteKind } from '@devbelt/db-core/sql';
import type { SqlScanOptions } from '@devbelt/db-core/sql';
import { splitSqlStatements } from '../utils/sql.js';

/**
 * AI 生成 SQL 的行数上限兜底（S7j）。
 *
 * 提示词要求模型自带 `LIMIT 10`；这里在执行前再做一次机械兜底，防止模型遗漏
 * 造成大结果集全量缓冲（内存/卡死）。仅在能安全判定的形态上追加：
 * 单语句 + 非写语句（含 `WITH ... UPDATE` 等 CTE 写）+ `SELECT`/`WITH` 开头 +
 * 无 LIMIT / SELECT INTO / 行锁子句；其余原样返回。追加在**新行**，避免被行尾
 * `--` 注释吞掉。
 */
export const AI_SELECT_ROW_LIMIT = 10;

export function ensureSelectRowLimit(sql: string, scanOptions?: SqlScanOptions): string {
  const statements = splitSqlStatements(sql, scanOptions);
  if (statements.length !== 1) return sql;
  const statement = statements[0].trim();
  if (!statement) return sql;
  const skeleton = sqlSkeleton(statement, scanOptions).trim().toUpperCase();
  if (!skeleton.startsWith('SELECT') && !skeleton.startsWith('WITH')) return sql;
  if (classifyWriteKind(statement, scanOptions) !== 'other') return sql;
  if (/\bLIMIT\b/.test(skeleton)) return sql;
  if (/\bFETCH\s+(FIRST|NEXT)\b/.test(skeleton) || /\bTOP\b/.test(skeleton)) return sql;
  if (/\bINTO\b/.test(skeleton)) return sql;
  if (/\bFOR\s+UPDATE\b|\bFOR\s+SHARE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/.test(skeleton)) return sql;
  const trimmed = statement.replace(/;\s*$/, '');
  return `${trimmed}\nLIMIT ${AI_SELECT_ROW_LIMIT}`;
}