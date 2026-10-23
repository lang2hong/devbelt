export interface DictionaryColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string;
  comment: string;
  isPrimary: boolean;
  isAutoIncrement: boolean;
}

export interface DictionaryIndex {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
}

export interface DictionaryForeignKey {
  name?: string;
  columns: string[];
  refTable: string;
  refSchema?: string;
  refColumns: string[];
}

export interface DictionaryTable {
  name: string;
  comment: string;
  rowsEstimate?: string;
  columns: DictionaryColumn[];
  indexes: DictionaryIndex[];
  foreignKeys: DictionaryForeignKey[];
}

/** Everything a dictionary contains. Deliberately has no connection fields. */
export interface DictionaryModel {
  database?: string;
  schema?: string;
  dbType: string;
  generatedAt: string;
  tables: DictionaryTable[];
  /** Tables in the database before the export cap was applied. */
  totalTables: number;
  truncated: boolean;
}

/** Display strings, resolved by the caller so this module stays vscode/i18n-free. */
export interface DictionaryLabels {
  title: string;
  database: string;
  schema: string;
  engine: string;
  generatedAt: string;
  contents: string;
  tableCount: string;
  truncated: string;
  noTables: string;
  rowsEstimate: string;
  columns: string;
  indexes: string;
  foreignKeys: string;
  colName: string;
  colType: string;
  colNullable: string;
  colDefault: string;
  colComment: string;
  colKey: string;
  yes: string;
  no: string;
  primaryKey: string;
  autoIncrement: string;
  unique: string;
  indexName: string;
  indexColumns: string;
  indexKind: string;
  fkName: string;
  fkColumns: string;
  fkReferences: string;
  none: string;
}

/** Placeholder replacement for `{name}` tokens in a label. */
function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Stable, URL-safe anchor for a table (shared by both renderers). */
export function tableAnchor(name: string): string {
  const slug = name.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `table-${slug || 'unnamed'}`;
}

// ── Markdown ────────────────────────────────────────────────────────────

/** Escape text for a Markdown table cell (pipes, line breaks, HTML). */
export function mdCell(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .trim();
}

/** Escape inline Markdown text outside tables. */
function mdText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]#])/g, '\\$1');
}

function mdCode(text: string): string {
  const fence = text.includes('`') ? '``' : '`';
  return `${fence}${text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')}${fence}`;
}

function keyLabel(c: DictionaryColumn, l: DictionaryLabels): string {
  const parts: string[] = [];
  if (c.isPrimary) parts.push(l.primaryKey);
  if (c.isAutoIncrement) parts.push(l.autoIncrement);
  return parts.join(', ');
}

function indexKind(i: DictionaryIndex, l: DictionaryLabels): string {
  return i.isPrimary ? l.primaryKey : i.isUnique ? l.unique : '';
}

function fkTarget(fk: DictionaryForeignKey): string {
  return `${fk.refSchema ? `${fk.refSchema}.` : ''}${fk.refTable}`;
}

function headerLines(model: DictionaryModel, l: DictionaryLabels): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (model.database) rows.push([l.database, model.database]);
  if (model.schema) rows.push([l.schema, model.schema]);
  rows.push([l.engine, model.dbType]);
  rows.push([l.generatedAt, model.generatedAt]);
  rows.push([l.tableCount, String(model.tables.length)]);
  return rows;
}

