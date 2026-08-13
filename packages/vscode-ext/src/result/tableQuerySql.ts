import { DatabaseType, validateIdent } from '@db-client/core';
import {
  BETWEEN, EQ, GTE, GT, IN, IS_NULL, IS_NOT_NULL, LIKE, LTE, LT, NE,
  NOT_BETWEEN, NOT_IN, NOT_LIKE,
} from '../utils/sqlOperators';
import { FILTER_OP, type FilterOp } from '../utils/filterOps';
import { escapeSqlString, wrapIdent } from '../utils/sql';

export interface FilterCondition {
  column: string;
  op: FilterOp;
  value?: string;
  value2?: string;
}

function qualifiedTable(dbType: DatabaseType, table: string, database?: string): string {
  validateIdent(table);
  const tbl = wrapIdent(dbType, table);
  if (database) validateIdent(database);
  return database ? `${wrapIdent(dbType, database)}.${tbl}` : tbl;
}

/**
 * 转义 LIKE 模式：先按方言转义字面量，再把通配符 `%`/`_` 前缀反斜杠。
 * 反斜杠只有在配套 ESCAPE 子句下才生效，见 likeEscapeClause。
 */
function escapeLike(val: string, dbType: DatabaseType): string {
  return escapeSqlString(val, dbType).replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * LIKE 的 ESCAPE 子句。
 *
 * SQLite 的 LIKE 没有默认转义字符，不显式声明则 `\%` 中的 `%` 仍按通配符解释；
 * MySQL/PG 虽有默认 `\`，显式声明可去掉对默认值的隐式依赖。
 * MySQL 字符串字面量内反斜杠需翻倍。
 */
function likeEscapeClause(dbType: DatabaseType): string {
  return dbType === DatabaseType.MYSQL ? " ESCAPE '\\\\'" : " ESCAPE '\\'";
}

/** 逗号分隔值 → 引号包裹的元素列表（过滤空项）。 */
function commaList(val: string, dbType: DatabaseType): string {
  return val
    .split(',')
    .map((s) => `'${escapeSqlString(s.trim(), dbType)}'`)
    .filter((s) => s !== "''")
    .join(', ');
}

/** 判断值看起来像数字，数字比较不包裹引号。 */
function isNumericVal(v: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(v);
}

/** 构建单个过滤条件的 SQL 片段。 */
export function buildCondition(dbType: DatabaseType, condition: FilterCondition): string {
  try {
    validateIdent(condition.column);
  } catch {
    return '';
  }
  const w = wrapIdent(dbType, condition.column);
  const v = condition.value ?? '';
  const v2 = condition.value2 ?? '';
  const quoteVal = (raw: string) => isNumericVal(raw) ? raw : `'${escapeSqlString(raw, dbType)}'`;
  const esc = likeEscapeClause(dbType);
  switch (condition.op) {
    case FILTER_OP.eq: return `${w} ${EQ} ${quoteVal(v)}`;
    case FILTER_OP.ne: return `${w} ${NE} ${quoteVal(v)}`;
    case FILTER_OP.contains: return `${w} ${LIKE} '%${escapeLike(v, dbType)}%'${esc}`;
    case FILTER_OP.notContains: return `${w} ${NOT_LIKE} '%${escapeLike(v, dbType)}%'${esc}`;
    case FILTER_OP.startsWith: return `${w} ${LIKE} '${escapeLike(v, dbType)}%'${esc}`;
    case FILTER_OP.notStartsWith: return `${w} ${NOT_LIKE} '${escapeLike(v, dbType)}%'${esc}`;
    case FILTER_OP.endsWith: return `${w} ${LIKE} '%${escapeLike(v, dbType)}'${esc}`;
    case FILTER_OP.notEndsWith: return `${w} ${NOT_LIKE} '%${escapeLike(v, dbType)}'${esc}`;
    case FILTER_OP.gt: return `${w} ${GT} ${quoteVal(v)}`;
    case FILTER_OP.gte: return `${w} ${GTE} ${quoteVal(v)}`;
    case FILTER_OP.lt: return `${w} ${LT} ${quoteVal(v)}`;
    case FILTER_OP.lte: return `${w} ${LTE} ${quoteVal(v)}`;
    case FILTER_OP.between: return `${w} ${BETWEEN} ${quoteVal(v)} AND ${quoteVal(v2)}`;
    case FILTER_OP.notBetween: return `${w} ${NOT_BETWEEN} ${quoteVal(v)} AND ${quoteVal(v2)}`;
    case FILTER_OP.isNull: return `${w} ${IS_NULL}`;
    case FILTER_OP.notNull: return `${w} ${IS_NOT_NULL}`;
    case FILTER_OP.isEmpty: return `${w} ${EQ} ''`;
    case FILTER_OP.notEmpty: return `${w} ${NE} ''`;
    case FILTER_OP.in: {
      const items = commaList(v, dbType);
      return items ? `${w} ${IN} (${items})` : '';
    }
    case FILTER_OP.notIn: {
      const items = commaList(v, dbType);
      return items ? `${w} ${NOT_IN} (${items})` : '';
    }
    default: return '';
  }
}

/** 用 AND 组合多个过滤条件。 */
export function buildWhereAll(dbType: DatabaseType, conditions: FilterCondition[]): string {
  const parts = conditions
    .filter((c) => c.column)
    .map((c) => buildCondition(dbType, c))
    .filter(Boolean);
  return parts.join(' AND ');
}

export function buildTableSelect(
  dbType: DatabaseType,
  table: string,
  database: string | undefined,
  conditions: FilterCondition[],
  sortCol: string,
  sortDir: string,
  offset: number,
  limit: number,
): string {
  const safeOffset = Math.max(0, Math.min(offset, 1_000_000));
  const safeLimit = Math.max(1, Math.min(limit, 100_000));
  let sql = `SELECT * FROM ${qualifiedTable(dbType, table, database)}`;
  const where = buildWhereAll(dbType, conditions);
  if (where) sql += ` WHERE ${where}`;
  if (sortCol && sortDir) {
    validateIdent(sortCol);
    const dir = sortDir.toUpperCase();
    if (dir !== 'ASC' && dir !== 'DESC') {
      throw new Error(`Invalid sort direction: ${sortDir}`);
    }
    sql += ` ORDER BY ${wrapIdent(dbType, sortCol)} ${dir}`;
  }
  sql += ` LIMIT ${safeLimit} OFFSET ${safeOffset}`;
  return sql;
}

export function buildCountSql(
  dbType: DatabaseType,
  table: string,
  database: string | undefined,
  conditions: FilterCondition[],
): string {
  let sql = `SELECT COUNT(*) AS total FROM ${qualifiedTable(dbType, table, database)}`;
  const where = buildWhereAll(dbType, conditions);
  if (where) sql += ` WHERE ${where}`;
  return sql;
}