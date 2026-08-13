/**
 * 标识符验证工具：防止 SQL 注入。
 *
 * 数据库/表/列名等标识符只允许字母、数字、下划线、$，首字符不能为数字。
 * 验证通过后返回原名；失败抛出 Error。
 * 最大长度 64（MySQL 限制）。
 */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_LEN = 64;

export function validateIdent(name: string): string {
  if (!name || !IDENT_RE.test(name)) {
    throw new Error(`Invalid SQL identifier: "${name}"`);
  }
  if (name.length > MAX_LEN) {
    throw new Error(`SQL identifier too long (max ${MAX_LEN}): "${name.slice(0, 20)}..."`);
  }
  return name;
}
