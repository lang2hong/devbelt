/**
 * 标识符验证工具：防止 SQL 注入。
 *
 * 数据库/表/列名等标识符允许 Unicode 字母、数字、下划线、`$`、连字符 `-`，
 * 首字符不能为数字或 `-`。允许非 ASCII 与 `-` 是刻意的：中文/日文表名列名、
 * 库里既存带连字符的对象名（如 `happy-crewman`）在三家数据库里都合法，
 * 旧的 `[A-Za-z_$]` 白名单会让这类库完全无法操作。
 *
 * 注入相关字符一律仍被拒绝：引号（`'` `"` `` ` ``）、分号、空白、块注释
 * 标记、括号、逗号、运算符 —— 它们都不属于白名单。`--` 虽由两个
 * 连字符组成，但作为行注释起始仍被显式拒绝。
 *
 * 验证通过后返回原名；失败抛出 Error。最大长度 64（MySQL 限制）。
 */
const IDENT_RE = /^[\p{L}_$][\p{L}\p{N}_$\-]*$/u;
const MAX_LEN = 64;

export function validateIdent(name: string): string {
  if (!name || !IDENT_RE.test(name) || name.includes('--')) {
    throw new Error(`Invalid SQL identifier: "${name}"`);
  }
  if (name.length > MAX_LEN) {
    throw new Error(`SQL identifier too long (max ${MAX_LEN}): "${name.slice(0, 20)}..."`);
  }
  return name;
}
