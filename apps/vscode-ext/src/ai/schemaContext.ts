import {
  serializeSchema,
  type AiSchemaColumn,
  type AiSchemaInput,
  type AiSchemaTable,
  type SerializedSchema,
} from '@devbelt/ai-core';
import type { ColumnMeta, TableMeta } from '@devbelt/db-core';
import type { SqlConnectionSession } from '../connection/connectionSession.js';

/**
 * 扩展侧 schema 上下文（P9 S4 升级，替换 S3 的基础版）：
 *
 * - 200 表/3-4K 预算；元数据抓取 60s 缓存（按 connId+database+schema，不含
 *   includeComments/userText——序列化可多次、抓取只一次）；
 * - **MySQL 批量列查询**：单条 `information_schema.COLUMNS`（覆盖整库列+注释+
 *   ENUM 值），大库首次 <1s、缓存命中即时；PG/SQLite 回退逐表 `getColumns`
 *   （只对选中的表取列）；
 * - **大库启发式预筛（D22）**：>200 表时，@ 引用表优先置顶 → 关键词（表名/列名/
 *   注释匹配，中文 2-4 字滑窗 + 英文分词）命中表 → 其余按原序补足；
 * - 失败/会话不可用 → 返回 null（聊天降级为无 schema，不阻塞）。
 */
const CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_TABLES = 200;
const MAX_COLUMNS_PER_TABLE = 50;
const MAX_KEYWORD_TOKENS = 200;

export interface AiSchemaSnapshot extends SerializedSchema {
  connId: string;
  database?: string;
  schema?: string;
  /** S7a：有表因元数据失败被跳过（部分加载，不再整包失败）。 */
  partial?: boolean;
}

export interface BuildSchemaOptions {
  connId: string;
  /** 引擎类型（mysql/postgresql/sqlite），决定批量列查询路径。 */
  dbType: string;
  includeComments: boolean;
  database?: string;
  schema?: string;
  /** 用户显式 @ 引用的表（置顶、截断时最后裁）。 */
  referencedTables?: string[];
  /** 用户自然语言文本（大库关键词预筛素材）。 */
  userText?: string;
  maxTables?: number;
}

interface CachedMetadata {
  at: number;
  tables: TableMeta[];
  /** 已抓取的列（MySQL 批量；其余引擎在序列化时按选中表懒取）。 */
  columnMap: Map<string, ColumnMeta[]>;
  fkMap: Map<string, string>;
}

export class AiSchemaContextBuilder {
  private readonly cache = new Map<string, CachedMetadata>();

  async build(session: SqlConnectionSession, opts: BuildSchemaOptions): Promise<AiSchemaSnapshot | null> {
    const maxTables = opts.maxTables ?? DEFAULT_MAX_TABLES;
    // MySQL 无库时 `information_schema.tables` 无过滤会横跨所有可见库（探针实测 4 库 75 表）：
    // 宁可无上下文，不给跨库错上下文（正确解法由作用域选择器保证 database 总存在）。
    if (opts.dbType.toLowerCase() === 'mysql' && !opts.database) return null;
    try {
      const metadata = await this.loadMetadata(session, opts);
      const selected = selectTables(metadata.tables, metadata.columnMap, {
        referencedTables: opts.referencedTables,
        userText: opts.userText,
        maxTables,
      });
      const { tables, partial } = await this.toSchemaTables(session, metadata, selected, opts);

      const input: AiSchemaInput = {
        dbType: opts.dbType,
        ...(opts.database ? { database: opts.database } : {}),
        ...(opts.schema ? { schema: opts.schema } : {}),
        tables,
      };
      const serialized = serializeSchema(input, {
        maxTables,
        maxColumnsPerTable: MAX_COLUMNS_PER_TABLE,
        includeComments: opts.includeComments,
      });
      return {
        ...serialized,
        // serializer 的统计基于传入子集；对外反映真实总量与截断状态。
        totalTables: metadata.tables.length,
        truncated: metadata.tables.length > tables.length,
        connId: opts.connId,
        ...(opts.database ? { database: opts.database } : {}),
        ...(opts.schema ? { schema: opts.schema } : {}),
        ...(partial ? { partial: true } : {}),
      };
    } catch {
      return null;
    }
  }

