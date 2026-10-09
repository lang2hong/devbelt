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
  if (!/^[A-Za-z"]/.test(type)) throw new Error('Column type must start with a letter.');
  if (!/^[A-Za-z0-9_ (),.'"\[\]-]+$/.test(type)) {
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

/** 默认值字面量：数字与时间关键字原样写入，其余按方言规则转义为字符串。 */
export function renderDefaultLiteral(value: string, esc: (value: any) => string): string {
  const keyword = /^(CURRENT_TIMESTAMP(\(\d*\))?|CURRENT_DATE|CURRENT_TIME|NULL|TRUE|FALSE)$/i;
  return /^-?\d+(\.\d+)?$/.test(value) || keyword.test(value) ? value : esc(value);
}

/**
 * 列属性（类型 + 约束 + 默认值 + 注释），不含列名。类型经白名单校验，值经方言转义。
 *
 * 由 TableService（建表/改列）与 SchemaDiffService（结构同步）共用，避免两份实现漂移：
 * 同步侧曾只发「类型 + NULL/NOT NULL」，把 DEFAULT/自增/注释/字符集静默丢弃。
 */
export function renderColumnAttributes(
  col: ColumnSpec,
  dbType: string,
  esc: (value: any) => string,
  sqliteInlinePk = false,
  /**
   * 默认值已由源库给成**表达式原文**（PG 的 `column_default` 如
   * `'x'::character varying` / `nextval('t_id_seq'::regclass)`），需原样透传，
   * 不能按字符串字面量再转义。仅结构同步的 PG 分支使用。
   */
  rawDefault = false,
): string {
  const type = validateColumnType(col.type);
  const parts: string[] = [];

  if (col.autoIncrement && dbType === 'PG') {
    parts.push(/big/i.test(type) ? 'BIGSERIAL' : 'SERIAL');
  } else if (col.autoIncrement && dbType === 'SQLITE') {
    parts.push('INTEGER');
  } else {
    parts.push(type);
  }

  if (sqliteInlinePk && col.autoIncrement) {
    parts.push('PRIMARY KEY AUTOINCREMENT');
    return parts.join(' ');
  }
  // PG 的 SERIAL 已隐含 NOT NULL，再写一遍合法但冗余
  if ((col.notNull || col.isPrimary) && !(col.autoIncrement && dbType === 'PG')) {
    parts.push('NOT NULL');
  }
  if (col.autoIncrement && dbType === 'MYSQL') parts.push('AUTO_INCREMENT');
  if (col.defaultValue !== undefined && col.defaultValue !== '' && !col.autoIncrement) {
    parts.push(`DEFAULT ${rawDefault ? String(col.defaultValue) : renderDefaultLiteral(col.defaultValue, esc)}`);
  }
  // 列内联 COMMENT 是 MySQL 语法，PG/SQLite 的 CREATE TABLE 不接受
  if (col.comment && dbType === 'MYSQL') parts.push(`COMMENT ${esc(col.comment)}`);
  return parts.join(' ');
}