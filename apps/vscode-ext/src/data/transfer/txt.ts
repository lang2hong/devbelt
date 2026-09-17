/**
 * 制表符分隔纯文本（TSV, `.txt`）序列化。
 *
 * TSV 无字段引用/转义机制，字段内的制表符与换行会破坏列/行边界，故统一替换为空格。
 * 与 CSV 一样做公式注入防护：以 `=`/`@`/`+`/`-`（非数值）开头的单元格加前导单引号，
 * 避免在 Excel/WPS 打开时被当公式执行。
 */

const NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function guardFormula(text: string): string {
  if (/^[=@\t\r]/.test(text)) return `'${text}`;
  if (/^[+-]/.test(text) && !NUMERIC.test(text)) return `'${text}`;
  return text;
}

function cell(value: unknown): string {
  return guardFormula(formatValue(value)).replace(/[\t\r\n]+/g, ' ');
}

/** 表头行（含行尾 CRLF）。 */
export function txtHeaderLine(columns: string[]): string {
  return columns.map(cell).join('\t') + '\r\n';
}

/** 单数据行（含行尾 CRLF）。 */
export function txtDataLine(columns: string[], row: Record<string, unknown>): string {
  return columns.map((column) => cell(row[column])).join('\t') + '\r\n';
}

export function serializeTxt(columns: string[], rows: Record<string, unknown>[]): string {
  let out = txtHeaderLine(columns);
  for (const row of rows) out += txtDataLine(columns, row);
  return out;
}