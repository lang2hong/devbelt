import { SchemaDiffService } from './schemaDiffService';
import { DataDiffService } from './dataDiffService';
import type { QueryService, QueryOptions } from './queryService';
import type { MetadataService } from './metadataService';
import type { TableService } from './tableService';

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
        try {
          const syncSql = await SchemaDiffService.generateSyncSql(
            [diff], targetDb, sourceTable, sourceDb,
          );
          const statements = splitSql(syncSql);
          for (const stmt of statements) {
            if (stmt.trim()) await targetQuery.query(stmt.trim(), undefined, SKIP);
          }
        } catch (err) {
          errors.push(`${table}: schema sync failed - ${(err as Error).message}`);
          continue;
        }
      }

      // 数据阶段对**所有**需要同步的表执行，包括 status='added'。
      //
      // 原先这里排除了 'added'（`diff?.status !== 'added'`），配套一个
      // `else if (diff?.status === 'added')` 分支想走 transferTable 补数据。
      // 但那个 else-if 永不可达：上面的 `if (diff && diff.status !== 'unchanged')`
      // 已经吞掉了 'added'。结果是新增表只建了结构、数据从未复制，
      // 而 transferTable 成了死代码。
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

  /**
   * 单表迁移（DROP + 重建 DDL + 分页灌数据）。
   *
   * 供调用方单独迁移一张表使用。`transferDatabase` 走的是
   * 「schema diff 同步结构 + syncTableData 同步数据」两阶段路径，不经过这里。
   */
  static async transferTable(
    sourceQuery: QueryService,
    sourceMeta: MetadataService,
    sourceTable: TableService,
    sourceDb: string,
    sourceTableName: string,
    targetQuery: QueryService,
    _targetMeta: MetadataService,
    targetDb: string,
    options: { includeData?: boolean; pageSize?: number; isCancelled?: () => boolean } = {},
  ): Promise<void> {
    const { includeData = true, pageSize = 1000, isCancelled } = options;
    const wrap = sourceQuery.dialect.wrap;

    const ddl = await sourceTable.getCreateSql(sourceTableName, sourceDb);
    const qualifiedTarget = targetDb ? `${wrap(targetDb)}.${wrap(sourceTableName)}` : wrap(sourceTableName);
    await targetQuery.query(`DROP TABLE IF EXISTS ${qualifiedTarget}`, undefined, SKIP);
    const adaptedDdl = ddl
      .replace(/^CREATE\s+TABLE\s+`([^`]+)`/i, (_, name) => `CREATE TABLE \`${targetDb}\`.\`${name}\``)
      .replace(/;\s*$/, '');
    await targetQuery.query(adaptedDdl + ';', undefined, SKIP);

    if (!includeData) return;

    const cols = (await sourceMeta.getColumns(sourceTableName, sourceDb)).map((c) => c.name);
    const colList = cols.map(wrap).join(', ');
    const qualifiedSource = sourceDb ? `${wrap(sourceDb)}.${wrap(sourceTableName)}` : wrap(sourceTableName);

    for (let offset = 0; ; offset += pageSize) {
      if (isCancelled?.()) throw new Error('Transfer cancelled.');
      const sql = sourceQuery.dialect.getPagedSql(
        `SELECT * FROM ${qualifiedSource}`, offset, pageSize,
      );
      const result = await sourceQuery.query(sql);
      if (!result.rows.length) break;

      const rows = result.rows as Record<string, unknown>[];
      const values = rows.map((row) => {
        // 用**目标**方言转义：这批值要写进目标库，字符串字面量规则以目标为准。
        // 此处曾自建只处理单引号的转义，跨库迁移时反斜杠会被 MySQL 当转义符吃掉。
        const vals = cols.map((c) => targetQuery.dialect.escapeValue(row[c])).join(', ');
        return `(${vals})`;
      }).join(',\n');

      await targetQuery.query(`INSERT INTO ${qualifiedTarget} (${colList}) VALUES\n${values}`, undefined, SKIP);
    }
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
    const statements = splitSql(syncSql);
    for (const stmt of statements) {
      if (options.isCancelled?.()) throw new Error('Transfer cancelled.');
      const trimmed = stmt.trim();
      if (trimmed && !trimmed.startsWith('--')) {
        await targetQuery.query(trimmed, undefined, SKIP);
      }
    }
  }
}

/**
 * 按分号切分 SQL，**丢弃注释**，只产出可执行语句。
 *
 * 两处必须注意：
 *
 * 1. `--` 注释不能写回缓冲区。原实现是 `buf += sql.slice(i, nl)`，把注释文本
 *    留在了当前语句里。`generateSyncSql` 的产物形如
 *    `-- Data sync: …\n\n-- t: 1 row\nINSERT INTO …;`，整段直到第一个分号才被
 *    切开，于是切出的唯一元素以 `--` 开头，被调用方的 `startsWith('--')` 过滤
 *    整条跳过 —— 数据同步的 INSERT/UPDATE/DELETE **从未真正执行**。
 *    这里与 `/* *\/` 的处理保持一致：直接跳过，不入 buf。
 *
 * 2. 注释内的分号不参与切分（跳过整段注释后 `;` 自然不会被看到），
 *    避免 `-- note; more` 把一条语句切成两半。
 */
function splitSql(sql: string): string[] {
  const result: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (!inSingle && !inDouble && !inBacktick && ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) { i = sql.length; continue; }
      // 跳过注释正文，保留换行让语句之间不粘连
      i = nl;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick && ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      i = stop;
      continue;
    }
    if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (ch === '\x60' && !inSingle && !inDouble) inBacktick = !inBacktick;

    if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
      const stmt = buf.trim();
      if (stmt) result.push(stmt);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const last = buf.trim();
  if (last) result.push(last);
  return result;
}