/**
 * SQL 补全引擎（纯函数，无 vscode 依赖）。
 *
 * 由 webview 后端（tableQueryView）与 .sql 编辑器 CompletionProvider 共用。
 * 职责：根据光标前文本判断 SQL 上下文位置，组合候选集（带类别）。
 * 元数据（表/列）由调用方注入，引擎本身不访问数据库。
 */

import { SQL_OPERATORS } from '../utils/sqlOperators';

export type CompKind = 'keyword' | 'table' | 'column' | 'function' | 'operator';

export interface CompletionCandidate {
  label: string;
  kind: CompKind;
}

export interface CompletionMeta {
  tables: string[];
  columns: string[];
  fromTable?: string;
}

export type SqlContext =
  | 'statement_start'
  | 'select_clause'
  | 'from_table_typing'
  | 'after_table'
  | 'where_condition'
  | 'where_operator'
  | 'where_value'
  | 'order_clause'
  | 'set_clause'
  | 'dot_column'
  | 'default';

/** SQL 关键字集合（单词形式，避免多词短语重复插入）。 */
export const SQL_KEYWORDS = {
  statement: [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER',
    'SHOW', 'USE', 'TRUNCATE', 'WITH', 'BEGIN', 'COMMIT', 'ROLLBACK',
  ],
  clause: [
    'FROM', 'WHERE', 'ORDER', 'GROUP', 'BY', 'HAVING', 'LIMIT', 'OFFSET',
    'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'UNION', 'ALL',
    'AS', 'DISTINCT', 'SET', 'VALUES', 'INTO', 'USING',
  ],
  operator: [
    'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS', 'NULL',
    'EXISTS', 'ANY', 'ALL',
  ],
  order: ['ASC', 'DESC'],
  functions: [
    'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'CONCAT', 'NOW', 'CURDATE',
    'CURTIME', 'UNIX_TIMESTAMP', 'FROM_UNIXTIME', 'DATE_FORMAT', 'STR_TO_DATE',
    'IFNULL', 'COALESCE', 'NULLIF', 'CAST', 'CONVERT', 'SUBSTRING', 'LENGTH',
    'TRIM', 'LOWER', 'UPPER', 'REPLACE', 'LEFT', 'RIGHT', 'ROUND', 'CEIL',
    'FLOOR', 'ABS', 'MOD', 'GREATEST', 'LEAST', 'DATE', 'DATEDIFF', 'IF',
  ],
} as const;

const kw = (label: string): CompletionCandidate => ({ label, kind: 'keyword' });
const fn = (label: string): CompletionCandidate => ({ label, kind: 'function' });
const op = (label: string): CompletionCandidate => ({ label, kind: 'operator' });
const tbl = (label: string): CompletionCandidate => ({ label, kind: 'table' });
const col = (label: string): CompletionCandidate => ({ label, kind: 'column' });

/**
 * 从光标前文本判断当前 SQL 上下文位置。
 * 按优先级匹配，先命中先返回。
 */
export function detectContext(before: string): SqlContext {
  // 1. 表名. 后（限定列）
  if (/(\w+)\.\w*$/.test(before)) return 'dot_column';

  // 2. 表名完整 + 尾空格（FROM/JOIN/UPDATE/INTO table 后空格）→ 子句关键字
  if (/\b(?:FROM|JOIN)\s+\w+\s+$/i.test(before)) return 'after_table';
  if (/\b(?:UPDATE|INTO)\s+\w+\s+$/i.test(before)) return 'after_table';

  // 3. 正在输入表名（FROM/JOIN/UPDATE/INTO 后空格+部分词，含 FROM 空格起态）
  if (/\b(?:FROM|JOIN|UPDATE|INTO)\s+\w*$/i.test(before)) return 'from_table_typing';

  // 4. ORDER BY / GROUP BY 后
  if (/\b(?:ORDER|GROUP)\s+BY\s+\w*$/i.test(before)) return 'order_clause';

  // 5. WHERE 字段后等待比较操作符：WHERE age ␣
  if (/\b(?:WHERE|HAVING|AND|OR)\s+\w+\s+$/i.test(before)) return 'where_operator';

  // 6. WHERE 比较操作符后等待值：WHERE age > ␣ / WHERE age LIKE ␣
  if (/\b(?:WHERE|HAVING|AND|OR)\s+\w+\s+(?:[<>=!]+|\b(?:LIKE|NOT\s+LIKE|IN|BETWEEN|IS|NOT\s+IN)\b)\s*$/i.test(before)) return 'where_value';

  // 7. WHERE / HAVING / AND / OR 后（条件左侧，输入字段名）
  if (/\b(?:WHERE|HAVING|AND|OR)\s+\w*$/i.test(before)) return 'where_condition';

  // 8. SET 后（UPDATE ... SET col=...）
  if (/\bSET\s+\w*$/i.test(before)) return 'set_clause';

  // 9. SELECT 子句（SELECT 后、当前语句未到 FROM）
  if (/\bSELECT\b/i.test(before) && !/\bFROM\b/i.test(before)) return 'select_clause';

  // 10. 语句起始（空或分号后空白）
  if (before.trim() === '' || /;\s*$/.test(before)) return 'statement_start';

  return 'default';
}

