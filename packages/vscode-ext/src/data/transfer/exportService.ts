import type { ColumnMeta } from '@db-client/core';
import type { QueryService } from '@db-client/core';
import { serializeCsv } from './csv';
import { serializeJson } from './json';

export type TransferFormat = 'sql' | 'csv' | 'json';

export interface ExportProgress {
  rows: number;
}

export interface TableExportSource {
  query: Pick<QueryService, 'query' | 'dialect'>;
  metadata: { getColumns(table: string, database?: string): Promise<ColumnMeta[]> };
  table: { getCreateSql(table: string, database?: string): Promise<string> };
}

export interface ExportTableOptions {
  source: TableExportSource;
  format: TransferFormat;
  table: string;
  database?: string;
  includeStructure?: boolean;
  includeData?: boolean;
  pageSize?: number;
  onProgress?: (progress: ExportProgress) => void;
  isCancelled?: () => boolean;
}

export interface ExportRowsOptions {
  format: TransferFormat;
  columns: string[];
  rows: Record<string, unknown>[];
  table?: string;
  database?: string;
  dialect?: QueryService['dialect'];
}

export class TransferCancelledError extends Error {
  constructor() {
    super('Transfer cancelled.');
    this.name = 'TransferCancelledError';
  }
}

export function exportRows(options: ExportRowsOptions): string {
  const { format, columns, rows, table, database, dialect } = options;
  if (format === 'csv') return serializeCsv(columns, rows);
  if (format === 'json') return serializeJson(columns, rows);
  if (!table || !dialect) throw new Error('SQL export requires a target table and database dialect.');
  return dialect.buildInsertSql(rows, columns, table, database);
}

/** Reads a full table in bounded pages instead of inheriting the result-view row limit. */
export async function exportTable(options: ExportTableOptions): Promise<string> {
  const { source, format, table, database, includeStructure = false, includeData = true, pageSize = 1000, onProgress, isCancelled } = options;
  const dialect = source.query.dialect;
  const qualified = database ? `${dialect.wrap(database)}.${dialect.wrap(table)}` : dialect.wrap(table);
  const columns = includeData ? (await source.metadata.getColumns(table, database)).map((column) => column.name) : [];
  const rows: Record<string, unknown>[] = [];
  if (includeData) {
    for (let offset = 0;; offset += pageSize) {
      if (isCancelled?.()) throw new TransferCancelledError();
      const page = await source.query.query(dialect.getPagedSql(`SELECT * FROM ${qualified}`, offset, pageSize));
      rows.push(...page.rows);
      onProgress?.({ rows: rows.length });
      if (page.rows.length < pageSize) break;
    }
  }
  let content = includeData ? exportRows({ format, columns, rows, table, database, dialect }) : '';
  if (format === 'sql' && includeStructure) {
    const ddl = await source.table.getCreateSql(table, database);
    content = `-- Table: ${database ? `${database}.` : ''}${table}\nDROP TABLE IF EXISTS ${qualified};\n${ddl};\n${content ? `\n${content}` : ''}`;
  }
  return content;
}
