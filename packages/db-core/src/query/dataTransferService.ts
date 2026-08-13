import { SchemaDiffService } from './schemaDiffService';
import { DataDiffService } from './dataDiffService';
import type { QueryService } from './queryService';
import type { MetadataService } from './metadataService';
import type { TableService } from './tableService';

export interface TransferProgress {
  table: string;
  phase: 'schema' | 'data';
  completed: number;
  total: number;
}

export interface TransferOptions {
  tables?: string[];
  includeData?: boolean;
  pageSize?: number;
  onProgress?: (progress: TransferProgress) => void;
  isCancelled?: () => boolean;
}

export class DataTransferService {
  static async transferDatabase(
    sourceQuery: QueryService,
    sourceMeta: MetadataService,
    sourceTable: TableService,
    sourceDb: string,
    targetQuery: QueryService,
    targetMeta: MetadataService,
    targetDb: string,
    options: TransferOptions = {},
  ): Promise<{ tablesSynced: number; errors: string[] }> {
    const { tables: tableFilter, includeData = true, pageSize = 1000, onProgress, isCancelled } = options;
    const errors: string[] = [];

    const schemaDiffs = await SchemaDiffService.diff(sourceMeta, sourceDb, targetMeta, targetDb);
    const tableList = tableFilter
      ?? schemaDiffs.map((d) => d.tableName).concat(
        (await sourceMeta.getTables(sourceDb)).map((t) => t.name).filter((n) => !schemaDiffs.find((d) => d.tableName === n)),
      );

    const uniqueTables = [...new Set(tableList)];
    const total = uniqueTables.length;

    for (let i = 0; i < uniqueTables.length; i++) {
      if (isCancelled?.()) throw new Error('Transfer cancelled.');
      const table = uniqueTables[i];
      onProgress?.({ table, phase: 'schema', completed: i, total });

      const diff = schemaDiffs.find((d) => d.tableName === table);
      if (diff && diff.status !== 'unchanged') {
        try {
          const syncSql = await SchemaDiffService.generateSyncSql(
            [diff], targetDb, sourceTable, sourceDb,
          );
          const statements = splitSql(syncSql);
          for (const stmt of statements) {
            if (stmt.trim()) await targetQuery.query(stmt.trim());
          }
        } catch (err) {
          errors.push(`${table}: schema sync failed - ${(err as Error).message}`);
          continue;
        }
      } else if (diff?.status === 'added') {
        try {
          await this.transferTable(
            sourceQuery, sourceMeta, sourceTable, sourceDb, table,
            targetQuery, targetMeta, targetDb,
            { includeData, pageSize, isCancelled },
          );
        } catch (err) {
          errors.push(`${table}: transfer failed - ${(err as Error).message}`);
          continue;
        }
      }

      if (includeData && diff?.status !== 'added') {
        try {
          onProgress?.({ table, phase: 'data', completed: i, total });
          await this.syncTableData(
            sourceQuery, sourceMeta, sourceDb, table,
            targetQuery, targetMeta, targetDb,
            { pageSize, isCancelled },
          );
        } catch (err) {
          errors.push(`${table}: data sync failed - ${(err as Error).message}`);
        }
      }
    }

    onProgress?.({ table: '', phase: 'data', completed: total, total });
    return { tablesSynced: total - errors.length, errors };
  }

  static async transferTable(
    sourceQuery: QueryService,
    sourceMeta: MetadataService,
    sourceTable: TableService,
    sourceDb: string,
    sourceTableName: string,
    targetQuery: QueryService,
    _targetMeta: MetadataService,
    targetDb: string,
    options: { includeData?: boolean; pageSize?: number; isCancelled?: () => boolean } = {},
  ): Promise<void> {
    const { includeData = true, pageSize = 1000, isCancelled } = options;
    const wrap = sourceQuery.dialect.wrap;

    const ddl = await sourceTable.getCreateSql(sourceTableName, sourceDb);
    const qualifiedTarget = targetDb ? `${wrap(targetDb)}.${wrap(sourceTableName)}` : wrap(sourceTableName);
    await targetQuery.query(`DROP TABLE IF EXISTS ${qualifiedTarget}`);
    const adaptedDdl = ddl
      .replace(/`(\w+)`/g, (_, name) => `\`${targetDb}\`.\`${name}\``)
      .replace(/;\s*$/, '');
    await targetQuery.query(adaptedDdl + ';');

    if (!includeData) return;

    const cols = (await sourceMeta.getColumns(sourceTableName, sourceDb)).map((c) => c.name);
    const colList = cols.map(wrap).join(', ');
    const qualifiedSource = sourceDb ? `${wrap(sourceDb)}.${wrap(sourceTableName)}` : wrap(sourceTableName);

    for (let offset = 0; ; offset += pageSize) {
      if (isCancelled?.()) throw new Error('Transfer cancelled.');
      const sql = sourceQuery.dialect.getPagedSql(
        `SELECT * FROM ${qualifiedSource}`, offset, pageSize,
      );
      const result = await sourceQuery.query(sql);
      if (!result.rows.length) break;

      const rows = result.rows as Record<string, unknown>[];
      const values = rows.map((row) => {
        const vals = cols.map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return 'NULL';
          if (typeof v === 'number') return String(v);
          return `'${String(v).replace(/'/g, "''")}'`;
        }).join(', ');
        return `(${vals})`;
      }).join(',\n');

      await targetQuery.query(`INSERT INTO ${qualifiedTarget} (${colList}) VALUES\n${values}`);
    }
  }

  private static async syncTableData(
    sourceQuery: QueryService,
    sourceMeta: MetadataService,
    sourceDb: string,
    table: string,
    targetQuery: QueryService,
    _targetMeta: MetadataService,
    targetDb: string,
    options: { pageSize?: number; isCancelled?: () => boolean },
  ): Promise<void> {
    const dataDiff = await DataDiffService.diff(
      sourceQuery, sourceMeta, sourceDb,
      targetQuery, targetDb,
      [table],
    );
    const syncSql = DataDiffService.generateSyncSql(
      { diffs: dataDiff.diffs, sourceDb, targetDb },
      targetDb,
      sourceQuery,
    );
    const statements = splitSql(syncSql);
    for (const stmt of statements) {
      if (options.isCancelled?.()) throw new Error('Transfer cancelled.');
      const trimmed = stmt.trim();
      if (trimmed && !trimmed.startsWith('--')) {
        await targetQuery.query(trimmed);
      }
    }
  }
}

function splitSql(sql: string): string[] {
  const result: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (!inSingle && !inDouble && !inBacktick && ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) { i = sql.length; continue; }
      buf += sql.slice(i, nl);
      i = nl;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick && ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      i = stop;
      continue;
    }
    if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (ch === '\x60' && !inSingle && !inDouble) inBacktick = !inBacktick;

    if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
      const stmt = buf.trim();
      if (stmt) result.push(stmt);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const last = buf.trim();
  if (last) result.push(last);
  return result;
}