/**
 * 敏感列黑名单（精确词边界，不做子串匹配）：`monkey`/`keyboard` 等无辜列名
 * 不应因含 `key` 被误伤。黑名单只是**辅助提示**——样本行是否外发的主边界是
 * "默认不发 + 单次确认"；命中列用于 schema 标记 `[SENSITIVE]` 与样本 cell 打码。
 */
const SENSITIVE_COLUMN_RE =
  /^(password|passwd|pwd|token|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|hash|credit[_-]?card|ssn)$/i;

export function isSensitiveColumnName(name: string): boolean {
  return SENSITIVE_COLUMN_RE.test(name.trim());
}

export const REDACTED_CELL = '[REDACTED]';
export const BINARY_CELL = '[BINARY]';

export interface RowSampleOptions {
  /** 最多发送的行数，默认 10。 */
  maxRows?: number;
  /** 单 cell 截断长度，默认 64 字符。 */
  maxCellChars?: number;
  isSensitive?: (column: string) => boolean;
}

export interface RowSample {
  /** JSON-lines 格式的样本（首行为数量说明）。 */
  lines: string[];
  rowsSent: number;
  totalRows: number;
  redactedCells: number;
}

const DEFAULT_MAX_ROWS = 10;
const DEFAULT_MAX_CELL_CHARS = 64;

/**
 * 把结果集行样本格式化为 JSON-lines：按列序取值、敏感列打码、cell 截断、
 * 二进制占位。调用方应先经用户确认再发送。
 */
export function formatRowSample(
  columns: string[],
  rows: Array<Record<string, unknown>>,
  options: RowSampleOptions = {},
): RowSample {
  const maxRows = Math.max(options.maxRows ?? DEFAULT_MAX_ROWS, 0);
  const maxCellChars = Math.max(options.maxCellChars ?? DEFAULT_MAX_CELL_CHARS, 16);
  const isSensitive = options.isSensitive ?? isSensitiveColumnName;

  const totalRows = rows.length;
  const sent = rows.slice(0, maxRows);
  const lines: string[] = [`# sample rows (first ${sent.length} of ${totalRows})`];
  let redactedCells = 0;

  for (const row of sent) {
    const record: Record<string, unknown> = {};
    for (const column of columns) {
      if (isSensitive(column)) {
        record[column] = REDACTED_CELL;
        redactedCells += 1;
      } else {
        record[column] = sanitizeCell(row[column], maxCellChars);
      }
    }
    lines.push(JSON.stringify(record));
  }

  return { lines, rowsSent: sent.length, totalRows, redactedCells };
}

function sanitizeCell(value: unknown, maxCellChars: number): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return BINARY_CELL;
  if (typeof value === 'string') return truncate(value, maxCellChars);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return '[OBJECT]';
  }
  if (json === undefined) return '[OBJECT]';
  return truncate(json, maxCellChars);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}