import type { QueryService } from './queryService';
import type { MetadataService } from './metadataService';

export type RowDiffStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface RowDiff {
  status: RowDiffStatus;
  pkValues: Record<string, unknown>;
  sourceRow?: Record<string, unknown>;
  targetRow?: Record<string, unknown>;
}

export interface TableDataDiff {
  tableName: string;
  pkColumns: string[];
  columnNames: string[];
  rows: RowDiff[];
}

export interface DataDiffResult {
  diffs: TableDataDiff[];
  sourceDb: string;
  targetDb: string;
}

export class DataDiffService {
  private static readonly BATCH_SIZE = 1000;

  static async diff(
    sourceQuery: QueryService,
    sourceMeta: MetadataService,
    sourceDb: string,
    targetQuery: QueryService,
    targetDb: string,
    tables?: string[],
  ): Promise<DataDiffResult> {
    const tableList = tables ?? (await sourceMeta.getTables(sourceDb)).map((t) => t.name);
    const diffs: TableDataDiff[] = [];

    for (const table of tableList) {
      const pkColumns = await this.getPkColumns(sourceMeta, table, sourceDb);
      const columnNames = await this.getColumnNames(sourceMeta, table, sourceDb);
      if (!pkColumns.length) continue;

      const diff = await this.diffTable(
        sourceQuery, table, sourceDb, pkColumns, columnNames,
        targetQuery, targetDb,
      );
      diffs.push(diff);
    }

    return { diffs, sourceDb, targetDb };
  }

  private static async getPkColumns(meta: MetadataService, table: string, db?: string): Promise<string[]> {
    try {
      const cols = await meta.getColumns(table, db);
      const pks = cols.filter((c) => c.isPrimary).map((c) => c.name);
      return pks.length ? pks : cols.map((c) => c.name);
    } catch {
      return [];
    }
  }

  private static async getColumnNames(meta: MetadataService, table: string, db?: string): Promise<string[]> {
    try {
      const cols = await meta.getColumns(table, db);
      return cols.map((c) => c.name);
    } catch {
      return [];
    }
  }

  private static async diffTable(
    sourceQuery: QueryService,
    table: string,
    sourceDb: string,
    pkColumns: string[],
    columnNames: string[],
    targetQuery: QueryService,
    targetDb: string,
  ): Promise<TableDataDiff> {
    const sourceMap = new Map<string, Record<string, unknown>>();
    const targetMap = new Map<string, Record<string, unknown>>();

    const wrap = (id: string) => sourceQuery.dialect.wrap(id);
    const qualifiedSource = sourceDb ? `${wrap(sourceDb)}.${wrap(table)}` : wrap(table);
    const qualifiedTarget = targetDb ? `${wrap(targetDb)}.${wrap(table)}` : wrap(table);

    const colList = columnNames.map((c) => wrap(c)).join(', ');

    for (let offset = 0; ; offset += this.BATCH_SIZE) {
      const sql = sourceQuery.dialect.getPagedSql(
        `SELECT ${colList} FROM ${qualifiedSource} ORDER BY ${pkColumns.map(wrap).join(', ')}`,
        offset, this.BATCH_SIZE,
      );
      const result = await sourceQuery.query(sql);
      for (const row of result.rows as Record<string, unknown>[]) {
        const key = pkColumns.map((c) => String(row[c])).join('|');
        sourceMap.set(key, row);
      }
      if (result.rows.length < this.BATCH_SIZE) break;
    }

    for (let offset = 0; ; offset += this.BATCH_SIZE) {
      const sql = targetQuery.dialect.getPagedSql(
        `SELECT ${colList} FROM ${qualifiedTarget} ORDER BY ${pkColumns.map(wrap).join(', ')}`,
        offset, this.BATCH_SIZE,
      );
      const result = await targetQuery.query(sql);
      for (const row of result.rows as Record<string, unknown>[]) {
        const key = pkColumns.map((c) => String(row[c])).join('|');
        targetMap.set(key, row);
      }
      if (result.rows.length < this.BATCH_SIZE) break;
    }

    const rows: RowDiff[] = [];

    for (const [key, srcRow] of sourceMap) {
      const tgtRow = targetMap.get(key);
      if (!tgtRow) {
        rows.push({ status: 'added', pkValues: extractPk(pkColumns, srcRow), sourceRow: srcRow });
      } else if (!this.rowsEqual(srcRow, tgtRow, columnNames)) {
        rows.push({ status: 'changed', pkValues: extractPk(pkColumns, srcRow), sourceRow: srcRow, targetRow: tgtRow });
      }
    }

    for (const [key, tgtRow] of targetMap) {
      if (!sourceMap.has(key)) {
        rows.push({ status: 'removed', pkValues: extractPk(pkColumns, tgtRow), targetRow: tgtRow });
      }
    }

    return { tableName: table, pkColumns, columnNames, rows };
  }

