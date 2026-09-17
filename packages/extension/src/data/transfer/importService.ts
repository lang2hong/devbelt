import type { QueryOptions, QueryService } from '@devkit/core';
import { mapRows, type FieldMapping } from './fieldMapper';
import { TransferCancelledError } from './exportService';

/**
 * 导入的每条语句都不进查询历史。
 *
 * 导入十万行就是十万条 INSERT，逐条上报会把上限 100 条的历史整段冲干，
 * 且每条都触发一次持久化写入。命令层负责补一条汇总记录。
 */
const SKIP: QueryOptions = { skipHistory: true };

export interface ImportProgress {
  completed: number;
  total: number;
}

export interface ImportError {
  row: number;
  message: string;
}

export interface ImportResult {
  imported: number;
  rolledBack: boolean;
  errors: ImportError[];
}

export interface ImportRowsOptions {
  query: Pick<QueryService, 'query' | 'dialect'>;
  table: string;
  database?: string;
  rows: Record<string, unknown>[];
  mappings: FieldMapping[];
  onProgress?: (progress: ImportProgress) => void;
  isCancelled?: () => boolean;
  /**
   * 将全部语句（BEGIN + INSERT... + COMMIT）合并为一次 query 调用。
   * 对每次 query 都启动独立连接的驱动（如 SQLite CLI 子进程）必须开启，
   * 否则事务语句无法在同一连接内保持。
   */
  batchWrites?: boolean;
}

/**
 * Imports mapped rows atomically. A failed or cancelled import rolls back the
 * complete data set, preventing the partial writes common in one-row-at-a-time importers.
 */
export async function importRows(options: ImportRowsOptions): Promise<ImportResult> {
  const { query, table, database, rows, mappings, onProgress, isCancelled, batchWrites = false } = options;
  const mapped = mapRows(rows, mappings);
  if (!mapped.rows.length) return { imported: 0, rolledBack: false, errors: [] };
  if (batchWrites) return importRowsBatched({ query, table, database, mapped, onProgress, isCancelled });
  let started = false;
  let completed = 0;
  try {
    await query.query('BEGIN', undefined, SKIP);
    started = true;
    for (const row of mapped.rows) {
      if (isCancelled?.()) throw new TransferCancelledError();
      const sql = query.dialect.buildInsertSql([row], mapped.columns, table, database);
      await query.query(sql, undefined, SKIP);
      completed++;
      onProgress?.({ completed, total: mapped.rows.length });
    }
    await query.query('COMMIT', undefined, SKIP);
    return { imported: completed, rolledBack: false, errors: [] };
  } catch (error) {
    let rollbackSucceeded = false;
    if (started) {
      try {
        await query.query('ROLLBACK', undefined, SKIP);
        rollbackSucceeded = true;
      } catch { /* Preserve the original failure. */ }
    }
    if (error instanceof TransferCancelledError) throw error;
    return {
      imported: 0,
      rolledBack: rollbackSucceeded,
      errors: [{ row: completed + 1, message: (error as Error).message }],
    };
  }
}

/**
 * 单进程多语句路径：把整个导入作为一条 SQL 发送，供 SQLite 等按 query 独立建连接的驱动使用。
 * 失败时在进程内追加 ROLLBACK 后重试一次，保证事务原子性。
 */
async function importRowsBatched(
  options: Pick<ImportRowsOptions, 'query' | 'table' | 'database' | 'onProgress' | 'isCancelled'> & { mapped: { columns: string[]; rows: Record<string, unknown>[] } },
): Promise<ImportResult> {
  const { query, table, database, mapped, onProgress, isCancelled } = options;
  if (isCancelled?.()) throw new TransferCancelledError();
  const { columns, rows: dataRows } = mapped;
  const inserts = dataRows.map((row) => query.dialect.buildInsertSql([row], columns, table, database).trim());
  const sql = `BEGIN; ${inserts.join('\n')} COMMIT;`;
  try {
    await query.query(sql, undefined, SKIP);
    onProgress?.({ completed: dataRows.length, total: dataRows.length });
    return { imported: dataRows.length, rolledBack: false, errors: [] };
  } catch (error) {
    if (error instanceof TransferCancelledError) throw error;
    let rollbackSucceeded = false;
    try {
      await query.query('ROLLBACK', undefined, SKIP);
      rollbackSucceeded = true;
    } catch { /* Preserve the original failure. */ }
    return {
      imported: 0,
      rolledBack: rollbackSucceeded,
      errors: [{ row: 1, message: (error as Error).message }],
    };
  }
}
