import type { QueryOptions, QueryService } from '@devkit/db-core';
import { mapRows, validateMappings, type FieldMapping } from './fieldMapper';
import { TransferCancelledError } from './exportService';
import { CSV_ROW_LINE } from './csv';

/** 源行附带的物理行号（CSV 才有）；无则回退到「已完成数 + 偏移」。 */
function sourceLineOf(row: Record<string, unknown>): number | undefined {
  return (row as Record<PropertyKey, unknown>)[CSV_ROW_LINE] as number | undefined;
}

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
  let lastLine: number | undefined;
  const total = rows.length;
  try {
    await query.query('BEGIN', undefined, SKIP);
    started = true;
    // 逐行即时映射：过去先 mapRows 生成整份映射副本再逐行插入，大文件下内存翻倍。
    // 非批处理路径每次只用一个映射行。
    for (const row of rows) {
      if (isCancelled?.()) throw new TransferCancelledError();
      lastLine = sourceLineOf(row);
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
      errors: [{ row: lastLine ?? completed + 1 + rowOffset, message: (error as Error).message }],
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
    // 边读边映射边拼批，不再先把整份源数据收集成数组（SQLite 单进程驱动要求单次
    // query 内完成事务，故仍须把语句拼成一条，但省掉源行与映射副本的双份驻留）。
    return importRowsStreamBatched({ query, table, database, rows, mappings, onProgress, isCancelled, rowOffset });
  }

  const selected = validateMappings(mappings);
  const columns = selected.map((mapping) => mapping.target);
  let started = false;
  let completed = 0;
  let lastLine: number | undefined;
  try {
    await query.query('BEGIN', undefined, SKIP);
    started = true;
    for await (const sourceRow of rows) {
      if (isCancelled?.()) throw new TransferCancelledError();
      lastLine = sourceLineOf(sourceRow);
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
      errors: [{ row: lastLine ?? completed + 1 + rowOffset, message: (error as Error).message }],
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
  const statements: string[] = [];
  for (let i = 0; i < dataRows.length; i += BATCH_ROWS) {
    statements.push(query.dialect.buildInsertSql(dataRows.slice(i, i + BATCH_ROWS), columns, table, database).trim());
  }
  const sql = `BEGIN; ${statements.join('\n')} COMMIT;`;
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

/** 批处理每批行数：限制单批拼接的峰值与语句数量，避免一行一条的巨大语句数组。 */
const BATCH_ROWS = 200;

/**
 * 流式批处理导入（SQLite 等单进程驱动）：边迭代边映射，按批拼接多值语句，最后一次 query
 * 发送 `BEGIN; …; COMMIT;` 保持原子性；不再先收集整份源数据。
 */
async function importRowsStreamBatched(
  options: Omit<ImportRowsOptions, 'rows'> & { rows: AsyncIterable<Record<string, unknown>> },
): Promise<ImportResult> {
  const { query, table, database, rows, mappings, onProgress, isCancelled, rowOffset = 0 } = options;
  const selected = validateMappings(mappings);
  const columns = selected.map((mapping) => mapping.target);
  const statements: string[] = [];
  let chunk: Record<string, unknown>[] = [];
  let completed = 0;
  let firstLine: number | undefined;
  const flush = (): void => {
    if (!chunk.length) return;
    statements.push(query.dialect.buildInsertSql(chunk, columns, table, database).trim());
    completed += chunk.length;
    chunk = [];
  };
  try {
    for await (const sourceRow of rows) {
      if (isCancelled?.()) throw new TransferCancelledError();
      // 批处理无法逐行定位，但至少报出首个源行的物理行（CSV 有）而非固定 1。
      if (firstLine === undefined) firstLine = sourceLineOf(sourceRow);
      const mappedRow: Record<string, unknown> = {};
      for (const mapping of selected) mappedRow[mapping.target] = sourceRow[mapping.source];
      chunk.push(mappedRow);
      if (chunk.length >= BATCH_ROWS) flush();
    }
    flush();
    if (!statements.length) return { imported: 0, rolledBack: false, errors: [] };
    const sql = `BEGIN; ${statements.join('\n')} COMMIT;`;
    await query.query(sql, undefined, SKIP);
    onProgress?.({ completed, total: completed });
    return { imported: completed, rolledBack: false, errors: [] };
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
      errors: [{ row: firstLine ?? 1 + rowOffset, message: (error as Error).message }],
    };
  }
}
