import { createReadStream } from 'node:fs';

export interface CsvData {
  columns: string[];
  /** 值为 null 表示 CSV 里的未加引号空字段（NULL）；`''` 表示显式空串（`""`）。 */
  rows: Record<string, string | null>[];
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
  // NULL 与空串必须可区分：NULL 写未加引号的空字段，空串写 `""`。否则导出后再导入，
  // 两者都变成同一个值（此前都是空，NULL 与 '' 丢失其一）。
  if (value === null || value === undefined) return '';
  if (value === '') return '""';
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

/** CSV 字段：值 + 是否被引号包裹（用于区分 `""` 空串与未加引号空字段）。 */
export interface CsvCell {
  value: string;
  quoted: boolean;
}

/** 一条完整记录：单元格 + 其在源文件中的物理起始行（1-based）。 */
export interface CsvRecord {
  cells: CsvCell[];
  line: number;
}

/** 行对象上附带源文件物理行号的隐藏键（供导入错误定位；不参与列映射/SQL 生成）。 */
export const CSV_ROW_LINE = Symbol('csvRowLine');

/**
 * 增量 CSV 记录解析器（RFC 4180）：逐块喂入，跨块保持引号/转义状态。
 *
 * 供大文件流式导入使用——`parseCsv` 需要整份文本，GB 级文件会先把内容读进内存。
 * 状态机按字符推进，块边界落在引号内部也不会误断。
 */
export class CsvRecordParser {
  private row: CsvCell[] = [];
  private value = '';
  private quoted = false;
  private cellQuoted = false;
  private pendingCR = false;
  /** 上一块末尾遇到 `"`，尚不能判断它是收尾引号还是 `""` 转义的前半（跨块）。 */
  private pendingQuote = false;
  /** 引号内上一块末尾遇到 `\r`，需下一块首字符判断是 CRLF 还是独立 CR（避免行号多算 1）。 */
  private pendingQuotedCR = false;
  private line = 1;
  private recordStartLine = 1;
  private atRecordStart = true;

  /** 喂入一块文本，返回本次完成的记录（可能为空数组）。 */
  feed(chunk: string): CsvRecord[] {
    const done: CsvRecord[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (this.pendingQuotedCR) {
        this.pendingQuotedCR = false;
        if (ch === '\n') { this.value += ch; this.line++; continue; } // 引号内 CRLF 跨块
        this.line++; // 独立 CR 行尾，继续按引号内内容处理当前字符
      }
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (ch === '"') { this.value += '"'; continue; } // 跨块 `""` → 转义引号
        this.quoted = false; // 前一字符是收尾引号，当前字符按未引用状态处理
      }
      if (this.pendingCR) {
        this.pendingCR = false;
        if (ch === '\n') { this.line++; continue; } // CRLF 的 LF 已随 CR 结束记录
        this.line++; // 独立 CR 行尾
      }
      if (this.atRecordStart && ch !== '\n' && ch !== '\r') {
        this.recordStartLine = this.line;
        this.atRecordStart = false;
      }
      if (this.quoted) {
        if (ch === '"') {
          if (i + 1 < chunk.length) {
            if (chunk[i + 1] === '"') { this.value += '"'; i++; }
            else this.quoted = false;
          } else {
            this.pendingQuote = true;
          }
        } else {
          this.value += ch;
          if (ch === '\n') this.line++;
          else if (ch === '\r') {
            if (i + 1 >= chunk.length) this.pendingQuotedCR = true;
            else if (chunk[i + 1] !== '\n') this.line++;
          }
        }
        continue;
      }
      if (ch === '"') {
        if (this.value) throw new Error('Invalid CSV: quote must start a field.');
        this.quoted = true;
        this.cellQuoted = true;
      } else if (ch === ',') {
        this.row.push({ value: this.value, quoted: this.cellQuoted });
        this.value = '';
        this.cellQuoted = false;
      } else if (ch === '\n' || ch === '\r') {
        this.row.push({ value: this.value, quoted: this.cellQuoted });
        done.push({ cells: this.row, line: this.recordStartLine });
        this.row = [];
        this.value = '';
        this.cellQuoted = false;
        this.atRecordStart = true;
        if (ch === '\r') this.pendingCR = true;
        else this.line++;
      } else {
        this.value += ch;
      }
    }
    return done;
  }

  /** 结束解析：返回最后一条未终止的记录；引号未闭合则报错。 */
  end(): CsvRecord[] {
    if (this.pendingQuote) { this.pendingQuote = false; this.quoted = false; }
    if (this.quoted) throw new Error('Invalid CSV: unterminated quoted field.');
    if (this.value || this.row.length || this.cellQuoted) {
      if (this.atRecordStart) { this.recordStartLine = this.line; this.atRecordStart = false; }
      this.row.push({ value: this.value, quoted: this.cellQuoted });
      const last = this.row;
      this.row = [];
      this.value = '';
      this.cellQuoted = false;
      return [{ cells: last, line: this.recordStartLine }];
    }
    return [];
  }
}