  /** 主动失效（上下文切换/连接关闭时调用；TTL 之外的可控刷新点）。 */
  invalidate(connId?: string): void {
    if (!connId) {
      this.cache.clear();
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${connId}|`)) this.cache.delete(key);
    }
  }

  private async loadMetadata(session: SqlConnectionSession, opts: BuildSchemaOptions): Promise<CachedMetadata> {
    const cacheKey = `${opts.connId}|${opts.database ?? ''}|${opts.schema ?? ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;

    const [tables, fkMap, columnMap] = await Promise.all([
      session.metadata.getTables(opts.database, opts.schema),
      loadForeignKeys(session, opts),
      loadBatchColumns(session, opts),
    ]);
    const metadata: CachedMetadata = { at: Date.now(), tables, columnMap, fkMap };
    this.cache.set(cacheKey, metadata);
    return metadata;
  }

  private async toSchemaTables(
    session: SqlConnectionSession,
    metadata: CachedMetadata,
    selected: TableMeta[],
    opts: BuildSchemaOptions,
  ): Promise<{ tables: AiSchemaTable[]; partial: boolean }> {
    const out: AiSchemaTable[] = [];
    let partial = false;
    for (const table of selected) {
      let columns = metadata.columnMap.get(table.name);
      if (!columns) {
        // 非 MySQL（或批量查询失败）回退：只对选中的表逐表取列（已受 maxTables 约束）。
        // S7a：单表失败跳过并标记 partial——过去一张表失败让整个上下文归零（"Schema unavailable"）。
        try {
          columns = await session.metadata.getColumns(table.name, opts.database, opts.schema);
        } catch {
          partial = true;
          continue;
        }
      }
      out.push({
        name: table.name,
        columns: columns.map((column) => toAiColumn(column, metadata.fkMap.get(`${table.name}.${column.name}`))),
      });
    }
    return { tables: out, partial };
  }
}

async function loadForeignKeys(session: SqlConnectionSession, opts: BuildSchemaOptions): Promise<Map<string, string>> {
  const fkMap = new Map<string, string>();
  const fks = await session.metadata.getForeignKeys(opts.database, opts.schema).catch(() => []);
  for (const fk of fks) {
    const ref = fk.refSchema
      ? `${fk.refSchema}.${fk.refTable}.${fk.refColumn}`
      : `${fk.refTable}.${fk.refColumn}`;
    fkMap.set(`${fk.tableName}.${fk.columnName}`, ref);
  }
  return fkMap;
}

/** MySQL 批量列：单条 information_schema.COLUMNS；非 MySQL 引擎返回空表。 */
async function loadBatchColumns(
  session: SqlConnectionSession,
  opts: BuildSchemaOptions,
): Promise<Map<string, ColumnMeta[]>> {
  const map = new Map<string, ColumnMeta[]>();
  // 大小写归一：调用方沿传 `'MYSQL'`（DatabaseType 枚举值），历史判断写死 `'mysql'`
  // 导致批量路径从未生效、全部回退逐表（无默认库时逐表必炸）。统一小写比较。
  if (opts.dbType.toLowerCase() !== 'mysql') return map;
  try {
    const result = await session.query.query(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, COLUMN_COMMENT
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [opts.database ?? null],
    );
    for (const row of (result?.rows ?? []) as Array<Record<string, unknown>>) {
      const table = str(row.TABLE_NAME ?? row.table_name);
      const name = str(row.COLUMN_NAME ?? row.column_name);
      if (!table || !name) continue;
      const column: ColumnMeta = {
        name,
        simpleType: str(row.COLUMN_TYPE ?? row.column_type),
        type: str(row.COLUMN_TYPE ?? row.column_type),
        comment: str(row.COLUMN_COMMENT ?? row.column_comment),
        key: str(row.COLUMN_KEY ?? row.column_key),
        nullable: str(row.IS_NULLABLE ?? row.is_nullable),
        maxLength: '',
        defaultValue: (row.COLUMN_DEFAULT ?? row.column_default) as unknown,
        extra: undefined,
        isNotNull: str(row.IS_NULLABLE ?? row.is_nullable).toUpperCase() === 'NO',
        isAutoIncrement: false,
        isUnique: str(row.COLUMN_KEY ?? row.column_key).toUpperCase() === 'UNI',
        isPrimary: str(row.COLUMN_KEY ?? row.column_key).toUpperCase() === 'PRI',
        pk: '',
      };
      const list = map.get(table);
      if (list) list.push(column);
      else map.set(table, [column]);
    }
  } catch {
    return new Map(); // 回退逐表路径
  }
  return map;
}

interface SelectOptions {
  referencedTables?: string[];
  userText?: string;
  maxTables: number;
}

/** 选表：@ 引用置顶 → 关键词命中（表名/列名/注释）→ 原序补足（≤maxTables）。 */
function selectTables(
  tables: TableMeta[],
  columnMap: Map<string, ColumnMeta[]>,
  options: SelectOptions,
): TableMeta[] {
  if (tables.length <= options.maxTables) return tables;

  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const chosen: TableMeta[] = [];
  const seen = new Set<string>();

  const take = (table: TableMeta | undefined): void => {
    if (!table || seen.has(table.name)) return;
    seen.add(table.name);
    chosen.push(table);
  };

  for (const ref of options.referencedTables ?? []) {
    take(byName.get(ref.toLowerCase()) ?? byName.get(ref.split('.').pop()!.toLowerCase()));
  }

  const tokens = tokenize(options.userText ?? '');
  if (tokens.length > 0) {
    const scored = tables
      .map((table) => ({ table, score: scoreTable(table, columnMap.get(table.name), tokens) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const entry of scored) take(entry.table);
  }

  for (const table of tables) take(table);
  return chosen.slice(0, options.maxTables);
}

function scoreTable(table: TableMeta, columns: ColumnMeta[] | undefined, tokens: string[]): number {
  const name = table.name.toLowerCase();
  const comment = (table.comment ?? '').toLowerCase();
  const columnNames = (columns ?? []).map((c) => c.name.toLowerCase());
  const columnComments = (columns ?? []).map((c) => (c.comment ?? '').toLowerCase());
  let score = 0;
  for (const token of tokens) {
    if (name === token || name.includes(token)) score += 2;
    else if (comment.includes(token)) score += 1;
    if (columnNames.some((n) => n === token || n.includes(token))) score += 2;
    else if (columnComments.some((c) => c.includes(token))) score += 1;
  }
  return score;
}

/** 关键词分词：英文（≥3 字符）+ 中文 2-4 字滑窗；去重、上限 200。 */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9_]{3,}/g)) {
    tokens.add(match[0]);
    if (tokens.size >= MAX_KEYWORD_TOKENS) return [...tokens];
  }
  for (const run of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const chars = run[0];
    for (let size = 4; size >= 2; size -= 1) {
      for (let i = 0; i + size <= chars.length; i += 1) {
        tokens.add(chars.slice(i, i + size));
        if (tokens.size >= MAX_KEYWORD_TOKENS) return [...tokens];
      }
    }
  }
  return [...tokens];
}

function toAiColumn(column: ColumnMeta, references?: string): AiSchemaColumn {
  const result: AiSchemaColumn = {
    name: column.name,
    type: column.type,
    ...(column.isNotNull !== undefined ? { nullable: !column.isNotNull } : {}),
    ...(column.isPrimary ? { primaryKey: true } : column.isUnique ? { unique: true } : {}),
    ...(column.comment ? { comment: column.comment } : {}),
    ...(references ? { references } : {}),
  };
  if (column.defaultValue !== undefined && column.defaultValue !== null) {
    result.defaultValue = String(column.defaultValue);
  }
  return result;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}