export function parseXml(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/gi;
  const fieldRegex = /<(\w+)>([\s\S]*?)<\/\1>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(text)) !== null) {
    const inner = rowMatch[1];
    const row: Record<string, unknown> = {};
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldRegex.exec(inner)) !== null) {
      row[fieldMatch[1]] = fieldMatch[2];
    }
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}

/**
 * 把列名规整为合法 XML 元素名：元素名只能由字母/数字/`.`/`-`/`_` 组成且不能
 * 以数字/`.`/`-` 开头。列名含 `<`、`>`、`&`、空格等会破坏 XML 结构（元素名注入面）；
 * 非 ASCII 字符本就不在 parseXml 的 `\w+` 解析范围内，统一替换为 `_` 保持一致。
 */
function sanitizeXmlName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_.:-]/g, '_');
  return /^[A-Za-z_]/.test(s) ? s : `c_${s}`;
}

function escapeXmlValue(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** XML 头（声明 + <rows>）。 */
export function xmlHeader(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<rows>';
}

/** 单行 <row>…</row>。 */
export function xmlRow(columns: string[], row: Record<string, unknown>): string {
  const tags = columns.map((col) => sanitizeXmlName(col));
  const parts: string[] = ['  <row>'];
  columns.forEach((col, index) => {
    parts.push(`    <${tags[index]}>${escapeXmlValue(row[col])}</${tags[index]}>`);
  });
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