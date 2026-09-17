/** 结构化列定义（不含列名），供新增/修改列使用。 */
export interface ColumnSpec {
  /** 列类型原文，如 `VARCHAR(255)`、`INT`、`ENUM('a','b')`。经严格校验后才拼入 SQL。 */
  type: string;
  notNull?: boolean;
  isPrimary?: boolean;
  autoIncrement?: boolean;
  /** 默认值原文；数字与 CURRENT_TIMESTAMP 等关键字原样写入，其余按字符串转义。 */
  defaultValue?: string;
  /** 列注释（仅 MySQL 支持列内联 COMMENT，其余方言忽略）。 */
  comment?: string;
}

/** 建表时的单列定义（含列名）。 */
export interface NewColumnSpec extends ColumnSpec {
  name: string;
}

/**
 * 列类型文法校验。
 *
 * 列类型是唯一无法参数化、必须拼进 SQL 的用户输入（其余走标识符转义 / 值转义）。
 * 因此这里用**白名单 + 结构检查**而不是黑名单：只允许字母/数字/下划线/空格/括号/
 * 逗号/点/连字符/单引号/方括号（PG 数组类型如 `integer[]`），且括号闭合、单引号成对；
 * 显式拒绝语句分隔符、注释起始符、换行、反引号/双引号/反斜杠。
 */
export function validateColumnType(raw: string): string {
  const type = String(raw ?? '').trim();
  if (!type) throw new Error('Column type is required.');
  if (type.length > 64) throw new Error('Column type is too long (max 64 characters).');
  if (!/^[A-Za-z]/.test(type)) throw new Error('Column type must start with a letter.');
  if (!/^[A-Za-z0-9_ (),.'\[\]-]+$/.test(type)) {
    throw new Error('Column type contains invalid characters.');
  }
  if (/--/.test(type)) throw new Error('Column type contains invalid characters.');

  let depth = 0;
  for (const ch of type) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) throw new Error('Column type has unbalanced parentheses.');
    }
  }
  if (depth !== 0) throw new Error('Column type has unbalanced parentheses.');

  // `[]` 用于 PG 数组类型（integer[]、text[][]）；同样要求配平，避免半截形状。
  let brackets = 0;
  for (const ch of type) {
    if (ch === '[') brackets++;
    else if (ch === ']') {
      brackets--;
      if (brackets < 0) throw new Error('Column type has unbalanced brackets.');
    }
  }
  if (brackets !== 0) throw new Error('Column type has unbalanced brackets.');

  const quotes = type.replace(/''/g, '').match(/'/g)?.length ?? 0;
  if (quotes % 2 !== 0) throw new Error('Column type has an unterminated string literal.');

  return type;
}