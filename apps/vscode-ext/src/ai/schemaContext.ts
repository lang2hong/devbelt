import {
  serializeSchema,
  type AiSchemaColumn,
  type AiSchemaInput,
  type AiSchemaTable,
  type SerializedSchema,
} from '@devbelt/ai-core';
import type { SqlConnectionSession } from '../connection/connectionSession.js';

/**
 * 扩展侧 schema 上下文薄封装（P9 S3）：把 host 元数据（`session.metadata`）转成
 * ai-core `serializeSchema` 输入，并做**S3 基础版**的规模/缓存控制：
 *
 * - 表上限 50、每表列上限 50（大库预筛/200 表批量查询 60s 缓存随 S4，届时替换本上限）；
 * - 60s 内存 TTL（按 connId+database+schema+includeComments 缓存），避免连发消息重复抓元数据；
 * - 抓取失败/会话不可用 → 返回 null（聊天降级为无 schema 上下文，不阻塞对话）；
 * - 不抓索引（每表一次查询，50 张表会翻倍；S4 批量查询覆盖）。
 */
const S3_MAX_TABLES = 50;
const CACHE_TTL_MS = 60_000;

export interface AiSchemaSnapshot extends SerializedSchema {
  connId: string;
  database?: string;
  schema?: string;
}

export interface BuildSchemaOptions {
  connId: string;
  /** 引擎类型（mysql/postgresql/sqlite），用于 schema 头部展示。 */
  dbType: string;
  includeComments: boolean;
  database?: string;
  schema?: string;
}

export class AiSchemaContextBuilder {
  private readonly cache = new Map<string, { at: number; value: AiSchemaSnapshot }>();

  async build(session: SqlConnectionSession, opts: BuildSchemaOptions): Promise<AiSchemaSnapshot | null> {
    const cacheKey = `${opts.connId}|${opts.database ?? ''}|${opts.schema ?? ''}|${opts.includeComments ? 'c' : 'n'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    try {
      const tableMetas = await session.metadata.getTables(opts.database, opts.schema);
      const fks = await session.metadata.getForeignKeys(opts.database, opts.schema).catch(() => []);
      const fkMap = new Map<string, string>();
      for (const fk of fks) {
        const ref = fk.refSchema ? `${fk.refSchema}.${fk.refTable}.${fk.refColumn}` : `${fk.refTable}.${fk.refColumn}`;
        fkMap.set(`${fk.tableName}.${fk.columnName}`, ref);
      }

      const tables: AiSchemaTable[] = [];
      for (const table of tableMetas.slice(0, S3_MAX_TABLES)) {
        const columns = await session.metadata.getColumns(table.name, opts.database, opts.schema);
        tables.push({
          name: table.name,
          columns: columns.map((column) => toAiColumn(column, fkMap.get(`${table.name}.${column.name}`))),
        });
      }

      const input: AiSchemaInput = {
        dbType: opts.dbType,
        ...(opts.database ? { database: opts.database } : {}),
        ...(opts.schema ? { schema: opts.schema } : {}),
        tables,
      };
      const serialized = serializeSchema(input, {
        maxTables: S3_MAX_TABLES,
        maxColumnsPerTable: 50,
        includeComments: opts.includeComments,
      });
      const snapshot: AiSchemaSnapshot = {
        ...serialized,
        // serializer 的 totalTables 基于已抓取子集；UI 需要真实可见表总量时以抓取前长度为准。
        totalTables: tableMetas.length,
        truncated: tableMetas.length > tables.length,
        connId: opts.connId,
        ...(opts.database ? { database: opts.database } : {}),
        ...(opts.schema ? { schema: opts.schema } : {}),
      };
      this.cache.set(cacheKey, { at: Date.now(), value: snapshot });
      return snapshot;
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
}

function toAiColumn(
  column: {
    name: string;
    type: string;
    comment?: string;
    isNotNull?: boolean;
    isPrimary?: boolean;
    isUnique?: boolean;
    defaultValue?: unknown;
  },
  references?: string,
): AiSchemaColumn {
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