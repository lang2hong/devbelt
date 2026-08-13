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

export function serializeXml(columns: string[], rows: Record<string, unknown>[]): string {
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<rows>'];
  for (const row of rows) {
    parts.push('  <row>');
    for (const col of columns) {
      const val = row[col] ?? '';
      const escaped = String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      parts.push(`    <${col}>${escaped}</${col}>`);
    }
    parts.push('  </row>');
  }
  parts.push('</rows>');
  return parts.join('\n') + '\n';
}