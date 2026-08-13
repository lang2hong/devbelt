import type { DatabaseType } from '@db-client/core';
import { validateIdent } from '@db-client/core';
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
  const tbl = wrapIdent(dbType, table);
  return database ? `${wrapIdent(dbType, database)}.${tbl}` : tbl;
}

function escapeLike(val: string): string {
  return escapeSqlString(val).replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** 逗号分隔值 → 引号包裹的元素列表（过滤空项）。 */
function commaList(val: string): string {
  return val
    .split(',')
    .map((s) => `'${escapeSqlString(s.trim())}'`)
    .filter((s) => s !== "''")
    .join(', ');
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
  switch (condition.op) {
    case FILTER_OP.eq: return `${w} ${EQ} '${escapeSqlString(v)}'`;
    case FILTER_OP.ne: return `${w} ${NE} '${escapeSqlString(v)}'`;
    case FILTER_OP.contains: return `${w} ${LIKE} '%${escapeLike(v)}%'`;
    case FILTER_OP.notContains: return `${w} ${NOT_LIKE} '%${escapeLike(v)}%'`;
    case FILTER_OP.startsWith: return `${w} ${LIKE} '${escapeLike(v)}%'`;
    case FILTER_OP.notStartsWith: return `${w} ${NOT_LIKE} '${escapeLike(v)}%'`;
    case FILTER_OP.endsWith: return `${w} ${LIKE} '%${escapeLike(v)}'`;
    case FILTER_OP.notEndsWith: return `${w} ${NOT_LIKE} '%${escapeLike(v)}'`;
    case FILTER_OP.gt: return `${w} ${GT} '${escapeSqlString(v)}'`;
    case FILTER_OP.gte: return `${w} ${GTE} '${escapeSqlString(v)}'`;
    case FILTER_OP.lt: return `${w} ${LT} '${escapeSqlString(v)}'`;
    case FILTER_OP.lte: return `${w} ${LTE} '${escapeSqlString(v)}'`;
    case FILTER_OP.between: return `${w} ${BETWEEN} '${escapeSqlString(v)}' AND '${escapeSqlString(v2)}'`;
    case FILTER_OP.notBetween: return `${w} ${NOT_BETWEEN} '${escapeSqlString(v)}' AND '${escapeSqlString(v2)}'`;
    case FILTER_OP.isNull: return `${w} ${IS_NULL}`;
    case FILTER_OP.notNull: return `${w} ${IS_NOT_NULL}`;
    case FILTER_OP.isEmpty: return `${w} ${EQ} ''`;
    case FILTER_OP.notEmpty: return `${w} ${NE} ''`;
    case FILTER_OP.in: {
      const items = commaList(v);
      return items ? `${w} ${IN} (${items})` : '';
    }
    case FILTER_OP.notIn: {
      const items = commaList(v);
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
  let sql = `SELECT * FROM ${qualifiedTable(dbType, table, database)}`;
  const where = buildWhereAll(dbType, conditions);
  if (where) sql += ` WHERE ${where}`;
  if (sortCol && sortDir) {
    const dir = sortDir.toUpperCase();
    if (dir !== 'ASC' && dir !== 'DESC') {
      throw new Error(`Invalid sort direction: ${sortDir}`);
    }
    sql += ` ORDER BY ${wrapIdent(dbType, sortCol)} ${dir}`;
  }
  sql += ` LIMIT ${limit} OFFSET ${offset}`;
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