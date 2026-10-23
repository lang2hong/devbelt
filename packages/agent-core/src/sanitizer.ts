import { formatRowSample, isSensitiveColumnName } from '@devbelt/ai-core';

/**
 * Everything a tool returns to the model goes through here. This is data
 * minimisation only, not authorisation: the host re-checks policy on every
 * call (see guard.ts) regardless of what the model saw.
 */
export interface ToolResultEnvelope<T> {
  kind: 'tool_result';
  /** Always true: schema text, comments and rows may contain prompt injection. */
  untrusted: true;
  tool: string;
  data: T;
  truncated: boolean;
  notes: string[];
}

export interface MetadataColumnInput {
  name: string;
  type?: string;
  nullable?: boolean;
  primaryKey?: boolean;
  comment?: string;
}

export interface MetadataTableInput {
  name: string;
  comment?: string;
  columns?: MetadataColumnInput[];
  indexes?: Array<{ name: string; columns: string[]; unique?: boolean }>;
  foreignKeys?: Array<{ columns: string[]; refTable: string; refColumns: string[] }>;
}

export interface MetadataColumnView {
  name: string;
  type?: string;
  nullable?: boolean;
  primaryKey?: boolean;
  sensitive?: true;
  comment?: string;
}

export interface MetadataTableView {
  name: string;
  comment?: string;
  columns: MetadataColumnView[];
  indexes: Array<{ name: string; columns: string[]; unique?: boolean }>;
  foreignKeys: Array<{ columns: string[]; refTable: string; refColumns: string[] }>;
}

export interface MetadataBudget {
  maxTables: number;
  maxColumnsPerTable: number;
  maxIndexesPerTable: number;
  maxCommentChars: number;
  maxIdentifierChars: number;
}

export interface QueryColumnSummary {
  name: string;
  sensitive?: true;
  nulls: number;
  /** Distinct non-null values among the inspected rows (sensitive columns are not counted). */
  distinct?: number;
}

export interface QueryResultView {
  columns: QueryColumnSummary[];
  rowCount: number;
  /** Rows the summary was computed from. */
  inspectedRows: number;
  sample?: { lines: string[]; rowsSent: number; redactedCells: number };
}

export interface QueryBudget {
  maxColumns: number;
  maxInspectedRows: number;
  sampleRows: number;
  maxCellChars: number;
  /** Upper bound for all sample lines together. */
  maxSampleChars: number;
}

export interface SanitizeQueryOptions {
  /** Explicit, per-call opt-in. Without it no row values reach the model. */
  includeSample?: boolean;
  /** Override the sensitive-column rule; defaults to the ai-core blacklist. */
  isSensitive?: (column: string) => boolean;
}

export const DEFAULT_METADATA_BUDGET: MetadataBudget = Object.freeze({
  maxTables: 50,
  maxColumnsPerTable: 60,
  maxIndexesPerTable: 20,
  maxCommentChars: 200,
  maxIdentifierChars: 128,
});

export const DEFAULT_QUERY_BUDGET: QueryBudget = Object.freeze({
  maxColumns: 60,
  maxInspectedRows: 1000,
  sampleRows: 10,
  maxCellChars: 64,
  maxSampleChars: 4000,
});

export const DEFAULT_TEXT_LIMIT = 4000;

export function sanitizeMetadata(
  tool: string,
  tables: readonly MetadataTableInput[],
  budget: Partial<MetadataBudget> = {},
): ToolResultEnvelope<MetadataTableView[]> {
  const b = { ...DEFAULT_METADATA_BUDGET, ...budget };
  const notes: string[] = [];
  let truncated = false;
  if (tables.length > b.maxTables) {
    truncated = true;
    notes.push(`tables truncated: ${b.maxTables} of ${tables.length}`);
  }
  const data = tables.slice(0, b.maxTables).map((table) => {
    const columns = table.columns ?? [];
    const indexes = table.indexes ?? [];
    if (columns.length > b.maxColumnsPerTable) {
      truncated = true;
      notes.push(`${clip(table.name, b.maxIdentifierChars)}: columns truncated ${b.maxColumnsPerTable} of ${columns.length}`);
    }
    if (indexes.length > b.maxIndexesPerTable) {
      truncated = true;
      notes.push(`${clip(table.name, b.maxIdentifierChars)}: indexes truncated ${b.maxIndexesPerTable} of ${indexes.length}`);
    }
    const view: MetadataTableView = {
      name: clip(table.name, b.maxIdentifierChars),
      columns: columns.slice(0, b.maxColumnsPerTable).map((c) => columnView(c, b)),
      indexes: indexes.slice(0, b.maxIndexesPerTable).map((i) => ({
        name: clip(i.name, b.maxIdentifierChars),
        columns: i.columns.map((c) => clip(c, b.maxIdentifierChars)),
        ...(i.unique ? { unique: true } : {}),
      })),
      foreignKeys: (table.foreignKeys ?? []).map((fk) => ({
        columns: fk.columns.map((c) => clip(c, b.maxIdentifierChars)),
        refTable: clip(fk.refTable, b.maxIdentifierChars),
        refColumns: fk.refColumns.map((c) => clip(c, b.maxIdentifierChars)),
      })),
    };
    const comment = cleanComment(table.comment, b.maxCommentChars);
    if (comment) view.comment = comment;
    return view;
  });
  return envelope(tool, data, truncated, notes);
}

/**
 * R1 results. By default the model sees column names, row count and
 * per-column null/distinct counts only. Row values need `includeSample`;
 * sensitive columns are always redacted and never counted.
 */
