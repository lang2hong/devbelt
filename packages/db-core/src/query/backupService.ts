import { DatabaseType } from '../types/connection.js';
import type { MetadataService } from './metadataService.js';
import type { TableService } from './tableService.js';
import type { QueryService, QueryOptions } from './queryService.js';
import { streamRowsByKeyset } from './paging.js';
import { sqlCommentSafe } from '../sql/index.js';

/**
 * 恢复过程中的每条语句都不进查询历史。
 *
 * 一个 dump 动辄上千条语句，逐条上报会把上限 100 条的历史整段冲干，
 * 真正有价值的手工操作记录反而丢失。命令层负责补一条汇总记录。
 */
const SKIP: QueryOptions = { skipHistory: true };

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
   * 收益：合并为一次往返，且整个事务在同一个常驻 sqlite3 进程内完成。驱动带
   * `-bail`，批内失败即中止退出并隐式回滚，因此原子性由驱动保证；逐句路径在
   * 常驻进程下同样保持事务，但会有多次往返。代价是失去逐句进度。
   */
  singleStatement?: boolean;
}

export class BackupService {
  /**
   * 生成整库 dump 字符串。
   *
   * 内部走 `writeDatabaseDump` 流式产出，本方法仅为需要一次性字符串的调用方保留。
   * 大库请优先用 `writeDatabaseDump` 边生成边写盘，避免整份 dump 驻留内存。
   */
  static async databaseDump(
    query: QueryService,
    meta: MetadataService,
    tableService: TableService,
    database: string,
    options: BackupOptions = {},
  ): Promise<string> {
    const chunks: string[] = [];
    await this.writeDatabaseDump(query, meta, tableService, database, (chunk) => { chunks.push(chunk); }, options);
    return chunks.join('');
  }

  /**
   * 流式生成整库 dump：按块回调 `write`，内存占用只与**单张表**的数据量相关，
   * 而不是整库（`databaseDump` 会累积整份字符串）。
   */
  static async writeDatabaseDump(
    query: QueryService,
    meta: MetadataService,
    tableService: TableService,
    database: string,
    write: (chunk: string) => void | Promise<void>,
    options: BackupOptions = {},
  ): Promise<void> {
    const { tables, includeData = true, pageSize = 1000, onProgress, isCancelled } = options;
    const tableList = tables ?? (await meta.getTables(database)).map((t) => t.name);
    const dbType = query.dialect.dbType;

    const header: string[] = [
      '-- DevBelt Dump',
      `-- Server Type: ${dbType}`,
      `-- Database: ${sqlCommentSafe(database)}`,
      `-- Date: ${new Date().toISOString()}`,
      '',
    ];
    const prelude = this.sqlPrelude(dbType);
    if (prelude) header.push(prelude + ';');
    await write(header.join('\n') + '\n');

    for (let i = 0; i < tableList.length; i++) {
      if (isCancelled?.()) throw new Error('Backup cancelled.');
      const table = tableList[i];
      onProgress?.({ table, completed: i, total: tableList.length });

      const ddl = await tableService.getCreateSql(table, database);
      const qualified = dbType === DatabaseType.SQLITE
        ? query.dialect.wrap(table)
        : `${query.dialect.wrap(database)}.${query.dialect.wrap(table)}`;
      const block: string[] = ['', `DROP TABLE IF EXISTS ${qualified};`, ddl.replace(/;\s*$/, '') + ';'];

      if (includeData) {
        const columnMeta = await meta.getColumns(table, database);
        const columns = columnMeta.map((c) => c.name);
        const colList = columns.map((c) => query.dialect.wrap(c)).join(', ');
        // 有主键 → keyset 深分页（不随页数线性变慢）；无主键回退 OFFSET。
        const pkColumns = columnMeta.filter((c) => c.isPrimary).map((c) => c.name);

        let hasData = false;
        for await (const rows of streamRowsByKeyset(
          query, query.dialect, `SELECT * FROM ${qualified}`, pkColumns, pageSize,
          { isCancelled, cancelError: () => new Error('Backup cancelled.') },
        )) {
          if (!hasData && rows.length > 0) {
            hasData = true;
            block.push(`INSERT INTO ${qualified} (${colList}) VALUES`);
          }
          for (const row of rows) {
            // 值转义必须走方言：此处曾自建 `'${String(v).replace(/'/g,"''")}'`，
            // 只处理单引号而漏掉反斜杠。MySQL 字符串字面量里 `\` 有转义语义，
            // `C:\tmp` 会被写成制表符（实测字符码 92,116 → 9），数据静默损坏。
            const vals = columns.map((c) => query.dialect.escapeValue(row[c])).join(', ');
            block.push(`(${vals}),`);
          }
        }
        if (hasData) {
          const last = block.pop() || '';
          block.push(last.replace(/,$/, ';'));
        }
      }
      await write(block.join('\n') + '\n');
    }

    // 视图：整库备份过去只含基表（getTables 只返回 BASE TABLE），视图全部缺失。
    // 这里补视图定义；例程/事件/触发器需要方言的 SHOW CREATE 能力，尚未实现（记入台账）。
    try {
      const views = await meta.getViews(database);
      for (const v of views) {
        if (isCancelled?.()) throw new Error('Backup cancelled.');
        try {
          const def = (await meta.getViewDefinition(v.name, database)).trim().replace(/;\s*$/, '');
          const qualified = dbType === DatabaseType.SQLITE
            ? query.dialect.wrap(v.name)
            : `${query.dialect.wrap(database)}.${query.dialect.wrap(v.name)}`;
          await write(`\nDROP VIEW IF EXISTS ${qualified};\n${def};\n`);
        } catch { /* 单个视图定义取不到则跳过，不使整库 dump 失败 */ }
      }
    } catch { /* 视图列表取不到则跳过 */ }

    const epilogue = this.sqlEpilogue(dbType);
    if (epilogue) await write('\n' + epilogue + ';\n');

    onProgress?.({ table: '', completed: tableList.length, total: tableList.length });
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
    // 剥离 dump 自带的事务控制语句：恢复自身已用 BEGIN/COMMIT 包裹，dump 内再出现
    // COMMIT 会提前提交外层事务（回滚失效），BEGIN 则会嵌套。DDL 在 MySQL 会隐式
    // 提交，仍无法完全原子（已记入台账）。
    const txControl = /^(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|END)\s*;?\s*$/i;
    const cleaned = statements.filter((s) => !txControl.test(s.trim()));
    if (singleStatement) {
      return BackupService.restoreAsSingleStatement(query, cleaned, options);
    }

    const total = cleaned.length;
    let completed = 0;
    const last: RestoreProgress = { statement: '', completed, total };

    try {
      await query.query('BEGIN', undefined, SKIP);
      for (const stmt of cleaned) {
        if (isCancelled?.()) throw new Error('Restore cancelled.');
        const trimmed = stmt.trim();
        if (!trimmed) continue;
        try {
          await query.query(trimmed, undefined, SKIP);
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
      await query.query('COMMIT', undefined, SKIP);
    } catch (err) {
      try { await query.query('ROLLBACK', undefined, SKIP); } catch {}
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
      await query.query(batch, undefined, SKIP);
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