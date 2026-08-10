import type { DatabaseType } from '@db-client/core';

export type FilterOp =
  | 'eq' | 'ne'
  | 'contains' | 'notContains'
  | 'startsWith' | 'endsWith'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'isNull' | 'notNull';

export interface FilterCondition {
  column: string;
  op: FilterOp;
  value?: string;
}

/** 纯函数：构建表预览的 SELECT / COUNT SQL，供扩展与单测复用。 */
export function wrapIdent(dbType: DatabaseType, name: string): string {
  return dbType === 'MYSQL' ? '`' + name + '`' : '"' + name + '"';
}

function qualifiedTable(dbType: DatabaseType, table: string, database?: string): string {
  const tbl = wrapIdent(dbType, table);
  return database ? `${wrapIdent(dbType, database)}.${tbl}` : tbl;
}

function escapeString(val: string): string {
  return String(val).replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function escapeLike(val: string): string {
  return escapeString(val).replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** 构建单个过滤条件的 SQL 片段。 */
export function buildCondition(dbType: DatabaseType, condition: FilterCondition): string {
  const w = wrapIdent(dbType, condition.column);
  switch (condition.op) {
    case 'eq': return `${w} = '${escapeString(condition.value ?? '')}'`;
    case 'ne': return `${w} <> '${escapeString(condition.value ?? '')}'`;
    case 'contains': return `${w} LIKE '%${escapeLike(condition.value ?? '')}%'`;
    case 'notContains': return `${w} NOT LIKE '%${escapeLike(condition.value ?? '')}%'`;
    case 'startsWith': return `${w} LIKE '${escapeLike(condition.value ?? '')}%'`;
    case 'endsWith': return `${w} LIKE '%${escapeLike(condition.value ?? '')}'`;
    case 'gt': return `${w} > '${escapeString(condition.value ?? '')}'`;
    case 'gte': return `${w} >= '${escapeString(condition.value ?? '')}'`;
    case 'lt': return `${w} < '${escapeString(condition.value ?? '')}'`;
    case 'lte': return `${w} <= '${escapeString(condition.value ?? '')}'`;
    case 'isNull': return `${w} IS NULL`;
    case 'notNull': return `${w} IS NOT NULL`;
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
    sql += ` ORDER BY ${wrapIdent(dbType, sortCol)} ${sortDir}`;
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