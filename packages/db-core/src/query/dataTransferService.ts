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
    // 按表名索引，避免循环里对 schemaDiffs 反复线性查找（O(n²)）。
    const diffByName = new Map(schemaDiffs.map((d) => [d.tableName, d]));
    const tableList = tableFilter
      ?? schemaDiffs.map((d) => d.tableName).concat(
        (await sourceMeta.getTables(sourceDb)).map((t) => t.name).filter((n) => !diffByName.has(n)),
      );

    const uniqueTables = [...new Set(tableList)];
    const total = uniqueTables.length;
    // 以"表"为失败单位计数：一张表可能同时结构+数据两个阶段都出错，
    // 过去用 total - errors.length 会让 tablesSynced 变成负数。
    const failedTables = new Set<string>();

    for (let i = 0; i < uniqueTables.length; i++) {
      if (isCancelled?.()) throw new Error('Transfer cancelled.');
      const table = uniqueTables[i];
      onProgress?.({ table, phase: 'schema', completed: i, total });

      const diff = diffByName.get(table);
      if (diff && diff.status !== 'unchanged') {
        try {
          // 跨引擎 schema 同步会拿源方言 DDL 去目标库执行（如 MySQL 反引号发给 PG）。
          // 明确拒绝，而不是执行错误的 SQL。
          if (sourceTable.dbType !== targetQuery.dialect.dbType) {
            throw new Error('cross-database-type schema sync is not supported');
          }
          const syncSql = await SchemaDiffService.generateSyncSql(
            [diff], targetDb, sourceTable, sourceDb, targetQuery.dialect,
          );
          const statements = splitExecutableStatements(syncSql, scanOptionsForDbType(targetQuery.dialect.dbType));
          for (const stmt of statements) {
            if (stmt.trim()) await targetQuery.query(stmt.trim(), undefined, SKIP);
          }
        } catch (err) {
          // 结构同步失败只记录错误：**不**跳过下面的数据阶段（跨引擎时结构本就跳过，
          // 数据仍应同步；过去这里 continue 会让数据也一起没了）。
          errors.push(`${table}: schema sync failed - ${(err as Error).message}`);
          failedTables.add(table);
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
          failedTables.add(table);
        }
      }
    }

    onProgress?.({ table: '', phase: 'data', completed: total, total });
    return { tablesSynced: total - failedTables.size, errors };
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
