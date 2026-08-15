export type SqlRiskLevel = 'none' | 'write' | 'critical';

export interface SqlRisk {
  level: SqlRiskLevel;
  isWrite: boolean;
  reason?: string;
}

/**
 * 剥离 SQL 中的注释与字符串/标识符字面量，只留下语法骨架用于关键字分类。
 *
 * 必须剥离字面量：分类是全文 `\b关键字\b` 匹配，不做语法分析。若把
 * `SELECT 'DROP TABLE users'` 里的字面量一起看，会判成 DDL/critical，
 * 而 `confirmSqlExecution` 在 `isWrite` 为真时**不会早退**，只读连接会直接
 * 报错拦截 —— 一条纯 SELECT 因为字符串里有 DROP 字样就被禁止执行。
 *
 * 被剥离的部分替换为空格而非删除，避免 `a'x'b` 粘连成新词。
 * 反斜杠转义按 MySQL 语义处理（`\'` 不结束字面量），PG/SQLite 用双写 `''`
 * 结束再立即开始，本函数把它看作两段字面量，结果相同。
 */
function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 块注释
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    // 行注释（-- 与 MySQL 的 #）
    if ((ch === '-' && next === '-') || ch === '#') {
      const nl = sql.indexOf('\n', i);
      out += ' ';
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    // 字符串 / 引号标识符字面量
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        // MySQL 风格反斜杠转义：跳过被转义的下一个字符
        if (sql[i] === '\\' && quote !== '`') { i += 2; continue; }
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 写语句动作类型，供结果面板区分「影响行数」与「成功」两类展示：
 * DML（INSERT/UPDATE/DELETE/REPLACE/MERGE）有受影响行数的语义；
 * DDL（CREATE/ALTER/DROP/TRUNCATE/RENAME/GRANT/REVOKE）与其余控制语句没有，
 * 展示「成功」而非误导性的「0 行受影响」。
 */
export function classifyWriteKind(sql: string): 'dml' | 'ddl' | 'other' {
  const normalized = stripLiteralsAndComments(sql).trim().toUpperCase();
  if (/\b(CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\b/.test(normalized)) return 'ddl';
  if (/\b(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/.test(normalized)) return 'dml';
  return 'other';
}

/** A conservative, dependency-free classifier used by every execution surface. */
export function analyzeSqlRisk(sql: string): SqlRisk {
  const normalized = stripLiteralsAndComments(sql).trim().toUpperCase();
  if (!normalized) return { level: 'none', isWrite: false };

  const isDdl = /\b(CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\b/.test(normalized);
  const isWrite = isDdl || /\b(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/.test(normalized);
  if (!isWrite) return { level: 'none', isWrite: false };
  if (isDdl) return { level: 'critical', isWrite: true, reason: 'DDL or permission change' };

  const updateOrDelete = /\b(UPDATE|DELETE)\b/.test(normalized);
  if (updateOrDelete && !/\bWHERE\b/.test(normalized)) {
    return { level: 'critical', isWrite: true, reason: 'UPDATE or DELETE without WHERE' };
  }
  // INSERT/DELETE/UPDATE even with WHERE is still a write operation
  return { level: 'write', isWrite: true };
}
