import type { QueryService } from './queryService.js';
import type { MetadataService } from './metadataService.js';
import { streamRowsByKeyset } from './paging.js';
import { qualifyTable } from '../utils/qualify.js';

/**
 * 数值主键类型白名单（词边界匹配）。不能用 `/int/` 这种子串正则：`interval`/`point`
 * 会被误判为数值型，从而走上 JS 有序归并（其 ORDER BY 语义与 JS 比较不一致）。
 */
const NUMERIC_PK_RE = /\b(?:tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|serial|bigserial|smallserial|decimal|numeric|dec|real|double|float4|float8|float)\b/i;

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
    opts: { sourceSchema?: string; targetSchema?: string } = {},
  ): Promise<DataDiffResult> {
    const { sourceSchema, targetSchema } = opts;
    const tableList = tables ?? (await sourceMeta.getTables(sourceDb, sourceSchema)).map((t) => t.name);
    const diffs: TableDataDiff[] = [];

    for (const table of tableList) {
      // 排序/游标列必须是真实主键（NOT NULL 且唯一）；无主键时留空 → OFFSET 分页（完整）。
      // 行匹配键列则回退全列（无主键表的身份），但绝不拿它当 keyset 游标（可空列会静默丢行）。
      const orderColumns = await this.getPkColumns(sourceMeta, table, sourceDb, sourceSchema);
      const keyColumns = orderColumns.length ? orderColumns : await this.getKeyColumns(sourceMeta, table, sourceDb, sourceSchema);
      const columnNames = await this.getColumnNames(sourceMeta, table, sourceDb, sourceSchema);
      if (!keyColumns.length) continue;
      // 仅当主键列是数值型且两侧同方言时才做有序归并：文本主键的 ORDER BY 受 collation
      // 影响，JS 比较未必与 DB 一致，归并会错位。
      const mergeSafe = orderColumns.length > 0
        && sourceQuery.dialect.dbType === targetQuery.dialect.dbType
        && await this.pkColumnsNumeric(sourceMeta, table, orderColumns, sourceDb, sourceSchema);

      const diff = await this.diffTable(
        sourceQuery, table, sourceDb, orderColumns, keyColumns, columnNames,
        targetQuery, targetDb, mergeSafe, sourceSchema, targetSchema,
      );
      diffs.push(diff);
    }

    return { diffs, sourceDb, targetDb };
  }

  /** 真实主键列（仅 isPrimary）；无则空数组。 */
  private static async getPkColumns(meta: MetadataService, table: string, db?: string, schema?: string): Promise<string[]> {
    try {
      const cols = await meta.getColumns(table, db, schema);
      return cols.filter((c) => c.isPrimary).map((c) => c.name);
    } catch {
      return [];
    }
  }

  /** 主键列是否全为数值型（决定能否安全做 JS 有序归并）。 */
  private static async pkColumnsNumeric(meta: MetadataService, table: string, pkColumns: string[], db?: string, schema?: string): Promise<boolean> {
    try {
      const cols = await meta.getColumns(table, db, schema);
      return pkColumns.every((name) => {
        const col = cols.find((c) => c.name === name);
        return !!col && NUMERIC_PK_RE.test(String(col.simpleType || col.type));
      });
    } catch {
      return false;
    }
  }

  /** 行匹配键列：优先主键，无主键时回退全列（仅供建映射，不作游标）。 */
  private static async getKeyColumns(meta: MetadataService, table: string, db?: string, schema?: string): Promise<string[]> {
    try {
      const cols = await meta.getColumns(table, db, schema);
      return cols.map((c) => c.name);
    } catch {
      return [];
    }
  }

  private static async getColumnNames(meta: MetadataService, table: string, db?: string, schema?: string): Promise<string[]> {
    try {
      const cols = await meta.getColumns(table, db, schema);
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
    mergeSafe = false,
    sourceSchema?: string,
    targetSchema?: string,
  ): Promise<TableDataDiff> {
    // 无键列会退化成 `ORDER BY `（语法错误）且所有行 key 都是空串而互相覆盖，
    // 必须显式拒绝，而不是生成无效 SQL。
    if (keyColumns.length === 0) {
      throw new Error(`data diff requires at least one key column for table ${table}`);
    }
    const wrap = (id: string) => sourceQuery.dialect.wrap(id);
    const targetWrap = (id: string) => targetQuery.dialect.wrap(id);
    const qualifiedSource = qualifyTable(
      sourceQuery.dialect.dbType, wrap(table),
      sourceDb ? wrap(sourceDb) : undefined,
      sourceSchema ? wrap(sourceSchema) : undefined,
    );
    const qualifiedTarget = qualifyTable(
      targetQuery.dialect.dbType, targetWrap(table),
      targetDb ? targetWrap(targetDb) : undefined,
      targetSchema ? targetWrap(targetSchema) : undefined,
    );

    const colList = columnNames.map((c) => wrap(c)).join(', ');
    const targetColList = columnNames.map((c) => targetWrap(c)).join(', ');

    if (mergeSafe) {
      return this.mergeDiff(
        sourceQuery, `SELECT ${colList} FROM ${qualifiedSource}`, orderColumns, keyColumns, columnNames,
        targetQuery, `SELECT ${targetColList} FROM ${qualifiedTarget}`, table,
      );
    }

    // 文本主键或跨方言：只把目标端全量放进内存（按键随机比对与识别 removed）；源端直接
    // 流式比对，命中即从 targetMap 删除，剩下的就是 removed（内存约为原来的 1/2）。
    const targetMap = new Map<string, Record<string, unknown>>();

    for await (const page of streamRowsByKeyset(
      targetQuery, targetQuery.dialect, `SELECT ${targetColList} FROM ${qualifiedTarget}`, orderColumns, this.BATCH_SIZE,
    )) {
      for (const row of page) {
        const key = keyColumns.map((c) => String(row[c])).join('|');
        targetMap.set(key, row);
      }
    }

    const rows: RowDiff[] = [];

    for await (const page of streamRowsByKeyset(
      sourceQuery, sourceQuery.dialect, `SELECT ${colList} FROM ${qualifiedSource}`, orderColumns, this.BATCH_SIZE,
    )) {
      for (const srcRow of page) {
        const key = keyColumns.map((c) => String(srcRow[c])).join('|');
        const tgtRow = targetMap.get(key);
        if (!tgtRow) {
          rows.push({ status: 'added', pkValues: extractPk(keyColumns, srcRow), sourceRow: srcRow });
        } else {
          targetMap.delete(key);
          if (!this.rowsEqual(srcRow, tgtRow, columnNames)) {
            rows.push({ status: 'changed', pkValues: extractPk(keyColumns, srcRow), sourceRow: srcRow, targetRow: tgtRow });
          }
        }
      }
    }

    for (const tgtRow of targetMap.values()) {
      rows.push({ status: 'removed', pkValues: extractPk(keyColumns, tgtRow), targetRow: tgtRow });
    }

    return { tableName: table, pkColumns: keyColumns, columnNames, rows };
  }

  /**
   * 有序归并比较两路已 ORDER BY 主键的流（仅数值主键、同方言时使用）。
   *
   * 内存只与结果行数相关，不再驻留整表：两侧各缓冲一页，按主键推进。
   */
  private static async mergeDiff(
    sourceQuery: QueryService, sourceSelect: string,
    orderColumns: string[], keyColumns: string[], columnNames: string[],
    targetQuery: QueryService, targetSelect: string,
    table: string,
  ): Promise<TableDataDiff> {
    const src = DataDiffService.mergeReader(sourceQuery, sourceSelect, orderColumns);
    const tgt = DataDiffService.mergeReader(targetQuery, targetSelect, orderColumns);
    const rows: RowDiff[] = [];
    let a = await src.next();
    let b = await tgt.next();
    while (a && b) {
      const c = DataDiffService.compareKeyRows(a, b, orderColumns);
      if (c === 0) {
        if (!DataDiffService.rowsEqual(a, b, columnNames)) {
          rows.push({ status: 'changed', pkValues: extractPk(keyColumns, a), sourceRow: a, targetRow: b });
        }
        a = await src.next();
        b = await tgt.next();
      } else if (c < 0) {
        rows.push({ status: 'added', pkValues: extractPk(keyColumns, a), sourceRow: a });
        a = await src.next();
      } else {
        rows.push({ status: 'removed', pkValues: extractPk(keyColumns, b), targetRow: b });
        b = await tgt.next();
      }
    }
    while (a) { rows.push({ status: 'added', pkValues: extractPk(keyColumns, a), sourceRow: a }); a = await src.next(); }
    while (b) { rows.push({ status: 'removed', pkValues: extractPk(keyColumns, b), targetRow: b }); b = await tgt.next(); }
    return { tableName: table, pkColumns: keyColumns, columnNames, rows };
  }

  /** 把分页异步流包装成「逐行 next」，供归并使用。 */
  private static mergeReader(q: QueryService, sql: string, orderColumns: string[]): { next(): Promise<Record<string, unknown> | undefined> } {
    const it = streamRowsByKeyset(q, q.dialect, sql, orderColumns, DataDiffService.BATCH_SIZE)[Symbol.asyncIterator]();
    let page: Record<string, unknown>[] = [];
    let idx = 0;
    return {
      async next(): Promise<Record<string, unknown> | undefined> {
        for (;;) {
          if (idx < page.length) return page[idx++];
          const n = await it.next();
          if (n.done) return undefined;
          page = n.value;
          idx = 0;
        }
      },
    };
  }

  /** 按主键列比较两行（精确数值优先，其余按字符串）。 */
  private static compareKeyRows(a: Record<string, unknown>, b: Record<string, unknown>, cols: string[]): number {
    for (const col of cols) {
      const va = a[col];
      const vb = b[col];
      const cmp = compareNumericStrings(va, vb);
      if (cmp !== null) {
        if (cmp !== 0) return cmp;
        continue;
      }
      const sa = String(va);
      const sb = String(vb);
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
    return 0;
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
    // 数值型字符串等价（'1' vs 1、'1.0' vs 1）。必须精确比较：Number() 会把
    // 超过 2^53 的 BIGINT/DECIMAL 字符串折叠，导致真实差异被判为相等。
    const cmp = compareNumericStrings(sa, sb);
    if (cmp !== null) return cmp === 0;
    return false;
  }

  /** 把 Date 或常见日期时间文本规整为 UTC ISO（含毫秒）；无法识别返回 null。 */
  private static canonicalDate(v: unknown): string | null {
    const text = v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v.trim() : null);
    if (text === null) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
    if (!m) return null;
    let offsetMinutes = 0;
    if (m[8] && m[8] !== 'Z') {
      const sign = m[8][0] === '-' ? -1 : 1;
      const parts = /(\d{2}):?(\d{2})/.exec(m[8]);
      offsetMinutes = parts ? sign * (Number(parts[1]) * 60 + Number(parts[2])) : 0;
    }
    const ms = Date.UTC(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0),
      Number((m[7] ?? '0').padEnd(3, '0')),
    );
    if (!Number.isFinite(ms)) return null;
    // 带时区偏移的输入换算到 UTC 后统一比较；Date.UTC 以毫秒精度保留小数秒。
    return new Date(ms - offsetMinutes * 60000).toISOString();
  }

  static generateSyncSql(diffs: DataDiffResult, targetDb: string, targetQuery: QueryService, targetSchema?: string): string {
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
      // PG：显式 targetSchema 时限定到目标 schema（同连接跨 schema 同步）；否则交 search_path。
      const qualifiedTarget = qualifyTable(
        targetQuery.dialect.dbType, wrap(td.tableName),
        targetDb ? wrap(targetDb) : undefined,
        targetSchema ? wrap(targetSchema) : undefined,
      );
      const colList = td.columnNames.map(wrap).join(', ');

      const added = td.rows.filter((r) => r.status === 'added');
      const changed = td.rows.filter((r) => r.status === 'changed');
      const removed = td.rows.filter((r) => r.status === 'removed');

      // 无主键表的 keyColumns 回退为全列，其中可能有 NULL；`col = NULL` 永不匹配，
      // 必须写 `IS NULL`，否则生成的 DELETE/UPDATE 影响 0 行且无告警。
      const keyWhere = (pkValues: Record<string, unknown>): string =>
        td.pkColumns
          .map((c) => {
            const v = pkValues[c];
            return v === null || v === undefined ? `${wrap(c)} IS NULL` : `${wrap(c)} = ${esc(v)}`;
          })
          .join(' AND ');

      if (removed.length) {
        parts.push(`-- ${td.tableName}: ${removed.length} row(s) to delete`);
        for (const r of removed) {
          const where = keyWhere(r.pkValues);
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
          const where = keyWhere(r.pkValues);
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

/**
 * 精确解析数值字面量为 `mantissa * 10^exponent`（mantissa 为 bigint）。
 *
 * `Number()` 对 BIGINT/DECIMAL 字符串会丢精度（`'9007199254740993'` 与 `'...992'`
 * 折叠为同一 double），驱动默认就把大整数以字符串返回，因此比较必须走 BigInt。
 * 非数值字面量返回 null，由调用方回退字符串比较。
 */
function parseNumericLiteral(value: unknown): { mantissa: bigint; exponent: number } | null {
  const text = typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : null)
    : (typeof value === 'string' ? value.trim() : null);
  if (text === null || text === '') return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) return null;
  const intPart = m[2] ?? '';
  const fracPart = m[3] ?? '';
  if (intPart === '' && fracPart === '') return null;
  const exp = m[4] ? Number(m[4]) : 0;
  if (!Number.isFinite(exp) || Math.abs(exp) > 10000) return null;
  let mantissa = BigInt((intPart + fracPart) || '0');
  if (m[1] === '-') mantissa = -mantissa;
  let exponent = exp - fracPart.length;
  // 去掉尾随零，使 `'1.0'`/`'1.00'`/`'1'` 归一为同一表示（指数已 10000 上限保护）。
  while (mantissa !== 0n && mantissa % 10n === 0n) {
    mantissa /= 10n;
    exponent += 1;
  }
  return { mantissa, exponent };
}

/** 精确比较两个数值字面量；任一非数值返回 null。 */
function compareNumericStrings(a: unknown, b: unknown): number | null {
  const x = parseNumericLiteral(a);
  const y = parseNumericLiteral(b);
  if (!x || !y) return null;
  const minExp = Math.min(x.exponent, y.exponent);
  const shiftX = x.exponent - minExp;
  const shiftY = y.exponent - minExp;
  // 指数差过大时不做 10^n 放大，避免构造超大 bigint；退回字符串比较。
  if (shiftX > 1000 || shiftY > 1000) return null;
  const mx = x.mantissa * 10n ** BigInt(shiftX);
  const my = y.mantissa * 10n ** BigInt(shiftY);
  return mx < my ? -1 : mx > my ? 1 : 0;
}

function extractPk(pkColumns: string[], row: Record<string, unknown>): Record<string, unknown> {
  const pk: Record<string, unknown> = {};
  for (const c of pkColumns) pk[c] = row[c];
  return pk;
}