export function renderMarkdown(model: DictionaryModel, l: DictionaryLabels): string {
  const out: string[] = [];
  out.push(`# ${mdText(l.title)}`, '');
  for (const [k, v] of headerLines(model, l)) out.push(`- **${mdText(k)}**: ${mdText(v)}`);
  out.push('');
  if (model.truncated) out.push(`> ${mdText(fill(l.truncated, { shown: model.tables.length, total: model.totalTables }))}`, '');

  if (model.tables.length === 0) {
    out.push(mdText(l.noTables), '');
    return out.join('\n');
  }

  const known = new Set(model.tables.map((t) => t.name));
  out.push(`## ${mdText(l.contents)}`, '');
  for (const t of model.tables) {
    const note = t.comment ? ` — ${mdText(t.comment.replace(/\r?\n/g, ' '))}` : '';
    out.push(`- [${mdText(t.name)}](#${tableAnchor(t.name)})${note}`);
  }
  out.push('');

  for (const t of model.tables) {
    out.push(`<a id="${tableAnchor(t.name)}"></a>`, '', `## ${mdText(t.name)}`, '');
    if (t.comment) out.push(mdText(t.comment), '');
    if (t.rowsEstimate) out.push(`${mdText(l.rowsEstimate)}: ${mdText(t.rowsEstimate)}`, '');

    out.push(`### ${mdText(l.columns)}`, '');
    out.push(`| ${[l.colName, l.colType, l.colNullable, l.colDefault, l.colKey, l.colComment].map(mdCell).join(' | ')} |`);
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const c of t.columns) {
      out.push(`| ${[
        mdCode(c.name),
        mdCell(c.type),
        c.nullable ? mdCell(l.yes) : mdCell(l.no),
        c.defaultValue ? mdCode(c.defaultValue) : '',
        mdCell(keyLabel(c, l)),
        mdCell(c.comment),
      ].join(' | ')} |`);
    }
    out.push('');

    out.push(`### ${mdText(l.indexes)}`, '');
    if (t.indexes.length === 0) out.push(mdText(l.none), '');
    else {
      out.push(`| ${[l.indexName, l.indexColumns, l.indexKind].map(mdCell).join(' | ')} |`, '| --- | --- | --- |');
      for (const i of t.indexes) out.push(`| ${mdCode(i.name)} | ${mdCell(i.columns.join(', '))} | ${mdCell(indexKind(i, l))} |`);
      out.push('');
    }

    out.push(`### ${mdText(l.foreignKeys)}`, '');
    if (t.foreignKeys.length === 0) out.push(mdText(l.none), '');
    else {
      out.push(`| ${[l.fkName, l.fkColumns, l.fkReferences].map(mdCell).join(' | ')} |`, '| --- | --- | --- |');
      for (const fk of t.foreignKeys) {
        const target = `${fkTarget(fk)} (${fk.refColumns.join(', ')})`;
        const ref = !fk.refSchema && known.has(fk.refTable) ? `[${mdCell(target)}](#${tableAnchor(fk.refTable)})` : mdCell(target);
        out.push(`| ${fk.name ? mdCode(fk.name) : ''} | ${mdCell(fk.columns.join(', '))} | ${ref} |`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

// ── HTML ────────────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = [
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:2rem;color:#1f2328;line-height:1.5}',
  'h1{border-bottom:1px solid #d0d7de;padding-bottom:.3em}',
  'h2{margin-top:2.2em;border-bottom:1px solid #d0d7de;padding-bottom:.2em}',
  'h3{font-size:1em;margin-top:1.2em}',
  'table{border-collapse:collapse;width:100%;margin:.5em 0 1em;font-size:13px}',
  'th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top}',
  'th{background:#f6f8fa}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
  '.meta{color:#57606a;font-size:13px}',
  '.note{background:#fff8c5;border:1px solid #d4a72c;padding:6px 10px}',
  '@media print{h2{page-break-before:always}h2:first-of-type{page-break-before:avoid}}',
].join('');

function htmlCell(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

export function renderHtml(model: DictionaryModel, l: DictionaryLabels): string {
  const out: string[] = [];
  out.push('<!DOCTYPE html>', '<html><head><meta charset="utf-8">');
  out.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">');
  out.push(`<title>${escapeHtml(l.title)}</title><style>${STYLE}</style></head><body>`);
  out.push(`<h1>${escapeHtml(l.title)}</h1>`);
  out.push('<p class="meta">', ...headerLines(model, l).map(([k, v]) => `<strong>${escapeHtml(k)}</strong>: ${escapeHtml(v)}<br>`), '</p>');
  if (model.truncated) out.push(`<p class="note">${escapeHtml(fill(l.truncated, { shown: model.tables.length, total: model.totalTables }))}</p>`);

  if (model.tables.length === 0) {
    out.push(`<p>${escapeHtml(l.noTables)}</p></body></html>`);
    return out.join('\n');
  }

  const known = new Set(model.tables.map((t) => t.name));
  out.push(`<h2>${escapeHtml(l.contents)}</h2><ul>`);
  for (const t of model.tables) {
    out.push(`<li><a href="#${tableAnchor(t.name)}">${escapeHtml(t.name)}</a>${t.comment ? ` — ${htmlCell(t.comment)}` : ''}</li>`);
  }
  out.push('</ul>');

  for (const t of model.tables) {
    out.push(`<h2 id="${tableAnchor(t.name)}">${escapeHtml(t.name)}</h2>`);
    if (t.comment) out.push(`<p>${htmlCell(t.comment)}</p>`);
    if (t.rowsEstimate) out.push(`<p class="meta">${escapeHtml(l.rowsEstimate)}: ${escapeHtml(t.rowsEstimate)}</p>`);

    out.push(`<h3>${escapeHtml(l.columns)}</h3><table><thead><tr>`);
    for (const h of [l.colName, l.colType, l.colNullable, l.colDefault, l.colKey, l.colComment]) out.push(`<th>${escapeHtml(h)}</th>`);
    out.push('</tr></thead><tbody>');
    for (const c of t.columns) {
      out.push(
        `<tr><td><code>${escapeHtml(c.name)}</code></td><td>${htmlCell(c.type)}</td>`
        + `<td>${escapeHtml(c.nullable ? l.yes : l.no)}</td>`
        + `<td>${c.defaultValue ? `<code>${htmlCell(c.defaultValue)}</code>` : ''}</td>`
        + `<td>${escapeHtml(keyLabel(c, l))}</td><td>${htmlCell(c.comment)}</td></tr>`,
      );
    }
    out.push('</tbody></table>');

    out.push(`<h3>${escapeHtml(l.indexes)}</h3>`);
    if (t.indexes.length === 0) out.push(`<p class="meta">${escapeHtml(l.none)}</p>`);
    else {
      out.push(`<table><thead><tr><th>${escapeHtml(l.indexName)}</th><th>${escapeHtml(l.indexColumns)}</th><th>${escapeHtml(l.indexKind)}</th></tr></thead><tbody>`);
      for (const i of t.indexes) {
        out.push(`<tr><td><code>${escapeHtml(i.name)}</code></td><td>${escapeHtml(i.columns.join(', '))}</td><td>${escapeHtml(indexKind(i, l))}</td></tr>`);
      }
      out.push('</tbody></table>');
    }

    out.push(`<h3>${escapeHtml(l.foreignKeys)}</h3>`);
    if (t.foreignKeys.length === 0) out.push(`<p class="meta">${escapeHtml(l.none)}</p>`);
    else {
      out.push(`<table><thead><tr><th>${escapeHtml(l.fkName)}</th><th>${escapeHtml(l.fkColumns)}</th><th>${escapeHtml(l.fkReferences)}</th></tr></thead><tbody>`);
      for (const fk of t.foreignKeys) {
        const target = escapeHtml(`${fkTarget(fk)} (${fk.refColumns.join(', ')})`);
        const ref = !fk.refSchema && known.has(fk.refTable) ? `<a href="#${tableAnchor(fk.refTable)}">${target}</a>` : target;
        out.push(`<tr><td>${fk.name ? `<code>${escapeHtml(fk.name)}</code>` : ''}</td><td>${escapeHtml(fk.columns.join(', '))}</td><td>${ref}</td></tr>`);
      }
      out.push('</tbody></table>');
    }
  }
  out.push('</body></html>');
  return out.join('\n');
}