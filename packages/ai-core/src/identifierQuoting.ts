/**
 * 保留字标识符本地兜底加引号（P9：修「模型直出裸 condition/order 等 MySQL 保留字 → 语法错」）。
 *
 * 设计口径：
 * - **精选保留字表**：只处理「现实中可能作为列/表名」的保留字子集（condition/usage/
 *   rank/order/group/desc/asc/limit/interval/range/rows），不引全量保留字表（250+），
 *   把误伤面压到最小；
 * - **上下文守卫**（防把关键字用法错引成标识符）：
 *   - 后随 `BY` → 跳过（ORDER BY / GROUP BY）；
 *   - 后随数字 → 跳过（LIMIT 10 / INTERVAL 7 DAY / ROWS 2 PRECEDING / RANGE n）；
 *   - 后随 `(` → 跳过（RANK() OVER 等函数用法）；
 *   - `DESC`/`ASC` 仅在「表达式起始位」（SELECT/FROM/WHERE/AND/OR/ON/WHEN/THEN/ELSE/
 *     CASE/逗号/圆括号/`=`/`.`/LIKE/NOT/BY 之后）才加引——排序方向（`ORDER BY x DESC`）
 *     后临裸标识符必跳；
 * - 字符串字面量 / 注释 / 已加引标识符内**一律不动**；`t.condition` 限定列照样补引。
 * - 方言：MySQL/SQLite → 反引号；PostgreSQL → 双引号；其它/未知 → 原样（fail-open）。
 */

/** 精选「可能作列/表名」的保留字（大小写不敏感）。 */
const RESERVED_IDENTIFIER_WORDS = new Set([
  'condition',
  'usage',
  'rank',
  'order',
  'group',
  'desc',
  'asc',
  'limit',
  'interval',
  // 注：rows/range 故意不入表——窗口帧（ROWS BETWEEN / RANGE CURRENT ROW）关键字用法
  // 与列名无法用轻量守卫区分，误引会破坏合法 SQL；宁可不修也不误伤。
]);

/** DESC/ASC 视为列名时要求的前一个记号（表达式起始位；含 CASE 系列关键字）。 */
const DIRECTION_COLUMN_PREV = new Set([
  'select', 'from', 'where', 'and', 'or', 'on', 'by', 'not', 'like',
  'when', 'then', 'else', 'case', ',', '(', '=', '.',
]);

/** PostgreSQL 方言标识符引号；MySQL/SQLite 用反引号。 */
const PG_DB_TYPES = new Set(['pg', 'postgres', 'postgresql']);

function isWordStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}
function isDigit(c: string): boolean {
  return /[0-9]/.test(c);
}

/** 保留字记号在裸文中需要补引时，用方言引号包裹（保留原大小写）。 */
function quoteWord(word: string, dbType?: string): string {
  const q = PG_DB_TYPES.has(String(dbType ?? '').toLowerCase()) ? '"' : '`';
  return `${q}${word}${q}`;
}

/**
 * 对单条 SQL 的裸保留字标识符补方言引号。纯字符串变换、零 SQL 解析依赖；
 * 守卫规则见文件头。不认识的方言返回原文（fail-open，不制造新错误）。
 */
