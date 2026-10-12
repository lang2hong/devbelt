import {
  estimateTokens,
  serializeSchema,
  type AiSchemaColumn,
  type AiSchemaInput,
  type AiSchemaTable,
} from '@devbelt/ai-core';
import type { ColumnMeta, ForeignKeyMeta } from '@devbelt/db-core';
import { extractFromTable, extractTableAliases } from './sqlCompletionEngine.js';
import type { ConnectionManager } from '../connection/connectionManager.js';

/**
 * Inline 补全的轻量上下文（P9 S5，§6.11.5）：
 *
 * - 文本窗口：光标前 ≤4000 字符 / 后 ≤500 字符（调用方裁剪，本模块只做表引用解析）；
 * - 引用表：复用既有词法器 `extractFromTable` / `extractTableAliases`（不新写 SQL 解析）；
 * - 外键邻接：一跳扩展（上限 6 张表），只注入"当前语句真正用到的表 + 邻居"，
 *   绝不全库 dump；
 * - token 预算 ≤1.5K：超预算按尾部逐表裁剪（引用表在头部优先保留）。
 */
export const INLINE_BEFORE_MAX = 4000;
export const INLINE_AFTER_MAX = 500;
export const INLINE_MAX_TABLES = 6;
export const INLINE_MAX_COLUMNS = 50;
export const INLINE_TOKEN_BUDGET = 1500;

export interface ReferencedTable {
  /** 原文大小写（用于元数据查询：MySQL 大小写敏感场景不能小写化）。 */
  raw: string;
  /** 小写去引号（用于去重/邻接匹配）。 */
  key: string;
}

/** 从光标前文本提取语句引用表（FROM 表 + JOIN/别名值），保序去重、≤8。 */
export function collectReferenceTables(text: string): ReferencedTable[] {
  const out: ReferencedTable[] = [];
  const seen = new Set<string>();
  const push = (name: string | undefined): void => {
    if (!name) return;
    const raw = name.replace(/["`[\]]/g, '').trim();
    const key = raw.toLowerCase();
    if (!raw || seen.has(key)) return;
    seen.add(key);
    out.push({ raw, key });
  };
  push(extractFromTable(text));
  for (const table of extractTableAliases(text).values()) push(table);
  return out.slice(0, 8);
}

/** 一跳外键邻接扩展：保留原文大小写；引用表在前，邻接表补后（≤上限）。 */
export function expandAdjacency(refs: ReferencedTable[], fks: ForeignKeyMeta[]): ReferencedTable[] {
  const out = [...refs];
  const seen = new Set(refs.map((r) => r.key));
  const add = (name: string | undefined): void => {
    if (!name || out.length >= INLINE_MAX_TABLES) return;
    const raw = name.trim();
    const key = raw.toLowerCase();
    if (!raw || seen.has(key)) return;
    seen.add(key);
    out.push({ raw, key });
  };
  for (const ref of refs) {
    for (const fk of fks) {
      if (out.length >= INLINE_MAX_TABLES) break;
      const table = (fk.tableName ?? '').toLowerCase();
      const refTable = (fk.refTable ?? '').toLowerCase();
      if (table === ref.key) add(fk.refTable);
      else if (refTable === ref.key) add(fk.tableName);
    }
  }
  return out;
}

export interface LightSchema {
  text: string;
  tableCount: number;
  estimatedTokens: number;
}

/** 序列化 + 1.5K 预算裁剪（超预算从尾部逐表删，头部引用表优先保留）。 */
export function buildLightSchema(
  tables: AiSchemaTable[],
  opts: { dbType: string; database?: string; schema?: string; includeComments: boolean },
): LightSchema {
  let current = tables.slice(0, INLINE_MAX_TABLES);
  let serialized = serializeInput(current);
  while (serialized.estimatedTokens > INLINE_TOKEN_BUDGET && current.length > 1) {
    current = current.slice(0, current.length - 1);
    serialized = serializeInput(current);
  }
  return { text: serialized.text, tableCount: current.length, estimatedTokens: serialized.estimatedTokens };

  function serializeInput(input: AiSchemaTable[]): { text: string; estimatedTokens: number } {
    const schemaInput: AiSchemaInput = {
      dbType: opts.dbType,
      ...(opts.database ? { database: opts.database } : {}),
      ...(opts.schema ? { schema: opts.schema } : {}),
      tables: input,
    };
    const serialized = serializeSchema(schemaInput, {
      maxTables: INLINE_MAX_TABLES,
      maxColumnsPerTable: INLINE_MAX_COLUMNS,
      includeComments: opts.includeComments,
    });
    return { text: serialized.text, estimatedTokens: serialized.estimatedTokens };
  }
}

export interface LoadLightSchemaArgs {
  manager: ConnectionManager;
  connId: string;
  dbType: string;
  database?: string;
  schema?: string;
  refs: ReferencedTable[];
  includeComments: boolean;
}

/**
 * 从已打开会话装载轻量 schema（**无打开会话 / 元数据失败 → null**，不隐式建连、不阻塞补全）。
 * 邻接表来自一次 `getForeignKeys`；列元数据只查入选的表（≤6）。
 */
export async function loadLightSchema(args: LoadLightSchemaArgs): Promise<LightSchema | null> {
  if (args.refs.length === 0) return null;
  const session = args.manager.peekSql(args.connId, args.database);
  if (!session) return null;
  try {
    const fks = await session.metadata.getForeignKeys(args.database, args.schema).catch(() => []);
    const expanded = expandAdjacency(args.refs, fks);
    const tables: AiSchemaTable[] = [];
    for (const ref of expanded) {
      const columns = await session.metadata.getColumns(ref.raw, args.database, args.schema);
      // 空列（表不存在/无权限/元数据不可用）不产生"只有表头"的无用上下文。
      if (columns.length === 0) continue;
      tables.push({ name: ref.raw, columns: columns.map(toAiColumn) });
    }
    if (tables.length === 0) return null;
    const light = buildLightSchema(tables, {
      dbType: args.dbType,
      ...(args.database ? { database: args.database } : {}),
      ...(args.schema ? { schema: args.schema } : {}),
      includeComments: args.includeComments,
    });
    return light;
  } catch {
    return null;
  }
}

/** token 预估出口（测试/预算断言用）。 */
export function estimateSchemaTokens(text: string): number {
  return estimateTokens(text);
}

function toAiColumn(column: ColumnMeta): AiSchemaColumn {
  return {
    name: column.name,
    type: column.type,
    ...(column.isNotNull !== undefined ? { nullable: !column.isNotNull } : {}),
    ...(column.isPrimary ? { primaryKey: true } : {}),
    ...(column.comment ? { comment: column.comment } : {}),
  };
}