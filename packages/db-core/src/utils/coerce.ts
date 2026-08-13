/**
 * 驱动返回值归一化工具。
 *
 * 背景：MysqlConnection 的 typeCast 把非日期类型统一 `buffer.toString()`，
 * 于是 `information_schema` 里的布尔表达式（如 `non_unique = 0 AS is_unique`）
 * 到达上层时是字符串 `"0"` / `"1"`。JS 中 `!!"0" === true`，直接当布尔用会
 * 让所有 0 值被判为真——这曾导致表设计里每个索引的编辑/删除按钮都被禁用。
 */

/** 被视为假的字符串字面量（大小写不敏感）。 */
const FALSY_TOKENS = new Set(['0', 'false', 'no', 'n', 'off', '']);

/**
 * 将驱动返回的任意"布尔"表示归一为 boolean。
 *
 * 处理：boolean 原样；number 按非 0；Buffer 按首字节；
 * 字符串按 FALSY_TOKENS 判否（覆盖 `"0"`、`"NO"`、`"false"`）；
 * null/undefined → false。
 */
export function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (Buffer.isBuffer(value)) return value.length > 0 && value[0] !== 0;
  if (typeof value === 'string') return !FALSY_TOKENS.has(value.trim().toLowerCase());
  return Boolean(value);
}
