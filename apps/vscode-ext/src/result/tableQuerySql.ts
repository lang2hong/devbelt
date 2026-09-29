import { DatabaseType, validateIdent, qualifyTable } from '@devbelt/db-core';
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

/**
 * 列名 → 列类型（`simpleType` 或完整 `type`，大小写不敏感）。
 *
 * 由调用方从元数据注入，用于判断某列是否为数值列。缺项时按「非数值」处理，
 * 即加引号——对数值列写 `'1'` 三种方言都会隐式转数字，语义不变；
 * 反过来对字符列写裸 `1` 则会改变语义（见 quoteValFor 的说明）。
 */
export type ColumnTypeMap = Record<string, string | undefined>;

/**
 * 数值列类型名（取 `simpleType`，不含长度/精度）。
 *
 * 与 webview 侧 ResultGrid 的 NUMBER_TYPES 保持一致；三方言共用一张表，
 * 各方言独有的写法（serial/int2…）也一并收进来。
 */
const NUMERIC_TYPES = new Set([
  'int', 'integer', 'bigint', 'smallint', 'mediumint', 'tinyint',
  'decimal', 'numeric', 'float', 'double', 'double precision', 'real',
  'int2', 'int4', 'int8', 'float4', 'float8', 'money',
  'serial', 'bigserial', 'smallserial', 'bit', 'year',
]);

/**
 * 判断列是否为数值列。
 *
 * 只取类型名的首个词并剥掉长度/精度与 unsigned 等修饰：
 * `int(11) unsigned` → `int`，`decimal(10,2)` → `decimal`。
 */
