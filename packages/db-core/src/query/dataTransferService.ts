import { SchemaDiffService } from './schemaDiffService.js';
import { DataDiffService } from './dataDiffService.js';
import type { QueryService, QueryOptions } from './queryService.js';
import type { MetadataService } from './metadataService.js';
import type { TableService } from './tableService.js';
import { splitExecutableStatements, scanOptionsForDbType } from '../sql/index.js';

/**
 * 库间传输的每条语句都不进查询历史。
 *
 * 一次传输可能包含成百上千条 DDL/INSERT，逐条上报会冲干历史。
 * 命令层负责补一条汇总记录。
 */
const SKIP: QueryOptions = { skipHistory: true };

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
        // 跨引擎 schema 同步会拿源方言 DDL 去目标库执行（如 MySQL 反引号发给 PG）。
        // 明确拒绝，而不是执行错误的 SQL。
        if (sourceTable.dbType !== targetQuery.dialect.dbType) {
          errors.push(`${table}: schema sync failed - cross-database-type schema sync is not supported`);
          continue;
        }
        try {
          const syncSql = await SchemaDiffService.generateSyncSql(
            [diff], targetDb, sourceTable, sourceDb,
          );
          const statements = splitExecutableStatements(syncSql, scanOptionsForDbType(targetQuery.dialect.dbType));
          for (const stmt of statements) {
            if (stmt.trim()) await targetQuery.query(stmt.trim(), undefined, SKIP);
          }
        } catch (err) {
          errors.push(`${table}: schema sync failed - ${(err as Error).message}`);
          continue;
        }
      }

      // 数据阶段对**所有**需要同步的表执行（含 status='added'）：结构由上方 schema diff
      // 同步，这里只负责灌数据。
      if (includeData) {
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
      targetQuery,
    );
    const statements = splitExecutableStatements(syncSql, scanOptionsForDbType(targetQuery.dialect.dbType));
    for (const stmt of statements) {
      if (options.isCancelled?.()) throw new Error('Transfer cancelled.');
      const trimmed = stmt.trim();
      if (trimmed && !trimmed.startsWith('--')) {
        await targetQuery.query(trimmed, undefined, SKIP);
      }
    }
  }
}