export function sanitizeQueryResult(
  tool: string,
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
  options: SanitizeQueryOptions = {},
  budget: Partial<QueryBudget> = {},
): ToolResultEnvelope<QueryResultView> {
  const b = { ...DEFAULT_QUERY_BUDGET, ...budget };
  const isSensitive = options.isSensitive ?? isSensitiveColumnName;
  const notes: string[] = [];
  let truncated = false;

  const shownColumns = columns.slice(0, b.maxColumns);
  if (columns.length > b.maxColumns) {
    truncated = true;
    notes.push(`columns truncated: ${b.maxColumns} of ${columns.length}`);
  }
  const inspected = rows.slice(0, b.maxInspectedRows);
  if (rows.length > b.maxInspectedRows) {
    truncated = true;
    notes.push(`summary computed from the first ${b.maxInspectedRows} of ${rows.length} rows`);
  }

  const summaries: QueryColumnSummary[] = shownColumns.map((name) => {
    const sensitive = isSensitive(name);
    let nulls = 0;
    const distinct = new Set<string>();
    for (const row of inspected) {
      const value = row[name];
      if (value === null || value === undefined) { nulls++; continue; }
      if (!sensitive) distinct.add(distinctKey(value));
    }
    return { name, nulls, ...(sensitive ? { sensitive: true as const } : { distinct: distinct.size }) };
  });

  const data: QueryResultView = { columns: summaries, rowCount: rows.length, inspectedRows: inspected.length };

  if (options.includeSample) {
    const sample = formatRowSample([...shownColumns], [...inspected], {
      maxRows: b.sampleRows,
      maxCellChars: b.maxCellChars,
      isSensitive,
    });
    const lines: string[] = [];
    let used = 0;
    for (const line of sample.lines) {
      if (used + line.length > b.maxSampleChars) {
        truncated = true;
        notes.push(`sample truncated to ${b.maxSampleChars} characters`);
        break;
      }
      lines.push(line);
      used += line.length;
    }
    const rowsSent = Math.max(0, lines.length - 1);
    data.sample = { lines, rowsSent, redactedCells: countRedacted(lines) };
    if (rowsSent < rows.length) notes.push(`sample rows: ${rowsSent} of ${rows.length}`);
  }
  return envelope(tool, data, truncated, notes);
}

/** EXPLAIN: the caller passes an already normalised plan summary (no literals). */
export function sanitizePlanSummary(tool: string, summary: string, maxChars = DEFAULT_TEXT_LIMIT): ToolResultEnvelope<string> {
  const text = redactSecrets(summary);
  const truncated = text.length > maxChars;
  return envelope(tool, truncated ? clip(text, maxChars) : text, truncated, truncated ? [`plan truncated to ${maxChars} characters`] : []);
}

/** Tool errors are untrusted too and may echo credentials from SQL. */
export function sanitizeToolError(tool: string, message: string, maxChars = 500): ToolResultEnvelope<{ error: string }> {
  const text = redactSecrets(message);
  const truncated = text.length > maxChars;
  return envelope(tool, { error: truncated ? clip(text, maxChars) : text }, truncated, []);
}

const PASSWORD_LITERAL = new RegExp(
  String.raw`(\b(?:identified\s+with\s+\S+\s+as|identified\s+(?:with\s+\S+\s+)?by|set\s+password\s+for\s+[^\n;=]*|(?:encrypted\s+)?password)\s*=?\s*)`
  + String.raw`('(?:[^']|'')*'|"(?:[^"]|"")*")`,
  'gi',
);
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** Mask password literals (same rule as db-core `redactSql`), URL credentials and bearer tokens. */
export function redactSecrets(text: string): string {
  return text
    .replace(PASSWORD_LITERAL, (_m, kw: string) => `${kw}'***'`)
    .replace(URL_CREDENTIALS, (_m, scheme: string, user: string) => `${scheme}${user}:***@`)
    .replace(BEARER, (_m, kw: string) => `${kw}***`);
}

function columnView(c: MetadataColumnInput, b: MetadataBudget): MetadataColumnView {
  const view: MetadataColumnView = { name: clip(c.name, b.maxIdentifierChars) };
  if (c.type) view.type = clip(c.type, b.maxIdentifierChars);
  if (c.nullable !== undefined) view.nullable = c.nullable;
  if (c.primaryKey) view.primaryKey = true;
  if (isSensitiveColumnName(c.name)) view.sensitive = true;
  const comment = cleanComment(c.comment, b.maxCommentChars);
  if (comment) view.comment = comment;
  return view;
}

function cleanComment(comment: string | undefined, max: number): string | undefined {
  if (!comment) return undefined;
  // Single line, no control characters: keeps comments from posing as message structure.
  const flat = redactSecrets(comment).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat ? clip(flat, max) : undefined;
}

function distinctKey(value: unknown): string {
  if (value instanceof Uint8Array) return `b:${Buffer.from(value).toString('base64')}`;
  if (value instanceof Date) return `d:${value.toISOString()}`;
  if (typeof value === 'bigint') return `n:${value.toString()}`;
  if (typeof value === 'object') {
    try { return `o:${JSON.stringify(value)}`; } catch { return 'o:?'; }
  }
  return `${typeof value}:${String(value)}`;
}

function countRedacted(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines.slice(1)) n += line.split('"[REDACTED]"').length - 1;
  return n;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function envelope<T>(tool: string, data: T, truncated: boolean, notes: string[]): ToolResultEnvelope<T> {
  return { kind: 'tool_result', untrusted: true, tool, data, truncated, notes };
}
