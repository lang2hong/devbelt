import type { QueryService } from '@db-client/core';
import { mapRows, type FieldMapping } from './fieldMapper';
import { TransferCancelledError } from './exportService';

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
}

/**
 * Imports mapped rows atomically. A failed or cancelled import rolls back the
 * complete data set, preventing the partial writes common in one-row-at-a-time importers.
 */
export async function importRows(options: ImportRowsOptions): Promise<ImportResult> {
  const { query, table, database, rows, mappings, onProgress, isCancelled } = options;
  const mapped = mapRows(rows, mappings);
  if (!mapped.rows.length) return { imported: 0, rolledBack: false, errors: [] };
  let started = false;
  let completed = 0;
  try {
    await query.query('BEGIN');
    started = true;
    for (const row of mapped.rows) {
      if (isCancelled?.()) throw new TransferCancelledError();
      const sql = query.dialect.buildInsertSql([row], mapped.columns, table, database);
      await query.query(sql);
      completed++;
      onProgress?.({ completed, total: mapped.rows.length });
    }
    await query.query('COMMIT');
    return { imported: completed, rolledBack: false, errors: [] };
  } catch (error) {
    if (started) {
      try { await query.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    }
    if (error instanceof TransferCancelledError) throw error;
    return {
      imported: 0,
      rolledBack: started,
      errors: [{ row: completed + 1, message: (error as Error).message }],
    };
  }
}
