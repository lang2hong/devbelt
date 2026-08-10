/**
 * SQL 补全引擎（纯函数，无 vscode 依赖）。
 *
 * 由 webview 后端（tableQueryView）与 .sql 编辑器 CompletionProvider 共用。
 * 职责：根据光标前文本判断 SQL 上下文位置，组合候选集（带类别）。
 * 元数据（表/列）由调用方注入，引擎本身不访问数据库。
 */

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
  if (/\b(?:FROM|JOIN)\s+\w+\s+$/.test(before)) return 'after_table';
  if (/\b(?:UPDATE|INTO)\s+\w+\s+$/.test(before)) return 'after_table';

  // 3. 正在输入表名（FROM/JOIN/UPDATE/INTO 后空格+部分词，含 FROM 空格起态）
  if (/\b(?:FROM|JOIN|UPDATE|INTO)\s+\w*$/.test(before)) return 'from_table_typing';

  // 4. ORDER BY / GROUP BY 后
  if (/\b(?:ORDER|GROUP)\s+BY\s+\w*$/i.test(before)) return 'order_clause';

  // 5. WHERE / HAVING / AND / OR 后（条件左侧）
  if (/\b(?:WHERE|HAVING|AND|OR)\s+\w*$/i.test(before)) return 'where_condition';

  // 6. SET 后（UPDATE ... SET col=...）
  if (/\bSET\s+\w*$/i.test(before)) return 'set_clause';

  // 7. SELECT 子句（SELECT 后、当前语句未到 FROM）
  if (/\bSELECT\b/i.test(before) && !/\bFROM\b/i.test(before)) return 'select_clause';

  // 8. 语句起始（空或分号后空白）
  if (before.trim() === '' || /;\s*$/.test(before)) return 'statement_start';

  return 'default';
}

/** 从 SQL 文本提取 FROM 后表名（去库名前缀，支持反引号）。 */
export function extractFromTable(text: string): string | undefined {
  const m = text.match(/\bFROM\s+`?([\w.]+)`?/i);
  if (!m) return undefined;
  return m[1].split('.').pop();
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
        ...SQL_KEYWORDS.statement.map(kw),
        ...columns,
      ];

    case 'where_condition':
      return [
        ...columns,
        ...functions,
        ...SQL_KEYWORDS.operator.map(op),
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