/** 从 SQL 文本提取 FROM 后表名（去库名前缀，支持反引号）。 */
export function extractFromTable(text: string): string | undefined {
  const m = text.match(/\bFROM\s+`?([\w.]+)`?/i);
  if (!m) return undefined;
  return m[1].split('.').pop();
}

/** 别名/表名保留字：误当作别名会把 `FROM t LEFT JOIN u ON ...` 的 LEFT 当别名。 */
const NOT_ALIAS = /^(ON|USING|WHERE|GROUP|ORDER|LIMIT|OFFSET|HAVING|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|NATURAL|SET|VALUES|UNION|AS|AND|OR)$/i;

/**
 * 解析语句里 FROM/JOIN 的 `别名 → 表名` 映射（含表名自身）。
 *
 * `SELECT u.` 这类补全过去拿 `u` 当表名查列、必然查不到；这里先建立别名映射，
 * 再据别名取真实表的列。
 */
export function extractTableAliases(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:FROM|JOIN)\s+`?([\w.]+)`?(?:\s+(?:AS\s+)?`?([\w]+)`?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const table = (m[1] ?? '').split('.').pop();
    if (!table) continue;
    map.set(table, table);
    const alias = m[2];
    if (!alias) continue;
    if (!NOT_ALIAS.test(alias)) {
      map.set(alias, table);
    } else {
      // 捕获到的「别名」其实是 JOIN/ON/WHERE 等保留字：它不是别名。回退游标让它重新
      // 参与 FROM/JOIN 扫描，否则 `FROM a JOIN b` 里的第二个表会被整段吞掉。
      re.lastIndex = m.index + m[0].lastIndexOf(alias);
    }
  }
  return map;
}

/**
 * 按上下文组合候选集（带类别）。
 * 调用方注入元数据：tables（当前库表名）、columns（FROM 表列名）、fromTable。
 */
export function buildCandidates(ctx: SqlContext, meta: CompletionMeta): CompletionCandidate[] {
  const tables = meta.tables.map(tbl);
  const columns = meta.columns.map(col);
  const functions = SQL_KEYWORDS.functions.map(fn);

  switch (ctx) {
    case 'dot_column':
      return columns.length ? columns : functions;

    case 'from_table_typing':
      return tables;

    case 'select_clause':
      return [
        ...columns,
        ...functions,
        kw('DISTINCT'),
        kw('*'),
        kw('AS'),
        kw('FROM'),
      ];

    case 'after_table':
      return [
        ...SQL_KEYWORDS.clause.map(kw),
        ...columns,
      ];

    case 'where_condition':
      return [
        ...columns,
        ...functions,
        ...SQL_KEYWORDS.operator.map(op),
      ];

    case 'where_operator':
      return SQL_OPERATORS.map(op);

    case 'where_value':
      return [
        ...functions,
        ...columns,
        ...SQL_KEYWORDS.operator.map(op),
        kw('SELECT'),
        kw('NULL'),
      ];

    case 'order_clause':
      return [
        ...columns,
        ...SQL_KEYWORDS.order.map(kw),
      ];

    case 'set_clause':
      return columns;

    case 'statement_start':
      return [
        ...SQL_KEYWORDS.statement.map(kw),
        ...tables,
      ];

    case 'default':
    default:
      return [
        ...SQL_KEYWORDS.statement.map(kw),
        ...SQL_KEYWORDS.clause.map(kw),
        ...tables,
      ];
  }
}

/**
 * 前缀过滤（大小写不敏感）。
 * 供前端使用：后端返回全量候选，前端按当前输入词过滤以减少往返。
 */
export function filterByPrefix(candidates: CompletionCandidate[], prefix: string): CompletionCandidate[] {
  if (!prefix) return candidates;
  const p = prefix.toLowerCase();
  return candidates.filter((c) => c.label.toLowerCase().startsWith(p));
}
