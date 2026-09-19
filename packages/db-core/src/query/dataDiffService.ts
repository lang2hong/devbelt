import type { QueryService } from './queryService.js';
import type { MetadataService } from './metadataService.js';
import { streamRowsByKeyset } from './paging.js';

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
      // 排序/游标列必须是真实主键（NOT NULL 且唯一）；无主键时留空 → OFFSET 分页（完整）。
      // 行匹配键列则回退全列（无主键表的身份），但绝不拿它当 keyset 游标（可空列会静默丢行）。
      const orderColumns = await this.getPkColumns(sourceMeta, table, sourceDb);
      const keyColumns = orderColumns.length ? orderColumns : await this.getKeyColumns(sourceMeta, table, sourceDb);
      const columnNames = await this.getColumnNames(sourceMeta, table, sourceDb);
      if (!keyColumns.length) continue;

      const diff = await this.diffTable(
        sourceQuery, table, sourceDb, orderColumns, keyColumns, columnNames,
        targetQuery, targetDb,
      );
      diffs.push(diff);
    }

    return { diffs, sourceDb, targetDb };
  }

  /** 真实主键列（仅 isPrimary）；无则空数组。 */
  private static async getPkColumns(meta: MetadataService, table: string, db?: string): Promise<string[]> {
    try {
      const cols = await meta.getColumns(table, db);
      return cols.filter((c) => c.isPrimary).map((c) => c.name);
    } catch {
      return [];
    }
  }

  /** 行匹配键列：优先主键，无主键时回退全列（仅供建映射，不作游标）。 */
  private static async getKeyColumns(meta: MetadataService, table: string, db?: string): Promise<string[]> {
    try {
      const cols = await meta.getColumns(table, db);
      return cols.map((c) => c.name);
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
    orderColumns: string[],
    keyColumns: string[],
    columnNames: string[],
    targetQuery: QueryService,
    targetDb: string,
  ): Promise<TableDataDiff> {
    // 无键列会退化成 `ORDER BY `（语法错误）且所有行 key 都是空串而互相覆盖，
    // 必须显式拒绝，而不是生成无效 SQL。
    if (keyColumns.length === 0) {
      throw new Error(`data diff requires at least one key column for table ${table}`);
    }
    const sourceMap = new Map<string, Record<string, unknown>>();
    const targetMap = new Map<string, Record<string, unknown>>();

    const wrap = (id: string) => sourceQuery.dialect.wrap(id);
    const targetWrap = (id: string) => targetQuery.dialect.wrap(id);
    const qualifiedSource = sourceDb ? `${wrap(sourceDb)}.${wrap(table)}` : wrap(table);
    const qualifiedTarget = targetDb ? `${targetWrap(targetDb)}.${targetWrap(table)}` : targetWrap(table);

    const colList = columnNames.map((c) => wrap(c)).join(', ');
    const targetColList = columnNames.map((c) => targetWrap(c)).join(', ');

    for await (const rows of streamRowsByKeyset(
      sourceQuery, sourceQuery.dialect, `SELECT ${colList} FROM ${qualifiedSource}`, orderColumns, this.BATCH_SIZE,
    )) {
      for (const row of rows) {
        const key = keyColumns.map((c) => String(row[c])).join('|');
        sourceMap.set(key, row);
      }
    }

    for await (const rows of streamRowsByKeyset(
      targetQuery, targetQuery.dialect, `SELECT ${targetColList} FROM ${qualifiedTarget}`, orderColumns, this.BATCH_SIZE,
    )) {
      for (const row of rows) {
        const key = keyColumns.map((c) => String(row[c])).join('|');
        targetMap.set(key, row);
      }
    }

    const rows: RowDiff[] = [];

    for (const [key, srcRow] of sourceMap) {
      const tgtRow = targetMap.get(key);
      if (!tgtRow) {
        rows.push({ status: 'added', pkValues: extractPk(keyColumns, srcRow), sourceRow: srcRow });
      } else if (!this.rowsEqual(srcRow, tgtRow, columnNames)) {
        rows.push({ status: 'changed', pkValues: extractPk(keyColumns, srcRow), sourceRow: srcRow, targetRow: tgtRow });
      }
    }

    for (const [key, tgtRow] of targetMap) {
      if (!sourceMap.has(key)) {
        rows.push({ status: 'removed', pkValues: extractPk(keyColumns, tgtRow), targetRow: tgtRow });
      }
    }

    return { tableName: table, pkColumns: keyColumns, columnNames, rows };
  }

  private static rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>, cols: string[]): boolean {
    for (const c of cols) {
      if (!DataDiffService.valuesEqual(a[c], b[c])) return false;
    }
    return true;
  }

  /**
   * 跨方言值比较。
   *
   * 直接 `String(a) !== String(b)` 会把同值判成不同：MySQL 可能给 `'1'`、PG 给 `1`；
   * 日期在两端的文本形态不同（`2024-01-01T00:00:00.000Z` vs `2024-01-01 00:00:00`）。
   * 这里按语义归一：null/undefined 等价；Date 比时间戳；Buffer 比字节；数值与数值型
   * 字符串按数值比；其余退回字符串比较。
   */
  private static valuesEqual(va: unknown, vb: unknown): boolean {
    if (va === vb) return true;
    const a = va === undefined ? null : va;
    const b = vb === undefined ? null : vb;
    if (a === null || b === null) return a === b;
    if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) {
      return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
    }
    // 日期形态归一：Date 对象与 'YYYY-MM-DD[ T]HH:mm:ss[.sss][Z]' 文本统一成同一
    // 规范形式，避免 ISO（2024-01-01T00:00:00.000Z）与数据库文本（2024-01-01 00:00:00）
    // 被误判为差异。必须先于「Date vs 数字时间戳」分支：否则与字符串比较时
    // Number('2024-01-01 00:00:00') 为 NaN 直接判不等。
    const da = DataDiffService.canonicalDate(a);
    const db = DataDiffService.canonicalDate(b);
    if (da !== null && db !== null) return da === db;
    if (a instanceof Date || b instanceof Date) {
      const ta = a instanceof Date ? a.getTime() : Number(a);
      const tb = b instanceof Date ? b.getTime() : Number(b);
      return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
    }
    const sa = String(a);
    const sb = String(b);
    if (sa === sb) return true;
    // 数值型字符串等价（'1' vs 1、'1.0' vs 1）。
    if (sa.trim() !== '' && sb.trim() !== '') {
      const na = Number(sa);
      const nb = Number(sb);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    }
    return false;
  }

  /** 把 Date 或常见日期时间文本规整为 `YYYY-MM-DD HH:mm:ss`；无法识别返回 null。 */
  private static canonicalDate(v: unknown): string | null {
    const text = v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v : null);
    if (text === null) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?Z?$/.exec(text.trim());
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]} ${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}`;
  }

  static generateSyncSql(diffs: DataDiffResult, targetDb: string, targetQuery: QueryService): string {
    const parts: string[] = [];
    parts.push(`-- Data sync: ${diffs.sourceDb} → ${diffs.targetDb}`);
    parts.push('');

    for (const td of diffs.diffs) {
      if (!td.rows.length) continue;
      const wrap = (id: string) => targetQuery.dialect.wrap(id);
      // 值/标识符转义必须走**目标**方言：同步产物写进目标库，字符串字面量与
      // 标识符引用规则以目标为准。此处曾用源方言（MySQL→PG 时往 PG 发反引号
      // + 反斜杠倍增，目标库拒绝或数据损坏）。
      const esc = (v: unknown) => targetQuery.dialect.escapeValue(v);
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