function isNumericColumn(columnType: string | undefined): boolean {
  if (!columnType) return false;
  const base = columnType.trim().toLowerCase().replace(/\(.*$/, '').replace(/\s+(unsigned|zerofill).*$/, '').trim();
  return NUMERIC_TYPES.has(base) || NUMERIC_TYPES.has(base.split(/\s+/)[0]);
}

function qualifiedTable(dbType: DatabaseType, table: string, database?: string): string {
  validateIdent(table);
  const tbl = wrapIdent(dbType, table);
  if (database) validateIdent(database);
  // PG 一个连接一个库：树把该库的对象按 **schema** 组织，故此处的 `database` 槽在 PG 下表示 schema，
  // 限定为 `"schema"."table"`；为空则回退 search_path（默认 schema）。
  if (dbType === DatabaseType.PG) return database ? `${wrapIdent(dbType, database)}.${tbl}` : tbl;
  return qualifyTable(dbType, tbl, database ? wrapIdent(dbType, database) : undefined);
}

/**
 * 转义 LIKE 模式：先按方言转义字面量，再把通配符 `%`/`_` 前缀反斜杠。
 * 反斜杠只有在配套 ESCAPE 子句下才生效，见 likeEscapeClause。
 */
function escapeLike(val: string, dbType: DatabaseType, noBackslashEscapes: boolean): string {
  return escapeSqlString(val, dbType, noBackslashEscapes).replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * LIKE 的 ESCAPE 子句。
 *
 * SQLite 的 LIKE 没有默认转义字符，不显式声明则 `\%` 中的 `%` 仍按通配符解释；
 * MySQL/PG 虽有默认 `\`，显式声明可去掉对默认值的隐式依赖。
 * MySQL 字符串字面量内反斜杠需翻倍；NO_BACKSLASH_ESCAPES 下反斜杠是普通字符，
 * `'\\'` 会变成两个反斜杠（非法 ESCAPE），此时用单个 `'\'`。
 */
function likeEscapeClause(dbType: DatabaseType, noBackslashEscapes: boolean): string {
  return dbType === DatabaseType.MYSQL && !noBackslashEscapes ? " ESCAPE '\\\\'" : " ESCAPE '\\'";
}

/**
 * 逗号分隔值 → 元素列表（过滤空项）。
 * 每一项与其他操作符走同一套引号规则：数值列的数字字面量裸写，其余加引号。
 */
function commaList(val: string, dbType: DatabaseType, noBackslashEscapes: boolean, columnType?: string): string {
  return val
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => quoteValFor(dbType, columnType, s, noBackslashEscapes))
    .join(', ');
}

/** 判断值看起来像数字。 */
function isNumericVal(v: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(v);
}

/**
 * 决定某个筛选值是否裸写（不加引号）。
 *
 * 只有「列确实是数值类型」且「值是数字字面量」才裸写。曾经只看值本身，
 * 于是对 varchar 列填 `1` 会产出 `` `id` = 1 ``：MySQL 会把整列转成 double 比较，
 * `'1'`/`'01'`/`' 1'`/`'1abc'` 全部命中，同时索引失效。
 *
 * 类型未知时选择加引号：数值列写 `'1'` 在 MySQL/PG/SQLite 都会隐式转数字，
 * 结果不变；而字符列写裸 `1` 则会改变语义。所以引号是安全的默认。
 */
function quoteValFor(dbType: DatabaseType, columnType: string | undefined, raw: string, noBackslashEscapes: boolean): string {
  if (isNumericColumn(columnType) && isNumericVal(raw)) return raw;
  return `'${escapeSqlString(raw, dbType, noBackslashEscapes)}'`;
}

/** 构建单个过滤条件的 SQL 片段。 */
export function buildCondition(
  dbType: DatabaseType,
  condition: FilterCondition,
  columnTypes: ColumnTypeMap = {},
  noBackslashEscapes = false,
): string {
  try {
    validateIdent(condition.column);
  } catch {
    return '';
  }
  const w = wrapIdent(dbType, condition.column);
  const v = condition.value ?? '';
  const v2 = condition.value2 ?? '';
  const columnType = columnTypes[condition.column];
  const quoteVal = (raw: string) => quoteValFor(dbType, columnType, raw, noBackslashEscapes);
  const esc = likeEscapeClause(dbType, noBackslashEscapes);
  switch (condition.op) {
    case FILTER_OP.eq: return `${w} ${EQ} ${quoteVal(v)}`;
    case FILTER_OP.ne: return `${w} ${NE} ${quoteVal(v)}`;
    case FILTER_OP.contains: return `${w} ${LIKE} '%${escapeLike(v, dbType, noBackslashEscapes)}%'${esc}`;
    case FILTER_OP.notContains: return `${w} ${NOT_LIKE} '%${escapeLike(v, dbType, noBackslashEscapes)}%'${esc}`;
    case FILTER_OP.startsWith: return `${w} ${LIKE} '${escapeLike(v, dbType, noBackslashEscapes)}%'${esc}`;
    case FILTER_OP.notStartsWith: return `${w} ${NOT_LIKE} '${escapeLike(v, dbType, noBackslashEscapes)}%'${esc}`;
    case FILTER_OP.endsWith: return `${w} ${LIKE} '%${escapeLike(v, dbType, noBackslashEscapes)}'${esc}`;
    case FILTER_OP.notEndsWith: return `${w} ${NOT_LIKE} '%${escapeLike(v, dbType, noBackslashEscapes)}'${esc}`;
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
      const items = commaList(v, dbType, noBackslashEscapes, columnType);
      return items ? `${w} ${IN} (${items})` : '';
    }
    case FILTER_OP.notIn: {
      const items = commaList(v, dbType, noBackslashEscapes, columnType);
      return items ? `${w} ${NOT_IN} (${items})` : '';
    }
    default: return '';
  }
}

/** 用 AND 组合多个过滤条件。 */
export function buildWhereAll(
  dbType: DatabaseType,
  conditions: FilterCondition[],
  columnTypes: ColumnTypeMap = {},
  noBackslashEscapes = false,
): string {
  const parts = conditions
    .filter((c) => c.column)
    .map((c) => buildCondition(dbType, c, columnTypes, noBackslashEscapes))
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
  columnTypes: ColumnTypeMap = {},
  noBackslashEscapes = false,
): string {
  const safeOffset = Math.max(0, Math.min(offset, 1_000_000));
  const safeLimit = Math.max(1, Math.min(limit, 100_000));
  let sql = `SELECT * FROM ${qualifiedTable(dbType, table, database)}`;
  const where = buildWhereAll(dbType, conditions, columnTypes, noBackslashEscapes);
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
  columnTypes: ColumnTypeMap = {},
  noBackslashEscapes = false,
): string {
  let sql = `SELECT COUNT(*) AS total FROM ${qualifiedTable(dbType, table, database)}`;
  const where = buildWhereAll(dbType, conditions, columnTypes, noBackslashEscapes);
  if (where) sql += ` WHERE ${where}`;
  return sql;
}