  private static rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>, cols: string[]): boolean {
    for (const c of cols) {
      const va = a[c] ?? null;
      const vb = b[c] ?? null;
      if (String(va) !== String(vb)) return false;
    }
    return true;
  }

  static generateSyncSql(diffs: DataDiffResult, targetDb: string, sourceQuery: QueryService): string {
    const parts: string[] = [];
    parts.push(`-- Data sync: ${diffs.sourceDb} → ${diffs.targetDb}`);
    parts.push('');

    for (const td of diffs.diffs) {
      if (!td.rows.length) continue;
      const wrap = (id: string) => sourceQuery.dialect.wrap(id);
      // 值转义走方言：此处曾用文件级私有 escapeValue，只处理单引号而漏掉反斜杠，
      // MySQL 下 `C:\tmp` 中的 `\t` 会被解释成制表符，同步过去的数据与源库不一致。
      const esc = (v: unknown) => sourceQuery.dialect.escapeValue(v);
      const qualifiedTarget = targetDb ? `${wrap(targetDb)}.${wrap(td.tableName)}` : wrap(td.tableName);
      const colList = td.columnNames.map(wrap).join(', ');

      const added = td.rows.filter((r) => r.status === 'added');
      const changed = td.rows.filter((r) => r.status === 'changed');
      const removed = td.rows.filter((r) => r.status === 'removed');

      if (removed.length) {
        parts.push(`-- ${td.tableName}: ${removed.length} row(s) to delete`);
        for (const r of removed) {
          const where = td.pkColumns.map((c) => `${wrap(c)} = ${esc(r.pkValues[c])}`).join(' AND ');
          parts.push(`DELETE FROM ${qualifiedTarget} WHERE ${where};`);
        }
        parts.push('');
      }

      if (added.length) {
        parts.push(`-- ${td.tableName}: ${added.length} row(s) to insert`);
        for (const r of added) {
          const vals = td.columnNames.map((c) => esc(r.sourceRow?.[c])).join(', ');
          parts.push(`INSERT INTO ${qualifiedTarget} (${colList}) VALUES (${vals});`);
        }
        parts.push('');
      }

      if (changed.length) {
        parts.push(`-- ${td.tableName}: ${changed.length} row(s) to update`);
        for (const r of changed) {
          const set = td.columnNames.map((c) => `${wrap(c)} = ${esc(r.sourceRow?.[c])}`).join(', ');
          const where = td.pkColumns.map((c) => `${wrap(c)} = ${esc(r.pkValues[c])}`).join(' AND ');
          parts.push(`UPDATE ${qualifiedTarget} SET ${set} WHERE ${where};`);
        }
        parts.push('');
      }
    }

    if (parts.length === 2) {
      parts.push('-- No data differences found.');
    }
    return parts.join('\n');
  }
}

function extractPk(pkColumns: string[], row: Record<string, unknown>): Record<string, unknown> {
  const pk: Record<string, unknown> = {};
  for (const c of pkColumns) pk[c] = row[c];
  return pk;
}