export function quoteReservedIdentifiers(sql: string, dbType?: string): string {
  const normalized = String(dbType ?? '').toLowerCase();
  const known = PG_DB_TYPES.has(normalized)
    || normalized === 'mysql'
    || normalized === 'mariadb'
    || normalized === 'sqlite';
  if (!known) return sql;

  let out = '';
  let i = 0;
  const n = sql.length;
  // 上一个「有意义的」记号（跳过空白后）；初始为空（行首视作表达式起始位）。
  let prevToken = '';

  /** 从 `from`（词尾）向后取下一个有意义的记号（跳过空白）。 */
  const peekNextToken = (from: number): { token: string; isNumber: boolean } => {
    let j = from;
    while (j < n && /\s/.test(sql[j]!)) j += 1;
    if (j >= n) return { token: '', isNumber: false };
    const c = sql[j]!;
    if (isDigit(c)) return { token: c, isNumber: true };
    if (c === '(') return { token: '(', isNumber: false };
    if (isWordStart(c)) {
      let k = j;
      while (k < n && isWordChar(sql[k]!)) k += 1;
      return { token: sql.slice(j, k).toLowerCase(), isNumber: false };
    }
    return { token: c, isNumber: false };
  };

  while (i < n) {
    const c = sql[i]!;

    // 字符串字面量 / 反引号 / 双引号段：原样拷贝，内部不做任何改写。
    if (c === "'" || c === '`' || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === quote) {
          if (quote !== "'" || sql[j + 1] !== "'") break; // '' 转义继续
          j += 1;
        }
        j += 1;
      }
      out += sql.slice(i, Math.min(j + 1, n));
      prevToken = quote === '`' || quote === '"' ? 'quoted' : 'str';
      i = Math.min(j + 1, n);
      continue;
    }

    // 行注释 / 块注释：原样拷贝。
    if (c === '-' && sql[i + 1] === '-') {
      let j = i;
      while (j < n && sql[j] !== '\n') j += 1;
      out += sql.slice(i, j);
      i = j;
      prevToken = '';
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) j += 1;
      out += sql.slice(i, Math.min(j + 2, n));
      i = Math.min(j + 2, n);
      prevToken = '';
      continue;
    }

    // 裸词。
    if (isWordStart(c)) {
      let j = i;
      while (j < n && isWordChar(sql[j]!)) j += 1;
      const word = sql.slice(i, j);
      const lower = word.toLowerCase();
      if (RESERVED_IDENTIFIER_WORDS.has(lower)) {
        const next = peekNextToken(j);
        const followedByBy = next.token === 'by';
        const followedByNumber = next.isNumber;
        const followedByParen = next.token === '(';
        // 后随引号（INTERVAL '7' DAY 之类字面量形态）→ 关键字用法，跳过。
        const followedByQuote = next.token === "'" || next.token === '"';
        const prevIsIdentifier = /^[a-z0-9_$]+$/.test(prevToken) && !DIRECTION_COLUMN_PREV.has(prevToken);
        const isDirection = lower === 'desc' || lower === 'asc';
        const quotable = !followedByBy && !followedByNumber && !followedByParen && !followedByQuote
          && (isDirection ? DIRECTION_COLUMN_PREV.has(prevToken) : !prevIsIdentifier);
        if (quotable) {
          out += quoteWord(word, dbType);
          prevToken = 'quoted';
          i = j;
          continue;
        }
      }
      out += word;
      prevToken = lower;
      i = j;
      continue;
    }

    // 其它字符（运算符/逗号/括号/空白/数字）。
    if (!/\s/.test(c)) prevToken = c;
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 对 Markdown 回复中 ```sql 围栏内的 SQL 应用保留字补引；围栏外文本与其它语言块
 * 一律不动。未闭合围栏（流中断）按「围栏至文末」处理。
 */
export function quoteReservedIdentifiersInMarkdown(content: string, dbType?: string): string {
  if (!content.includes('```')) return content;
  const lines = content.split('\n');
  const out: string[] = [];
  let inSqlFence = false;
  for (const line of lines) {
    const fenceMatch = /^\s*```/.test(line);
    if (fenceMatch) {
      if (!inSqlFence && /^```sql\s*$/i.test(line.trim())) {
        inSqlFence = true;
        out.push(line);
        continue;
      }
      if (inSqlFence) {
        // 围栏内的 SQL 已在累积时逐行处理；此行是闭合围栏。
        out.push(line);
        inSqlFence = false;
        continue;
      }
    }
    if (inSqlFence) {
      out.push(quoteReservedIdentifiers(line, dbType));
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}