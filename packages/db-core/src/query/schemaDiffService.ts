import type { MetadataService } from './metadataService.js';
import type { TableService } from './tableService.js';
import type { ColumnMeta } from '../types/meta.js';
import { validateIdent } from '../utils/validate.js';
import { validateColumnType } from './columnSpec.js';

/** 列差异 */
export interface ColumnDiff {
  columnName: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  sourceType?: string;
  targetType?: string;
  /** 源列是否 NOT NULL（生成同步 DDL 时需要一并带上，否则只同步类型会丢约束）。 */
  sourceNotNull?: boolean;
}

/** 表差异 */
export interface TableDiff {
  tableName: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  columns: ColumnDiff[];
}

/**
 * 结构差异服务：比对两个数据库的表结构，生成同步 SQL。
 *
 * 设计模式：策略模式（纯比较逻辑，不依赖具体连接）
 */
export class SchemaDiffService {
  /**
   * 比对两个数据库的表结构差异。
   * @param sourceMeta 源库元数据服务
   * @param sourceDb 源库名
   * @param targetMeta 目标库元数据服务
   * @param targetDb 目标库名
   */
  static async diff(
    sourceMeta: MetadataService,
    sourceDb: string,
    targetMeta: MetadataService,
    targetDb: string,
  ): Promise<TableDiff[]> {
    const [sourceTables, targetTables] = await Promise.all([
      sourceMeta.getTables(sourceDb),
      targetMeta.getTables(targetDb),
    ]);

    const sourceNames = new Set(sourceTables.map((t) => t.name));
    const targetNames = new Set(targetTables.map((t) => t.name));
    const result: TableDiff[] = [];

    // 源库有、目标无 → added
    for (const t of sourceTables) {
      if (!targetNames.has(t.name)) {
        result.push({ tableName: t.name, status: 'added', columns: [] });
      }
    }
    // 目标有、源库无 → removed
    for (const t of targetTables) {
      if (!sourceNames.has(t.name)) {
        result.push({ tableName: t.name, status: 'removed', columns: [] });
      }
    }
    // 都有 → 比较 columns
    for (const t of sourceTables) {
      if (!targetNames.has(t.name)) continue;
      const [sourceCols, targetCols] = await Promise.all([
        sourceMeta.getColumns(t.name, sourceDb),
        targetMeta.getColumns(t.name, targetDb),
      ]);
      const colDiffs = this.diffColumns(sourceCols, targetCols);
      result.push({
        tableName: t.name,
        status: colDiffs.some((c) => c.status !== 'unchanged') ? 'changed' : 'unchanged',
        columns: colDiffs,
      });
    }

    return result;
  }

  /** 比对列差异 */
  private static diffColumns(source: ColumnMeta[], target: ColumnMeta[]): ColumnDiff[] {
    const sourceMap = new Map(source.map((c) => [c.name, c]));
    const targetMap = new Map(target.map((c) => [c.name, c]));
    const diffs: ColumnDiff[] = [];

    for (const [name, srcCol] of sourceMap) {
      const tgtCol = targetMap.get(name);
      const notNull = !!srcCol.isNotNull;
      if (!tgtCol) {
        diffs.push({ columnName: name, status: 'added', sourceType: srcCol.type, sourceNotNull: notNull });
      } else if (String(srcCol.type) !== String(tgtCol.type) || !!tgtCol.isNotNull !== notNull) {
        // 过去只比类型：NOT NULL 变化被判为「无差异」，同步也不会补约束。
        diffs.push({ columnName: name, status: 'changed', sourceType: srcCol.type, targetType: tgtCol.type, sourceNotNull: notNull });
      } else {
        diffs.push({ columnName: name, status: 'unchanged' });
      }
    }
    for (const [name, tgtCol] of targetMap) {
      if (!sourceMap.has(name)) {
        diffs.push({ columnName: name, status: 'removed', targetType: tgtCol.type });
      }
    }

    return diffs;
  }

  /**
   * 根据差异生成同步 SQL（将源库结构同步到目标库）。
   * @param diffs 差异列表
   * @param targetDb 目标库名
   * @param sourceTableService 源库表服务（用于获取新增表的 DDL）
   * @param sourceDb 源库名
   */
  static async generateSyncSql(
    diffs: TableDiff[],
    targetDb: string,
    sourceTableService: TableService,
    sourceDb: string,
  ): Promise<string> {
    if (!sourceTableService.supports('schemaSync')) {
      throw new Error('Schema sync SQL is currently supported for MySQL only');
    }
    const targetDbIdent = validateIdent(targetDb);
    const parts: string[] = [];
    parts.push(`-- Schema sync: ${sourceDb} → ${targetDb}`);
    parts.push('');

    for (const d of diffs) {
      const tableIdent = validateIdent(d.tableName);
      if (d.status === 'added') {
        const ddl = await sourceTableService.getCreateSql(d.tableName, sourceDb);
        parts.push(`-- Add table: ${d.tableName}`);
        parts.push(`DROP TABLE IF EXISTS \`${targetDbIdent}\`.\`${tableIdent}\`;`);
        // 只给表头（CREATE TABLE 后的首个反引号标识符）加库前缀；列名不能被拼接 `db.` 前缀。
        parts.push(ddl.replace(/^CREATE\s+TABLE\s+`([^`]+)`/i, `CREATE TABLE \`${targetDbIdent}\`.\`$1\``) + ';');
        parts.push('');
      } else if (d.status === 'removed') {
        parts.push(`-- Drop table: ${d.tableName}`);
        parts.push(`DROP TABLE IF EXISTS \`${targetDbIdent}\`.\`${tableIdent}\`;`);
        parts.push('');
      } else if (d.status === 'changed') {
        const changes: string[] = [];
        for (const c of d.columns) {
          const colIdent = validateIdent(c.columnName);
          // sourceType 来自源库 information_schema 列元数据，属**跨信任面**（源库可能不可信）。
          // 类型是必须裸拼进 DDL 的部分，故与用户输入路径同一门槛校验（括号/引号闭合、白名单字符）。
          if (c.status === 'added') {
            changes.push(`  ADD COLUMN \`${colIdent}\` ${validateColumnType(c.sourceType || 'TEXT')}${c.sourceNotNull ? ' NOT NULL' : ''}`);
          } else if (c.status === 'removed') {
            changes.push(`  DROP COLUMN \`${colIdent}\``);
          } else if (c.status === 'changed') {
            // 类型或 NOT NULL 变化：MODIFY 必须写全，否则只给定类型会把 NOT NULL 丢掉。
            changes.push(`  MODIFY COLUMN \`${colIdent}\` ${validateColumnType(c.sourceType || 'TEXT')}${c.sourceNotNull ? ' NOT NULL' : ' NULL'}`);
          }
        }
        if (changes.length) {
          parts.push(`-- Alter table: ${d.tableName}`);
          parts.push(`ALTER TABLE \`${targetDbIdent}\`.\`${tableIdent}\` ` + changes.join(',\n') + ';');
          parts.push('');
        }
      }
    }

    if (parts.length <= 2) {
      parts.push('-- No differences found. Schemas are in sync.');
    }

    return parts.join('\n');
  }
}
