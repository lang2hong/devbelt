import type { ColumnMeta, QueryService } from '@db-client/core';
import { DatabaseType } from '@db-client/core';
import { serializeCsv } from './csv';
import { serializeJson } from './json';

export type TransferFormat = 'sql' | 'csv' | 'json';

export interface ServerInfo {
  name: string;
  dbType: DatabaseType;
  host?: string;
  port?: number;
  version?: string;
}

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
  /** Only export these columns; omit for all columns. */
  columns?: string[];
  pageSize?: number;
  onProgress?: (progress: ExportProgress) => void;
  isCancelled?: () => boolean;
  serverInfo?: ServerInfo;
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
  const { source, format, table, database, includeStructure = false, includeData = true, columns: selectedColumns, pageSize = 1000, onProgress, isCancelled, serverInfo } = options;
  const dialect = source.query.dialect;
  const qualified = database ? `${dialect.wrap(database)}.${dialect.wrap(table)}` : dialect.wrap(table);
  const allColumns = includeData ? (await source.metadata.getColumns(table, database)).map((column) => column.name) : [];
  const columns = includeData
    ? (selectedColumns && selectedColumns.length ? selectedColumns.filter((c) => allColumns.includes(c)) : allColumns)
    : [];
  const colList = columns.map((c) => dialect.wrap(c)).join(', ');
  const selectCols = colList || '*';
  const rows: Record<string, unknown>[] = [];
  if (includeData) {
    for (let offset = 0;; offset += pageSize) {
      if (isCancelled?.()) throw new TransferCancelledError();
      const page = await source.query.query(dialect.getPagedSql(`SELECT ${selectCols} FROM ${qualified}`, offset, pageSize));
      rows.push(...page.rows);
      onProgress?.({ rows: rows.length });
      if (page.rows.length < pageSize) break;
    }
  }
  const data = includeData ? exportRows({ format, columns, rows, table, database, dialect }) : '';
  if (format !== 'sql') return data;
  const ddl = includeStructure ? (await source.table.getCreateSql(table, database)) : '';
  return buildSqlDump({ serverInfo, dialect, database, table, qualified, ddl, data, includeStructure, includeData });
}

interface SqlDumpParams {
  serverInfo?: ServerInfo;
  dialect: QueryService['dialect'];
  database?: string;
  table: string;
  qualified: string;
  ddl: string;
  data: string;
  includeStructure: boolean;
  includeData: boolean;
}

function buildSqlDump(params: SqlDumpParams): string {
  const { serverInfo, dialect, database, table, qualified, ddl, data, includeStructure, includeData } = params;
  const dbType = dialect.dbType;
  const parts: string[] = [];

  if (serverInfo) {
    parts.push(buildDumpHeader(serverInfo, database, dbType));
  }
  const prelude = sqlPrelude(dbType);
  if (prelude) parts.push(prelude);

  if (includeStructure) {
    parts.push('-- ----------------------------');
    parts.push(`-- Table structure for ${table}`);
    parts.push('-- ----------------------------');
    parts.push(`DROP TABLE IF EXISTS ${qualified};`);
    parts.push(`${ddl.replace(/;\s*$/, '')};`);
  }

  if (includeData && data) {
    parts.push('-- ----------------------------');
    parts.push(`-- Records of ${table}`);
    parts.push('-- ----------------------------');
    parts.push('BEGIN;');
    parts.push(data.replace(/\n$/, ''));
    parts.push('COMMIT;');
  }

  const epilogue = sqlEpilogue(dbType);
  if (epilogue) parts.push(epilogue);

  return parts.join('\n\n') + '\n';
}

function buildDumpHeader(info: ServerInfo, database: string | undefined, dbType: DatabaseType): string {
  const lines: string[] = ['/*', ' DB Client Pro Dump SQL', ''];
  lines.push(` Source Server         : ${info.name || ''}`);
  lines.push(` Source Server Type    : ${dbType}`);
  if (info.version) lines.push(` Source Server Version : ${info.version}`);
  if (info.host) lines.push(` Source Host           : ${info.host}${info.port ? `:${info.port}` : ''}`);
  if (database) lines.push(` Source Schema         : ${database}`);
  lines.push('');
  lines.push(` Target Server Type    : ${dbType}`);
  lines.push(' File Encoding         : 65001');
  lines.push('');
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  lines.push(` Date: ${dateStr}`);
  lines.push('*/');
  return lines.join('\n');
}

function sqlPrelude(dbType: DatabaseType): string {
  switch (dbType) {
    case DatabaseType.MYSQL: return 'SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;';
    case DatabaseType.PG: return "SET client_encoding = 'UTF8';\nSET session_replication_role = 'replica';";
    case DatabaseType.SQLITE: return 'PRAGMA foreign_keys = OFF;';
    default: return '';
  }
}

function sqlEpilogue(dbType: DatabaseType): string {
  switch (dbType) {
    case DatabaseType.MYSQL: return 'SET FOREIGN_KEY_CHECKS = 1;';
    case DatabaseType.PG: return "SET session_replication_role = 'origin';";
    case DatabaseType.SQLITE: return 'PRAGMA foreign_keys = ON;';
    default: return '';
  }
}
