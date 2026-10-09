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
/** 默认最大长度 64（MySQL 限制）；PostgreSQL 上限为 63（NAMEDATALEN-1）。 */
const MAX_LEN = 64;

export function validateIdent(name: string, maxLen: number = MAX_LEN): string {
  if (!name || !IDENT_RE.test(name) || name.includes('--')) {
    throw new Error(`Invalid SQL identifier: "${name}"`);
  }
  if (name.length > maxLen) {
    throw new Error(`SQL identifier too long (max ${maxLen}): "${name.slice(0, 20)}..."`);
  }
  return name;
}

/**
 * **schema 名**验证（PG 放宽版）。
 *
 * 与 `validateIdent` 的字符白名单不同：schema 名总是经 `wrap`（双引号标识符，
 * 内嵌引号翻倍）或字符串字面量（单引号翻倍）引用，因此含空格、`.`、`"`、`'`
 * 等白名单外字符的**合法** PG schema 可以安全操作。这里只拒绝会破坏引用的
 * 控制字符（NUL/换行等）并保留长度上限。
 *
 * 注入安全由引用层保证：所有调用点必须把结果放进 `wrap(...)`（标识符）或
 * 单引号翻倍的字符串字面量，绝不能裸拼。
 */
export function validateSchemaIdent(name: string, maxLen: number = MAX_LEN): string {
  // eslint-disable-next-line no-control-regex
  if (!name || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`Invalid SQL schema identifier: "${String(name).slice(0, 20)}..."`);
  }
  if (name.length > maxLen) {
    throw new Error(`SQL schema identifier too long (max ${maxLen}): "${name.slice(0, 20)}..."`);
  }
  return name;
}