/** 记录是否整行为空（且无显式空串）：用于跳过尾随空行。 */
function isBlankRecord(record: CsvCell[]): boolean {
  return record.every((cell) => cell.value === '' && !cell.quoted);
}

/** 由表头记录得到列名（去掉 BOM，无表头则生成 Column N）。 */
function columnsFromRecord(record: CsvCell[], hasHeader: boolean): string[] {
  const first = record.map((cell, index) => (index === 0 ? cell.value.replace(/^\uFEFF/, '') : cell.value));
  return hasHeader ? first : first.map((_, index) => `Column ${index + 1}`);
}

/** 把一条记录转为行对象：未加引号空字段 → null，`""` → ''，其余 unguardFormula。 */
function recordToRow(columns: string[], record: CsvCell[], line?: number): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  columns.forEach((column, index) => {
    const cell = record[index];
    out[column] = !cell || (cell.value === '' && !cell.quoted) ? null : unguardFormula(cell.value);
  });
  // 附带物理行号：跳过的空白行不会让导入错误行号偏移。用不可枚举的 symbol 键，
  // 既不会被列映射/SQL 生成看到，也不影响对行对象做深比较。
  if (line !== undefined) Object.defineProperty(out, CSV_ROW_LINE, { value: line, enumerable: false });
  return out;
}

function validateColumns(columns: string[]): void {
  if (columns.some((column) => !column.trim())) throw new Error('CSV headers cannot be empty.');
  if (new Set(columns).size !== columns.length) throw new Error('CSV headers must be unique.');
}

/**
 * Parses comma-separated text with quoted fields, escaped quotes, and CRLF/LF
 * line endings. Empty cells become null (NULL); explicit `""` becomes ''.
 */
export function parseCsv(text: string, hasHeader = true): CsvData {
  const parser = new CsvRecordParser();
  const records = [...parser.feed(text), ...parser.end()];
  // 去掉文件开头「仅一个空字段」的空行（原行为）。
  if (records.length && records[0].cells.length === 1 && records[0].cells[0].value === '' && !records[0].cells[0].quoted) records.shift();
  if (!records.length) return { columns: [], rows: [] };

  const columns = columnsFromRecord(records[0].cells, hasHeader);
  validateColumns(columns);
  const values = hasHeader ? records.slice(1) : records;
  return { columns, rows: values.filter((r) => !isBlankRecord(r.cells)).map((r) => recordToRow(columns, r.cells)) };
}

/** 逐块产出 CSV 记录（跨块保持引号状态），不把整文件读入内存。 */
async function* readCsvRecords(filePath: string, chunkSize: number): AsyncGenerator<CsvRecord> {
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: chunkSize });
  const parser = new CsvRecordParser();
  for await (const chunk of stream) {
    for (const record of parser.feed(chunk as string)) yield record;
  }
  for (const record of parser.end()) yield record;
}

/**
 * 流式读取 CSV：逐行 yield 行对象，全程只驻留一个解析器与当前块。
 *
 * 首个记录作为表头（`hasHeader`）用于列名；无表头则生成 `Column N`。
 */
export async function* streamCsvRows(
  filePath: string,
  hasHeader = true,
  chunkSize = 1 << 20,
): AsyncGenerator<Record<string, string | null>> {
  let columns: string[] | undefined;
  let first = true;
  for await (const record of readCsvRecords(filePath, chunkSize)) {
    if (first) {
      first = false;
      if (record.cells.length === 1 && record.cells[0].value === '' && !record.cells[0].quoted) continue; // 开头空行
      columns = columnsFromRecord(record.cells, hasHeader);
      validateColumns(columns);
      if (hasHeader) continue;
    }
    if (!columns || isBlankRecord(record.cells)) continue;
    yield recordToRow(columns, record.cells, record.line);
  }
}

/**
 * 只读前若干行 + 表头，用于导入向导的列/映射预览（无需整文件读入）。
 */
export async function readCsvSample(
  filePath: string,
  hasHeader = true,
  sampleSize = 200,
  chunkSize = 1 << 20,
): Promise<CsvData> {
  let columns: string[] | undefined;
  const rows: Record<string, string | null>[] = [];
  let first = true;
  for await (const record of readCsvRecords(filePath, chunkSize)) {
    if (first) {
      first = false;
      if (record.cells.length === 1 && record.cells[0].value === '' && !record.cells[0].quoted) continue;
      columns = columnsFromRecord(record.cells, hasHeader);
      validateColumns(columns);
      if (hasHeader) continue;
    }
    if (!columns || isBlankRecord(record.cells)) continue;
    rows.push(recordToRow(columns, record.cells, record.line));
    if (rows.length >= sampleSize) break;
  }
  return { columns: columns ?? [], rows };
}
