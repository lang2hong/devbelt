import { createReadStream } from 'node:fs';

/**
 * 简易 XML 导入/导出（`<rows><row>…</row></rows>`）。
 *
 * 列名放在 `<col name="…">` 属性里，而不是当作元素名：
 *  - 元素名不允许空格/`<`/`&`/非 ASCII，直接当标签名会破坏结构或需要改名；
 *    改名又会把两个不同的列名（`a b` 与 `a_b`）折叠成同名列，往返后**丢列**。
 *  - 属性里可放任意列名（转义即可），往返保真。
 * `nil="true"` 表示 NULL，与空串区分。解析同时兼容旧的「标签名=列名」格式。
 */

export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // `&amp;` 必须最后还原，否则 `&amp;lt;` 会被先当成 `&lt;` 再解成 `<`。
    .replace(/&amp;/g, '&');
}

export function parseXml(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
  const colRegex = /<col\b([^>]*)>([\s\S]*?)<\/col>/gi;
  const legacyFieldRegex = /<([\w.:-]+)>([\s\S]*?)<\/\1>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(text)) !== null) {
    const inner = rowMatch[1];
    const row: Record<string, unknown> = {};
    let found = false;

    colRegex.lastIndex = 0;
    let colMatch: RegExpExecArray | null;
    while ((colMatch = colRegex.exec(inner)) !== null) {
      const attrs = colMatch[1] ?? '';
      const name = /\bname="([^"]*)"/.exec(attrs)?.[1];
      if (name === undefined) continue;
      const isNull = /\bnil="(?:true|1)"/.test(attrs);
      row[unescapeXml(name)] = isNull ? null : unescapeXml(colMatch[2]);
      found = true;
    }

    // 兼容旧格式（元素名即列名）：新格式的行不会有 <col>，但会有 <tag>。
    if (!found) {
      legacyFieldRegex.lastIndex = 0;
      let fieldMatch: RegExpExecArray | null;
      while ((fieldMatch = legacyFieldRegex.exec(inner)) !== null) {
        row[unescapeXml(fieldMatch[1])] = unescapeXml(fieldMatch[2]);
        found = true;
      }
    }

    if (found) rows.push(row);
  }
  return rows;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXmlValue(value: unknown): string {
  return escapeXmlAttr(String(value ?? ''));
}

/** XML 头（声明 + <rows>）。 */
export function xmlHeader(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<rows>';
}

/** 单行 <row>…</row>。 */
export function xmlRow(columns: string[], row: Record<string, unknown>): string {
  const parts: string[] = ['  <row>'];
  for (const col of columns) {
    const value = row[col];
    const isNull = value === null || value === undefined;
    parts.push(`    <col name="${escapeXmlAttr(col)}"${isNull ? ' nil="true"' : ''}>${isNull ? '' : escapeXmlValue(value)}</col>`);
  }
  parts.push('  </row>');
  return parts.join('\n');
}

/** XML 尾。 */
export function xmlFooter(): string {
  return '</rows>';
}

export function serializeXml(columns: string[], rows: Record<string, unknown>[]): string {
  const parts: string[] = [xmlHeader()];
  for (const row of rows) parts.push(xmlRow(columns, row));
  parts.push(xmlFooter());
  return parts.join('\n') + '\n';
}

/** 逐块产出完整的 `<row>…</row>` 片段（跨块拼接），不整文件读入。 */
async function* readXmlRowFragments(filePath: string, chunkSize: number): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: chunkSize });
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk as string;
    let idx: number;
    while ((idx = buffer.indexOf('</row>')) !== -1) {
      const end = idx + '</row>'.length;
      yield buffer.slice(0, end);
      buffer = buffer.slice(end);
    }
  }
  if (buffer.includes('<row')) yield buffer;
}

/** 只读前若干行 + 列名，用于导入向导预览。 */
export async function readXmlSample(filePath: string, sampleSize = 200, chunkSize = 1 << 20): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const rows: Record<string, unknown>[] = [];
  let columns: string[] = [];
  for await (const fragment of readXmlRowFragments(filePath, chunkSize)) {
    const parsed = parseXml(fragment);
    if (!parsed.length) continue;
    if (!columns.length) columns = Object.keys(parsed[0]);
    rows.push(parsed[0]);
    if (rows.length >= sampleSize) break;
  }
  return { columns, rows };
}

/** 流式读取 XML 行（逐行 yield），供大文件导入。 */
export async function* streamXmlRows(filePath: string, chunkSize = 1 << 20): AsyncGenerator<Record<string, unknown>> {
  for await (const fragment of readXmlRowFragments(filePath, chunkSize)) {
    const parsed = parseXml(fragment);
    if (parsed.length) yield parsed[0];
  }
}
