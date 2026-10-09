import { SchemaDiffService } from './schemaDiffService.js';
import { DataDiffService } from './dataDiffService.js';
import type { QueryService, QueryOptions } from './queryService.js';
import type { MetadataService } from './metadataService.js';
import type { TableService } from './tableService.js';
import { splitExecutableStatements, scanOptionsForDialect } from '../sql/index.js';

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
  /** PG：源/目标 schema（同连接跨 schema 同步）。 */
  sourceSchema?: string;
  targetSchema?: string;
  /** 事务模式：遇首个错误即抛出（由调用方回滚），避免事务 aborted 后连带错误淹没首错（N3）。 */
  haltOnError?: boolean;
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
    const { tables: tableFilter, includeData = true, pageSize = 1000, onProgress, isCancelled, sourceSchema, targetSchema, haltOnError = false } = options;
    const errors: string[] = [];

    const schemaDiffs = await SchemaDiffService.diff(sourceMeta, sourceDb, targetMeta, targetDb, sourceSchema, targetSchema);
    const sourceSequences = sourceSchema ? await sourceMeta.getSequences(sourceSchema) : [];
    // 按表名索引，避免循环里对 schemaDiffs 反复线性查找（O(n²)）。
    const diffByName = new Map(schemaDiffs.map((d) => [d.tableName, d]));
    const tableList = tableFilter
      ?? schemaDiffs.map((d) => d.tableName).concat(
        (await sourceMeta.getTables(sourceDb, sourceSchema)).map((t) => t.name).filter((n) => !diffByName.has(n)),
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
            [diff], targetDb, sourceTable, sourceDb, targetQuery.dialect, { sourceSchema, targetSchema, dialect: targetQuery.dialect, skipConstraints: true, sourceSequences },
          );
          const statements = splitExecutableStatements(syncSql, scanOptionsForDialect(targetQuery.dialect));
          for (const stmt of statements) {
            if (stmt.trim()) await targetQuery.query(stmt.trim(), undefined, SKIP);
          }
        } catch (err) {
          // 结构同步失败只记录错误：**不**跳过下面的数据阶段（跨引擎时结构本就跳过，
          // 数据仍应同步；过去这里 continue 会让数据也一起没了）。
          errors.push(`${table}: schema sync failed - ${(err as Error).message}`);
          failedTables.add(table);
          // 事务模式：首错即抛，避免事务进入 aborted 后后续语句全部连带报错（N3）。
          if (haltOnError) throw new Error(`${table}: schema sync failed - ${(err as Error).message}`);
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
            { pageSize, isCancelled, sourceSchema, targetSchema },
          );
        } catch (err) {
          errors.push(`${table}: data sync failed - ${(err as Error).message}`);
          failedTables.add(table);
          if (haltOnError) throw new Error(`${table}: data sync failed - ${(err as Error).message}`);
        }
      }
    }

    // 表级约束 + schema 级对象（PG）：放在全部表结构与数据之后。
    // H6：外键/CHECK 在数据导入后再加，避免引用未建表或插入时违反约束。
    if (sourceSchema && targetSchema && sourceQuery.dialect.dbType === 'PG') {
      try {
        const constrainSql = SchemaDiffService.generateConstraintsSql(schemaDiffs, sourceTable, { sourceSchema, targetSchema });
        const obj = await SchemaDiffService.diffSchemaObjects(sourceMeta, targetMeta, sourceSchema, targetSchema);
        const objSql = SchemaDiffService.generateSchemaObjectsSql(obj, targetQuery.dialect, { sourceSchema, targetSchema });
        const sql = [constrainSql, objSql].filter(Boolean).join('\n');
        const statements = splitExecutableStatements(sql, scanOptionsForDialect(targetQuery.dialect));
        for (const stmt of statements) {
          if (isCancelled?.()) throw new Error('Transfer cancelled.');
          const s = stmt.trim();
          if (s && !s.startsWith('--')) await targetQuery.query(s, undefined, SKIP);
        }
        // setval：只处理**本次参与同步的表**所拥有的序列；带下界、空表用 minv 且 is_called=false；
        // 用唯一 `$devbelt_sync$` 标签避免与 schema 名里的 `$$` 冲突。
        const targetLit = targetQuery.dialect.escapeValue(targetSchema);
        const tableIn = [...new Set(uniqueTables)].map((t) => targetQuery.dialect.escapeValue(t)).join(', ');
        if (tableIn) {
          await targetQuery.query(`DO $devbelt_sync$
DECLARE r record; mx bigint;
BEGIN
  FOR r IN
    SELECT s.oid AS seq, n.nspname AS sch, t.relname AS tname, a.attname AS col, ps.seqmin::bigint AS minv
      FROM pg_class s
      JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
      JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      JOIN pg_namespace n ON n.oid = s.relnamespace
      JOIN pg_sequence ps ON ps.seqrelid = s.oid
     WHERE s.relkind = 'S' AND d.deptype IN ('a','i')
       AND n.nspname = ${targetLit} AND t.relname IN (${tableIn})
  LOOP
    EXECUTE format('SELECT max(%I) FROM %I.%I', r.col, r.sch, r.tname) INTO mx;
    IF mx IS NULL THEN PERFORM setval(r.seq, r.minv, false);
    ELSE PERFORM setval(r.seq, GREATEST(mx, r.minv), true); END IF;
  END LOOP;
END $devbelt_sync$;`, undefined, SKIP);
        }
      } catch (err) {
        errors.push(`schema objects: ${(err as Error).message}`);
        if (haltOnError) throw new Error(`schema objects: ${(err as Error).message}`);
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
    targetMeta: MetadataService,
    targetDb: string,
    options: { pageSize?: number; isCancelled?: () => boolean; sourceSchema?: string; targetSchema?: string },
  ): Promise<void> {
    const dataDiff = await DataDiffService.diff(
      sourceQuery, sourceMeta, sourceDb,
      targetQuery, targetDb,
      [table],
      { sourceSchema: options.sourceSchema, targetSchema: options.targetSchema, targetMeta },
    );
    const syncSql = DataDiffService.generateSyncSql(
      { diffs: dataDiff.diffs, sourceDb, targetDb },
      targetDb,
      targetQuery,
      options.targetSchema,
    );
    const statements = splitExecutableStatements(syncSql, scanOptionsForDialect(targetQuery.dialect));
    for (const stmt of statements) {
      if (options.isCancelled?.()) throw new Error('Transfer cancelled.');
      const trimmed = stmt.trim();
      if (trimmed && !trimmed.startsWith('--')) {
        await targetQuery.query(trimmed, undefined, SKIP);
      }
    }
  }
}
