/**
 * 字符串字面量**内容**的转义规则（不含外层引号）——全仓单一来源。
 *
 * 方言 `escapeValue` 与编辑器侧 `utils/sql.ts` 的 `escapeSqlString` 都从这里取规则，
 * 避免两处各写一份而漂移（曾出现 MySQL 侧漏转义 NUL、PG 侧过度翻倍反斜杠的差异）。
 *
 * - 单引号一律翻倍（三家数据库通用）。
 * - `backslashEscapes` 为真：反斜杠翻倍、NUL 写成 `\0`（MySQL 默认模式）。
 *   `NO_BACKSLASH_ESCAPES` 时反斜杠是普通字符，传 false。
 * - PG（standard_conforming_strings=on）与 SQLite 反斜杠无转义语义，传 false。
 */
export function escapeStringLiteralContent(raw: string, backslashEscapes = false): string {
  const quoted = raw.replace(/'/g, "''");
  return backslashEscapes ? quoted.replace(/\\/g, '\\\\').replace(/\0/g, '\\0') : quoted;
}