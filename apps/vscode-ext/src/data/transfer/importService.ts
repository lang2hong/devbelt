import type { QueryOptions, QueryService } from '@devkit/db-core';
import { mapRows, validateMappings, type FieldMapping } from './fieldMapper';
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
  /**
   * 首个数据行在源文件中的行号偏移（如带表头的 CSV/xlsx，首行数据是第 2 行 → 1）。
   * 报错行号按源文件行显示，而不是「映射后第几条」，用户才能定位到文件。
   */
  rowOffset?: number;
}

/**
 * Imports mapped rows atomically. A failed or cancelled import rolls back the
 * complete data set, preventing the partial writes common in one-row-at-a-time importers.
 */
export async function importRows(options: ImportRowsOptions): Promise<ImportResult> {
  const { query, table, database, rows, mappings, onProgress, isCancelled, batchWrites = false, rowOffset = 0 } = options;
  const selected = validateMappings(mappings);
  const columns = selected.map((mapping) => mapping.target);
  if (!rows.length) return { imported: 0, rolledBack: false, errors: [] };
  if (batchWrites) {
    // 批处理路径要把整批拼成一条 SQL，无法逐行释放，仍需完整映射副本。
    const mapped = mapRows(rows, mappings);
    return importRowsBatched({ query, table, database, mapped, onProgress, isCancelled, rowOffset });
  }
  let started = false;
  let completed = 0;
  const total = rows.length;
  try {
    await query.query('BEGIN', undefined, SKIP);
    started = true;
    // 逐行即时映射：过去先 mapRows 生成整份映射副本再逐行插入，大文件下内存翻倍。
    // 非批处理路径每次只用一个映射行。
    for (const row of rows) {
      if (isCancelled?.()) throw new TransferCancelledError();
      const mappedRow: Record<string, unknown> = {};
      for (const mapping of selected) mappedRow[mapping.target] = row[mapping.source];
      const sql = query.dialect.buildInsertSql([mappedRow], columns, table, database);
      await query.query(sql, undefined, SKIP);
      completed++;
      onProgress?.({ completed, total });
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
      errors: [{ row: completed + 1 + rowOffset, message: (error as Error).message }],
    };
  }
}

/**
 * 流式导入：源行来自异步迭代器（如逐块解析的 CSV），非批处理路径下逐行映射并插入，
 * 不把整份源数据或整份映射副本放进内存；整个导入仍在单个事务内，失败回滚。
 *
 * SQLite（batchWrites）需要把整批拼成一条 SQL，无法逐行释放，因此先收集再走原导入。
 */
export async function importRowsStream(
  options: Omit<ImportRowsOptions, 'rows'> & { rows: AsyncIterable<Record<string, unknown>> },
): Promise<ImportResult> {
  const { query, table, database, rows, mappings, onProgress, isCancelled, batchWrites = false, rowOffset = 0 } = options;
  if (batchWrites) {
    const collected: Record<string, unknown>[] = [];
    for await (const row of rows) collected.push(row);
    return importRows({ query, table, database, rows: collected, mappings, onProgress, isCancelled, batchWrites, rowOffset });
  }

  const selected = validateMappings(mappings);
  const columns = selected.map((mapping) => mapping.target);
  let started = false;
  let completed = 0;
  try {
    await query.query('BEGIN', undefined, SKIP);
    started = true;
    for await (const sourceRow of rows) {
      if (isCancelled?.()) throw new TransferCancelledError();
      const mappedRow: Record<string, unknown> = {};
      for (const mapping of selected) mappedRow[mapping.target] = sourceRow[mapping.source];
      const sql = query.dialect.buildInsertSql([mappedRow], columns, table, database);
      await query.query(sql, undefined, SKIP);
      completed++;
      // 流式来源总数未知，按已完成数上报（与恢复流式一致）。
      onProgress?.({ completed, total: completed });
    }
    await query.query('COMMIT', undefined, SKIP);
    return { imported: completed, rolledBack: false, errors: [] };
  } catch (error) {
    let rollbackSucceeded = false;
    if (started) {
      try { await query.query('ROLLBACK', undefined, SKIP); rollbackSucceeded = true; } catch { /* preserve original */ }
    }
    if (error instanceof TransferCancelledError) throw error;
    return {
      imported: 0,
      rolledBack: rollbackSucceeded,
      errors: [{ row: completed + 1 + rowOffset, message: (error as Error).message }],
    };
  }
}

/**
 * 单进程多语句路径：把整个导入作为一条 SQL 发送，供 SQLite 等按 query 独立建连接的驱动使用。
 * 失败时在进程内追加 ROLLBACK 后重试一次，保证事务原子性。
 */
async function importRowsBatched(
  options: Pick<ImportRowsOptions, 'query' | 'table' | 'database' | 'onProgress' | 'isCancelled'> & { mapped: { columns: string[]; rows: Record<string, unknown>[] }; rowOffset?: number },
): Promise<ImportResult> {
  const { query, table, database, mapped, onProgress, isCancelled, rowOffset = 0 } = options;
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
      errors: [{ row: 1 + rowOffset, message: (error as Error).message }],
    };
  }
}
