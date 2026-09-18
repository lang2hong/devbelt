export interface CsvData {
  columns: string[];
  rows: Record<string, string>[];
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 合法数值（含正负号、小数、科学计数法），用于豁免数列被误加公式前缀。 */
const NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/;

/**
 * CSV 公式注入防护：以 `=` `@` 或制表符/CR 开头的单元格，以及以 `+` `-`
 * 开头但非数值的内容，在 Excel/WPS 打开时会被当作公式/命令执行。加前导
 * 单引号使其按文本处理（其他解析器读到的是明文，仅抑制电子表格公式求值）。
 */
function guardFormula(text: string): string {
  if (/^[=@\t\r]/.test(text)) return `'${text}`;
  if (/^[+-]/.test(text) && !NUMERIC.test(text)) return `'${text}`;
  return text;
}

/**
 * 导入时还原导出加入的公式防护前缀：`'=SUM(A1)` → `=SUM(A1)`。
 * 只剥离**符合防护形态**的那一层（`'` 后接 `= @ tab CR`，或非数值的 `+ -`），
 * 避免误伤用户真实存储的前导单引号。
 */
export function unguardFormula(text: string): string {
  if (!text.startsWith("'")) return text;
  const rest = text.slice(1);
  if (/^[=@\t\r]/.test(rest)) return rest;
  if (/^[+-]/.test(rest) && !NUMERIC.test(rest)) return rest;
  return text;
}

function escapeCell(value: unknown): string {
  const text = guardFormula(formatValue(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 表头行（含行尾 CRLF）。 */
export function csvHeaderLine(columns: string[]): string {
  return columns.map(escapeCell).join(',') + '\r\n';
}

/** 单数据行（含行尾 CRLF），供流式导出逐行写出。 */
export function csvDataLine(columns: string[], row: Record<string, unknown>): string {
  return columns.map((column) => escapeCell(row[column])).join(',') + '\r\n';
}

/** Serializes tabular data as RFC 4180-compatible UTF-8 CSV. */
export function serializeCsv(columns: string[], rows: Record<string, unknown>[]): string {
  let out = csvHeaderLine(columns);
  for (const row of rows) out += csvDataLine(columns, row);
  return out;
}

/**
 * Parses comma-separated text with quoted fields, escaped quotes, and CRLF/LF
 * line endings. Empty cells remain empty strings so users can decide whether
 * they represent an empty value or NULL in the destination table.
 */
export function parseCsv(text: string, hasHeader = true): CsvData {
  const records: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (quoted) {
      if (ch === '"' && text[index + 1] === '"') {
        value += '"';
        index++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        value += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (value) throw new Error('Invalid CSV: quote must start a field.');
      quoted = true;
    } else if (ch === ',') {
      row.push(value);
      value = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[index + 1] === '\n') index++;
      row.push(value);
      records.push(row);
      row = [];
      value = '';
    } else {
      value += ch;
    }
  }
  if (quoted) throw new Error('Invalid CSV: unterminated quoted field.');
  if (value || row.length) {
    row.push(value);
    records.push(row);
  }
  if (records.length && records[0].length === 1 && records[0][0] === '') records.shift();
  if (!records.length) return { columns: [], rows: [] };

  const first = records[0].map((cell, index) => index === 0 ? cell.replace(/^\uFEFF/, '') : cell);
  const columns = hasHeader ? first : first.map((_, index) => `Column ${index + 1}`);
  if (columns.some((column) => !column.trim())) throw new Error('CSV headers cannot be empty.');
  if (new Set(columns).size !== columns.length) throw new Error('CSV headers must be unique.');

  const values = hasHeader ? records.slice(1) : records;
  return {
    columns,
    rows: values.filter((record) => record.some((cell) => cell !== '')).map((record) => {
      const out: Record<string, string> = {};
      columns.forEach((column, index) => { out[column] = unguardFormula(record[index] ?? ''); });
      return out;
    }),
  };
}
