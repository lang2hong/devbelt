import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { ColumnMeta, QueryService } from '@devbelt/db-core';
import { qualifyTable } from '@devbelt/db-core';
import { isPiiColumn, maskValue, type MaskingRule } from '@devbelt/masking-core';
import { exportRows, type TransferFormat } from '../data/transfer/exportService.js';

export interface MaskedExportDeps {
  query: Pick<QueryService, 'query'>;
  dialect: QueryService['dialect'];
  metadata: { getColumns(table: string, database?: string, schema?: string): Promise<ColumnMeta[]> };
  table: string;
  database?: string;
  schema?: string;
  where?: string;
  columns: Record<string, MaskingRule>;
  allowUnmasked?: string[];
  salt: string;
  maxRows: number;
}

export interface MaskedExportResult {
  rows: number;
  columns: string[];
  file?: string;
}

export class MaskingExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaskingExportError';
  }
}

/** Read and mask rows; shared by preview and the final export. */
export async function readMaskedRows(
  deps: MaskedExportDeps,
  limit: number,
): Promise<{ columns: ColumnMeta[]; rows: Array<Record<string, unknown>> }> {
  const columns = await deps.metadata.getColumns(deps.table, deps.database, deps.schema);
  if (columns.length === 0) throw new MaskingExportError(`Table not found: ${deps.table}`);
  const allow = new Set(deps.allowUnmasked ?? []);
  const missing = columns
    .filter((c) => isPiiColumn(c.name) && !deps.columns[c.name] && !allow.has(c.name))
    .map((c) => c.name);
  if (missing.length > 0) {
    throw new MaskingExportError(`PII columns need a masking rule or allowUnmasked entry: ${missing.join(', ')}`);
  }
  for (const [column, rule] of Object.entries(deps.columns)) {
    if (!columns.some((c) => c.name === column)) throw new MaskingExportError(`Unknown column in masking config: ${column}`);
    if (rule.rule === 'null' && columns.find((c) => c.name === column)?.isNotNull) {
      throw new MaskingExportError(`Column ${column} is NOT NULL and cannot use the null rule`);
    }
  }

  const select = columns.map((c) => deps.dialect.wrap(c.name)).join(', ');
  const qualified = qualifyTable(
    deps.dialect.dbType,
    deps.dialect.wrap(deps.table),
    deps.database ? deps.dialect.wrap(deps.database) : undefined,
    deps.schema ? deps.dialect.wrap(deps.schema) : undefined,
  );
  const where = deps.where ? ` WHERE ${deps.where}` : '';
  const sql = `SELECT ${select} FROM ${qualified}${where} LIMIT ${Math.max(1, limit) + 1}`;
  const result = await deps.query.query(sql, undefined, { skipHistory: true });
  const raw = Array.isArray(result.rows) ? (result.rows as Array<Record<string, unknown>>) : [];
  if (raw.length > limit) throw new MaskingExportError(`Query matched more than ${limit} rows; narrow the WHERE clause.`);

  const rows = raw.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const [column, rule] of Object.entries(deps.columns)) {
      const meta = columns.find((c) => c.name === column)!;
      const maxLength = Number(meta.maxLength);
      out[column] = maskValue(rule, row[column], {
        salt: deps.salt,
        domain: `${deps.table}.${column}`,
        ...(Number.isFinite(maxLength) && maxLength > 0 ? { maxLength } : {}),
      });
    }
    return out;
  });

  for (const column of columns.filter((c) => c.isUnique)) {
    const seen = new Set<string>();
    for (const row of rows) {
      const value = row[column.name];
      if (value === null || value === undefined) continue;
      const key = String(value);
      if (seen.has(key)) throw new MaskingExportError(`Masking produced a duplicate value for unique column ${column.name}`);
      seen.add(key);
    }
  }

  return { columns, rows };
}

/** Masked export to CSV or SQL, written atomically with owner-only permissions. */
export async function exportMaskedTable(
  deps: MaskedExportDeps,
  format: Extract<TransferFormat, 'csv' | 'sql'>,
  file: string,
  limit: number,
): Promise<MaskedExportResult> {
  const { columns, rows } = await readMaskedRows(deps, limit);
  const names = columns.map((c) => c.name);
  const content = exportRows({
    format,
    columns: names,
    rows,
    table: deps.table,
    ...(deps.database ? { database: deps.database } : {}),
    ...(deps.schema ? { schema: deps.schema } : {}),
    dialect: deps.dialect,
    withBom: format === 'csv',
    ...(format === 'sql' ? { sqlDump: { includeStructure: false } } : {}),
  });
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return { rows: rows.length, columns: names, file };
}