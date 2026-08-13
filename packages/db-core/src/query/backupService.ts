import { DatabaseType } from '../types/connection';
import type { MetadataService } from './metadataService';
import type { TableService } from './tableService';
import type { QueryService } from './queryService';

export interface BackupProgress {
  table: string;
  completed: number;
  total: number;
}

export interface BackupOptions {
  tables?: string[];
  includeData?: boolean;
  pageSize?: number;
  onProgress?: (progress: BackupProgress) => void;
  isCancelled?: () => boolean;
}

export interface RestoreProgress {
  statement: string;
  completed: number;
  total: number;
  error?: string;
}

export interface RestoreOptions {
  onProgress?: (progress: RestoreProgress) => void;
  isCancelled?: () => boolean;
}

export class BackupService {
  static async databaseDump(
    query: QueryService,
    meta: MetadataService,
    tableService: TableService,
    database: string,
    options: BackupOptions = {},
  ): Promise<string> {
    const { tables, includeData = true, pageSize = 1000, onProgress, isCancelled } = options;
    const tableList = tables ?? (await meta.getTables(database)).map((t) => t.name);
    const parts: string[] = [];
    const dbType = query.dialect.dbType;

    parts.push(`-- DB Client Pro Dump`);
    parts.push(`-- Server Type: ${dbType}`);
    parts.push(`-- Database: ${database}`);
    parts.push(`-- Date: ${new Date().toISOString()}`);
    parts.push('');

    const prelude = this.sqlPrelude(dbType);
    if (prelude) parts.push(prelude + ';');

    for (let i = 0; i < tableList.length; i++) {
      if (isCancelled?.()) throw new Error('Backup cancelled.');
      const table = tableList[i];
      onProgress?.({ table, completed: i, total: tableList.length });

      const ddl = await tableService.getCreateSql(table, database);
      parts.push('');
      const qualifiedDrop = dbType === DatabaseType.SQLITE
        ? query.dialect.wrap(table)
        : `${query.dialect.wrap(database)}.${query.dialect.wrap(table)}`;
      parts.push(`DROP TABLE IF EXISTS ${qualifiedDrop};`);
      parts.push(ddl.replace(/;\s*$/, '') + ';');

      if (includeData) {
        const qualified = query.dialect.wrap(database) + '.' + query.dialect.wrap(table);
        const columns = (await meta.getColumns(table, database)).map((c) => c.name);
        const colList = columns.map((c) => query.dialect.wrap(c)).join(', ');

        let hasData = false;
        for (let offset = 0; ; offset += pageSize) {
          if (isCancelled?.()) throw new Error('Backup cancelled.');
          const sql = query.dialect.getPagedSql(
            `SELECT * FROM ${qualified}`, offset, pageSize,
          );
          const result = await query.query(sql);
          if (!hasData && result.rows.length > 0) {
            hasData = true;
            parts.push(`INSERT INTO ${qualified} (${colList}) VALUES`);
          }
          for (const row of result.rows as Record<string, unknown>[]) {
            const vals = columns.map((c) => {
              const v = row[c];
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'number') return String(v);
              return `'${String(v).replace(/'/g, "''")}'`;
            }).join(', ');
            parts.push(`(${vals}),`);
          }
          if (result.rows.length < pageSize) break;
        }
        if (hasData) {
          const last = parts.pop() || '';
          parts.push(last.replace(/,$/, ';'));
        }
      }
    }

    const epilogue = this.sqlEpilogue(dbType);
    if (epilogue) parts.push('' + epilogue + ';');

    onProgress?.({ table: '', completed: tableList.length, total: tableList.length });
    return parts.join('\n');
  }

  private static sqlPrelude(dbType: string): string {
    if (dbType === DatabaseType.MYSQL) return 'SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0';
    if (dbType === DatabaseType.PG) return "SET client_encoding = 'UTF8';\nSET session_replication_role = 'replica'";
    if (dbType === DatabaseType.SQLITE) return 'PRAGMA foreign_keys = OFF';
    return '';
  }

  private static sqlEpilogue(dbType: string): string {
    if (dbType === DatabaseType.MYSQL) return 'SET FOREIGN_KEY_CHECKS = 1';
    if (dbType === DatabaseType.PG) return "SET session_replication_role = 'origin'";
    if (dbType === DatabaseType.SQLITE) return 'PRAGMA foreign_keys = ON';
    return '';
  }

  static async restore(
    query: QueryService,
    statements: string[],
    options: RestoreOptions = {},
  ): Promise<RestoreProgress> {
    const { onProgress, isCancelled } = options;
    const total = statements.length;
    let completed = 0;
    const last: RestoreProgress = { statement: '', completed, total };

    try {
      await query.query('BEGIN');
      for (const stmt of statements) {
        if (isCancelled?.()) throw new Error('Restore cancelled.');
        const trimmed = stmt.trim();
        if (!trimmed) continue;
        try {
          await query.query(trimmed);
          completed++;
          const progress: RestoreProgress = { statement: trimmed.slice(0, 100), completed, total };
          onProgress?.(progress);
          last.statement = progress.statement;
          last.completed = completed;
        } catch (err) {
          const progress: RestoreProgress = {
            statement: trimmed.slice(0, 100),
            completed,
            total,
            error: (err as Error).message,
          };
          onProgress?.(progress);
          throw err;
        }
      }
      await query.query('COMMIT');
    } catch (err) {
      try { await query.query('ROLLBACK'); } catch {}
      throw err;
    }

    return last;
  }
}