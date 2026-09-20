import { createReadStream } from 'node:fs';
export interface JsonData {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** 按列顺序投影一行（缺失列补 null），供 JSON 序列化/流式导出共用。 */
export function projectRow(columns: string[], row: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const column of columns) projected[column] = row[column] ?? null;
  return projected;
}

/** Serializes tabular values as readable JSON without changing column order. */
export function serializeJson(columns: string[], rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows.map((row) => projectRow(columns, row)), null, 2) + '\n';
}

/** Accepts an object or an array of objects, matching common Navicat JSON exports. */
export function parseJson(text: string): JsonData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${(error as Error).message}`);
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (!values.every((value) => value !== null && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('JSON import requires an object or an array of objects.');
  }
  const rows = values as Record<string, unknown>[];
  const columns: string[] = [];
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!columns.includes(column)) columns.push(column);
    }
  }
  return { columns, rows };
}

/**
 * 增量 JSON 值扫描器：从「对象或对象数组」中逐块解析出顶层对象。
 *
 * 大 JSON 不能整份 `JSON.parse`（内存翻数倍）。这里按字符推进（跟踪字符串/转义/
 * 括号深度），每完成一个顶层对象就 `JSON.parse` 该片段并释放，兼容数组与单对象。
 */
export class JsonValueScanner {
  private buf = '';
  private mode: 'init' | 'array' | 'single' | 'done' = 'init';
  private depth = 0;
  private inStr = false;
  private esc = false;
  private start = -1;
  private arrayClosed = false;
  /** 已扫描到的位置（相对 buf）。必须持久：buf 跨块累积，从头重扫会把已消费的开括号再计一次。 */
  private pos = 0;

  feed(chunk: string): Record<string, unknown>[] {
    this.buf += chunk;
    const out: Record<string, unknown>[] = [];
    while (this.pos < this.buf.length && this.mode !== 'done') {
      const ch = this.buf[this.pos];
      if (this.mode === 'init') {
        if (/\s/.test(ch)) { this.pos++; continue; }
        if (ch === '[') { this.mode = 'array'; this.pos++; continue; }
        if (ch === '{') { this.mode = 'single'; this.start = this.pos; this.depth = 1; this.inStr = false; this.esc = false; this.pos++; continue; }
        throw new Error('JSON import requires an object or an array of objects.');
      }
      if (this.mode === 'array' && this.depth === 0 && !this.inStr) {
        // 数组元素必须是对象：吞掉标量/嵌套数组会让导入「成功」却丢数据，必须显式报错。
        if (/\s/.test(ch) || ch === ',') { this.pos++; continue; }
        if (ch === '{') { this.start = this.pos; this.depth = 1; this.inStr = false; this.esc = false; this.pos++; continue; }
        if (ch === ']') { this.mode = 'done'; this.arrayClosed = true; this.pos++; continue; }
        throw new Error(`Invalid JSON: unexpected token '${ch}' in array.`);
      }
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (ch === '\\') this.esc = true;
        else if (ch === '"') this.inStr = false;
        this.pos++; continue;
      }
      if (ch === '"') { this.inStr = true; this.pos++; continue; }
      if (ch === '{') { if (this.depth === 0) this.start = this.pos; this.depth++; this.pos++; continue; }
      if (ch === '[') { this.depth++; this.pos++; continue; }
      if (ch === '}') {
        this.depth--;
        if (this.depth === 0) {
          out.push(this.parseElement(this.pos));
          this.buf = this.buf.slice(this.pos + 1);
          this.pos = 0;
          this.mode = this.mode === 'single' ? 'done' : 'array';
          continue;
        }
        this.pos++; continue;
      }
      if (ch === ']') {
        if (this.depth === 0) { this.mode = 'done'; this.pos++; continue; } // 顶层数组结束
        this.depth--; this.pos++; continue;
      }
      this.pos++;
    }
    return out;
  }

  private parseElement(endIndex: number): Record<string, unknown> {
    const value = JSON.parse(this.buf.slice(this.start, endIndex + 1));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('JSON import requires an object or an array of objects.');
    }
    return value as Record<string, unknown>;
  }

  end(): void {
    if (this.mode === 'done') return;
    if (this.inStr) throw new Error('Invalid JSON: unterminated string.');
    // 对象/数组未闭合（depth>0），或顶层数组未遇到 `]` —— 都不能当作正常结束。
    if (this.depth > 0) throw new Error('Invalid JSON: unexpected end of input.');
    if (this.mode === 'array' && !this.arrayClosed) throw new Error('Invalid JSON: unexpected end of input.');
    const rest = this.buf.slice(this.pos).trim();
    if (rest === '') return;
    throw new Error('Invalid JSON: unexpected end of input.');
  }
}

/** 流式读取 JSON 行（对象或对象数组），逐对象 yield。 */
export async function* streamJsonRows(filePath: string, chunkSize = 1 << 20): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: chunkSize });
  const scanner = new JsonValueScanner();
  for await (const chunk of stream) {
    for (const row of scanner.feed(chunk as string)) yield row;
  }
  scanner.end();
}

/** 只读前若干行 + 列名，用于导入向导预览。 */
export async function readJsonSample(filePath: string, sampleSize = 200, chunkSize = 1 << 20): Promise<JsonData> {
  const rows: Record<string, unknown>[] = [];
  const columns: string[] = [];
  for await (const row of streamJsonRows(filePath, chunkSize)) {
    for (const column of Object.keys(row)) {
      if (!columns.includes(column)) columns.push(column);
    }
    rows.push(row);
    if (rows.length >= sampleSize) break;
  }
  return { columns, rows };
}
