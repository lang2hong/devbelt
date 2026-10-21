/**
 * 结果网格的纯逻辑（不依赖 Vue/宿主），供单测锁定行为契约。
 *
 * 这些函数此前内联在 ResultGrid.vue 中：方言引用、插入列语义、复制 INSERT。
 * 抽出来是为了能在本地/CI 直接单测，避免"改了但没人测"的回归。
 */

/** 标识符引用：MySQL 反引号；PG/SQLite 双引号（并转义内部双引号）。 */
export function identifierQuote(dbType: string | undefined, name: string): string {
  return dbType === 'MYSQL' ? `\`${name}\`` : `"${name.replace(/"/g, '""')}"`;
}

/** SQL 字面量：null/undefined → NULL，其余按字符串转义。 */
export function quoteLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 十进制数值文本（允许符号、小数、指数）。
 *
 * 网格的数值列输入不能用 `type="number"`：Vue 会把值转成 Number，BIGINT 与
 * 带标度的 DECIMAL 一旦超过 2^53 就会被静默截断。改成文本输入后，合法性由
 * 这里判断；空串不算数字，是否允许留空由调用方决定。
 */
const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function isNumericText(raw: string): boolean {
  return NUMERIC_TEXT.test(raw.trim());
}

/**
 * 插入行负载：**留空 = 省略该列**（交给数据库默认值/自增/可空默认），
 * 字面 `NULL`（大小写不敏感）= 显式 SQL NULL，其余按字面字符串。
 * 旧实现把未填列显式写 NULL，导致 DEFAULT/NOW() 失效、PG serial 报错。
 */
export function buildInsertPayload(
  fields: readonly string[],
  values: Record<string, unknown>,
): { columns: string[]; values: (string | null)[] } {
  const columns: string[] = [];
  const out: (string | null)[] = [];
  for (const name of fields) {
    const raw = values[name];
    if (raw === undefined || raw === '') continue;
    const text = String(raw);
    columns.push(name);
    out.push(/^null$/i.test(text) ? null : text);
  }
  return { columns, values: out };
}

/** 生成复制用的 INSERT 语句（方言化标识符）。 */
export function buildInsertStatement(
  table: string | undefined,
  dbName: string | undefined,
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
  dbType: string | undefined,
  schema?: string,
): string {
  if (!table || rows.length === 0) return '';
  const q = (n: string) => identifierQuote(dbType, n);
  // PG 的限定是 **schema**（dbName 是库名，用它限定会被解析成 schema 而写错对象）；其它方言用库名。
  const qualifier = dbType === 'PG' ? schema : dbName;
  const target = qualifier ? `${q(qualifier)}.${q(table)}` : q(table);
  const colList = columns.map(q).join(', ');
  // 数字/布尔不加引号（否则复制出的 INSERT 在 PG 等严格类型下语义/类型不对）。
  const fmt = (v: unknown): string =>
    (typeof v === 'number' || typeof v === 'boolean') ? String(v) : quoteLiteral(v);
  return rows
    .map((row) => `INSERT INTO ${target} (${colList}) VALUES (${columns.map((c) => fmt(row[c])).join(', ')});`)
    .join('\n');
}
/** 网格 → 扩展的消息负载（抽出以便契约单测，避免字段名悄悄错位）。 */
export interface UpdateCellMessage {
  type: 'updateCell';
  pkColumns: string[];
  pkValues: unknown[];
  column: string;
  value: string;
}
export interface DeleteRowsMessage {
  type: 'deleteRows';
  rows: { pkColumns: string[]; pkValues: unknown[] }[];
}

export function updateCellMessage(pkColumns: string[], pkValues: unknown[], column: string, value: string): UpdateCellMessage {
  return { type: 'updateCell', pkColumns, pkValues, column, value };
}

export function deleteRowsMessage(rows: { pkColumns: string[]; pkValues: unknown[] }[]): DeleteRowsMessage {
  return { type: 'deleteRows', rows };
}

/** 结果复制格式。 */
export type CopyFormat = 'tsv' | 'csv' | 'json';

/** 单值 → 剪贴板文本：NULL 明确显示，BLOB 不展开巨量字节，对象转 JSON。 */
export function clipboardCellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    const v = value as { type?: string; data?: unknown };
    if (v.type === 'Buffer' && Array.isArray(v.data)) return `[BLOB ${v.data.length}B]`;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function escapeDelimited(text: string, delimiter: string): string {
  if (text.includes('"') || text.includes('\n') || text.includes('\r') || text.includes(delimiter)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** 结果集 → TSV/CSV/JSON 文本（带表头；范围由调用方决定）。 */
export function clipboardRowsText(
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
  format: CopyFormat,
): string {
  if (format === 'json') {
    const objects = rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c]])));
    return JSON.stringify(objects, (_key, value) => {
      const v = value as { type?: string; data?: unknown } | null;
      if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) return `[BLOB ${v.data.length}B]`;
      return value;
    }, 2);
  }
  const delimiter = format === 'csv' ? ',' : '\t';
  const lineEnd = format === 'csv' ? '\r\n' : '\n';
  const lines = [columns.map((c) => escapeDelimited(c, delimiter)).join(delimiter)];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeDelimited(clipboardCellText(row[c]), delimiter)).join(delimiter));
  }
  return lines.join(lineEnd);
}
