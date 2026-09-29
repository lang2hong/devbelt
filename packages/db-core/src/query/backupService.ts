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
  /** PG 命名空间：给定时 dump 该 schema（对象名带 schema 限定，可恢复到空白库）。 */
  schema?: string;
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
    const { tables, includeData = true, pageSize = 1000, onProgress, isCancelled, schema } = options;
    const tableList = tables ?? (await meta.getTables(database, schema)).map((t) => t.name);
    const dbType = query.dialect.dbType;
    // B5：对象名**不带** schema/库前缀，dump 是「目标相对」的——恢复到哪个 schema/库，
    // 由恢复侧的 search_path（或所选库）决定，而不是 dump 里写死的源 schema。
    // `schema` 只用于**取对象清单**（决定 dump 哪些 schema 的对象）。
    const qualify = (name: string): string => query.dialect.wrap(name);

    const header: string[] = [
      '-- DevBelt Dump',
      `-- Server Type: ${dbType}`,
      `-- Database: ${sqlCommentSafe(database)}`,
      ...(schema ? [`-- Schema: ${sqlCommentSafe(schema)}`] : []),
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

      // 不带 schema/库前缀：dump 恢复到**当前连接选中的库/schema**（restore 设 search_path），
// 而不是 dump 里写死的源对象；dump 因此可在库/schema 之间迁移。
      const ddl = await tableService.getCreateSql(table, database);
      const qualified = qualify(table);
      const block: string[] = ['', `DROP TABLE IF EXISTS ${qualified};`, ddl.replace(/;\s*$/, '') + ';'];

      if (includeData) {
        const columnMeta = await meta.getColumns(table, database, schema);
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
    // 仅在**整库备份**（未指定 tables）时附带视图；只备份选定表时不应写入整库视图。
    try {
      const views = options.tables ? [] : await meta.getViews(database, schema);
      for (const v of views) {
        if (isCancelled?.()) throw new Error('Backup cancelled.');
        try {
          // 必须走方言 normalizeViewAlterSql：PG 的 getViewDefinition 只返回纯 SELECT，
          // 原样写出会先 DROP 再执行一个 SELECT —— 视图被删且永不重建。该方法同时
          // 为 MySQL 剥离绑定源账号的 ALGORITHM/DEFINER，并把 SQLite 转成 DROP+CREATE。
          const raw = await meta.getViewDefinition(v.name, database, schema);
          // 不传 database/schema：dump 保持不加前缀（目标相对，可跨库/schema 迁移）。
          const alter = query.dialect.normalizeViewAlterSql(raw, v.name, undefined, undefined);
          const qualified = qualify(v.name);
          await write(`\nDROP VIEW IF EXISTS ${qualified};\n${alter}\n`);
        } catch { /* 单个视图定义取不到则跳过，不使整库 dump 失败 */ }
      }
    } catch { /* 视图列表取不到则跳过 */ }

    // 例程/事件：仅在整库备份时附带。过去 dump 只写表 + 视图，存储过程/函数/事件
    // 全部丢失，恢复后应用的业务逻辑缺失（静默）。方言已有定义查询能力，这里补上。
    if (!options.tables) {
      try {
        for (const r of await meta.getFunctions(database, schema)) {
          if (isCancelled?.()) throw new Error('Backup cancelled.');
          try {
            const raw = (await meta.getRoutineDefinition(r.name, r.type, database, schema)).trim();
            if (!raw) continue;
            const kind = /PROCEDURE/i.test(r.type) ? 'PROCEDURE' : 'FUNCTION';
            const body = stripTrailingSemicolon(removeDefiner(raw));
            const q = query.dialect.wrap(r.name);
            if (dbType === DatabaseType.PG) {
              // pg_get_functiondef 返回 CREATE OR REPLACE，直接可重跑。
              await write(`\n${body};\n`);
            } else {
              // MySQL SHOW CREATE：需先 DROP（同名已存在会报错），并剥掉绑定源账号的
              // DEFINER；正文含分号，必须用 DELIMITER 包裹（切分器已支持）。
              await write(`\nDROP ${kind} IF EXISTS ${q};\nDELIMITER $$\n${body}$$\nDELIMITER ;\n`);
            }
          } catch { /* 单个例程取不到则跳过，不使整库 dump 失败 */ }
        }
      } catch { /* 例程列表取不到则跳过 */ }
      try {
        for (const e of await meta.getEvents(database, schema)) {
          if (isCancelled?.()) throw new Error('Backup cancelled.');
          try {
            const raw = (await meta.getEventDefinition(e.name, database, schema)).trim();
            if (!raw) continue;
            const body = stripTrailingSemicolon(removeDefiner(raw));
            await write(`\nDROP EVENT IF EXISTS ${query.dialect.wrap(e.name)};\nDELIMITER $$\n${body}$$\nDELIMITER ;\n`);
          } catch { /* 单个事件取不到则跳过 */ }
        }
      } catch { /* 事件列表取不到则跳过 */ }
    }

    // 触发器：属于表，必须在表之后写。整库对每张表；只备份选定表时也带上这些表的触发器。
    for (const table of tableList) {
      // 每张表单独取触发器列表：某张表失败（权限/视图/临时表）不应让其余表的触发器全部丢失。
      let triggers: Awaited<ReturnType<MetadataService['getTriggers']>>;
      try {
        triggers = await meta.getTriggers(table, database, schema);
      } catch { continue; }
      for (const t of triggers) {
        if (isCancelled?.()) throw new Error('Backup cancelled.');
        try {
          const raw = (await meta.getTriggerDefinition(t.name, database, schema, table)).trim();
          if (!raw) continue;
          const body = stripTrailingSemicolon(removeDefiner(raw));
          const q = query.dialect.wrap(t.name);
          // PG 的 DROP TRIGGER 必须带 ON <table>；MySQL/SQLite 不带。
          const drop = dbType === DatabaseType.PG
            ? `DROP TRIGGER IF EXISTS ${q} ON ${qualify(table)};`
            : `DROP TRIGGER IF EXISTS ${q};`;
          const wrapDelimiter = dbType === DatabaseType.MYSQL;
          await write(wrapDelimiter
            ? `\n${drop}\nDELIMITER $$\n${body}$$\nDELIMITER ;\n`
            : `\n${drop}\n${body};\n`);
        } catch { /* 单个触发器取不到则跳过 */ }
      }
    }

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
    statements: Iterable<string> | AsyncIterable<string>,
    options: RestoreOptions = {},
  ): Promise<RestoreProgress> {
    const { onProgress, isCancelled, singleStatement = false } = options;
    // 剥离 dump 自带的事务控制语句：恢复自身已用 BEGIN/COMMIT 包裹，dump 内再出现
    // COMMIT 会提前提交外层事务（回滚失效），BEGIN 则会嵌套。DDL 在 MySQL 会隐式
    // 提交，仍无法完全原子（已记入台账）。
    const txControl = /^(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|END)\s*;?\s*$/i;
    // 数组输入可预知总数（进度显示 N/M，旧行为）；流式输入（大文件不整读内存）
    // 只有在执行过程中才知道进度，总数按已完成数报。
    const isArray = Array.isArray(statements);
    const source: Iterable<string> | AsyncIterable<string> = isArray
      ? (statements as string[]).filter((s) => !txControl.test(s.trim()))
      : statements;
    const knownTotal = isArray ? (source as string[]).length : -1;

    if (singleStatement) {
      const arr: string[] = [];
      if (isArray) {
        arr.push(...(source as string[]));
      } else {
        for await (const s of source as AsyncIterable<string>) {
          if (!txControl.test(s.trim())) arr.push(s);
        }
      }
      return BackupService.restoreAsSingleStatement(query, arr, options);
    }

    let completed = 0;
    const last: RestoreProgress = { statement: '', completed, total: knownTotal < 0 ? 0 : knownTotal };
    const report = (statement: string, error?: string) => {
      const total = knownTotal < 0 ? completed : knownTotal;
      const progress: RestoreProgress = { statement, completed, total, ...(error ? { error } : {}) };
      onProgress?.(progress);
      last.statement = statement;
      last.completed = completed;
      last.total = total;
      if (error) last.error = error;
    };

    try {
      await query.query('BEGIN', undefined, SKIP);
      for await (const stmt of source as AsyncIterable<string>) {
        if (isCancelled?.()) throw new Error('Restore cancelled.');
        const trimmed = stmt.trim();
        if (!trimmed || txControl.test(trimmed)) continue;
        try {
          await query.query(trimmed, undefined, SKIP);
          completed++;
          report(trimmed.slice(0, 100));
        } catch (err) {
          report(trimmed.slice(0, 100), (err as Error).message);
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

/** 去掉末尾分号（写入时统一补一个）。 */
function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, '');
}

/**
 * 剥掉 `CREATE DEFINER=user@host`：它绑定 dump 来源账号，恢复到其他实例/账号时
 * 会因权限或用户不存在而失败（与视图 normalizeViewAlterSql 同样的原因）。
 */
function removeDefiner(sql: string): string {
  return sql.replace(/^CREATE\s+DEFINER=\S+\s+/i, 'CREATE ');
}

