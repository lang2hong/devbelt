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
  /**
   * 把整个 dump 作为**一条** `BEGIN; …; COMMIT;` 发送，而不是逐句执行。
   *
   * SQLite 必须开启：CLI 驱动每次 query 起独立子进程，逐句执行时 `BEGIN`
   * 随进程退出即失效，`ROLLBACK` 落在另一个进程上什么也撤销不了。代价是
   * 失去逐句进度。
   *
   * 注意：单进程只是原子性的**必要**条件。sqlite3 CLI 从 stdin 读 SQL 时默认
   * 不在报错处中止（需 `-bail`），一条失败后仍会执行到 `COMMIT;`。补齐 `-bail`
   * 前，本选项只能保证事务不被进程边界切断，不能保证失败即全撤。
   */
  singleStatement?: boolean;
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
    const { onProgress, isCancelled, singleStatement = false } = options;
    if (singleStatement) {
      return BackupService.restoreAsSingleStatement(query, statements, options);
    }

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

  /**
   * 单条语句恢复：整个 dump 拼成一条 `BEGIN; …; COMMIT;`，交由驱动一次执行。
   *
   * 供 SQLite 使用 —— 其 CLI 驱动每次 query 起独立进程，逐句执行时 `BEGIN`
   * 会随进程退出而失效。代价是只能在开始与结束各报一次进度。
   * 完整原子性还需驱动侧 `-bail`（见 RestoreOptions.singleStatement 注释）。
   */
  private static async restoreAsSingleStatement(
    query: QueryService,
    statements: string[],
    options: RestoreOptions,
  ): Promise<RestoreProgress> {
    const { onProgress, isCancelled } = options;
    const trimmed = statements.map((s) => s.trim()).filter((s) => s.length > 0);
    const total = trimmed.length;

    if (isCancelled?.()) throw new Error('Restore cancelled.');
    if (!total) return { statement: '', completed: 0, total: 0 };

    const withSemicolons = trimmed.map((s) => (s.endsWith(';') ? s : `${s};`));
    const batch = `BEGIN;\n${withSemicolons.join('\n')}\nCOMMIT;`;

    try {
      await query.query(batch);
    } catch (err) {
      // 不补发 ROLLBACK：批处理报错后驱动进程未走到 COMMIT 就退出，事务已被隐式
      // 回滚。在新进程里发 ROLLBACK 只会得到 "no transaction is active"，正是
      // singleStatement 要避免的那类错误。
      const progress: RestoreProgress = {
        statement: trimmed[0].slice(0, 100),
        completed: 0,
        total,
        error: (err as Error).message,
      };
      onProgress?.(progress);
      throw err;
    }

    const done: RestoreProgress = {
      statement: trimmed[total - 1].slice(0, 100),
      completed: total,
      total,
    };
    onProgress?.(done);
    return done;
  }
}