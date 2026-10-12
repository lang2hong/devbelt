import {
  buildExplainMessages,
  buildNl2SqlMessages,
  buildOptimizeMessages,
  type ChatMessage,
} from '@devbelt/ai-core';
import { DatabaseType } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { ConnectionManager } from '../connection/connectionManager.js';
import type { ConnectionContext } from '../connection/connectionContext.js';
import { readAiConfig } from './aiService.js';
import { peekSqlForConnection } from './sessionLookup.js';
import type { AiSchemaContextBuilder, AiSchemaSnapshot } from './schemaContext.js';
import type { AiContextStore } from './aiContextStore.js';

/**
 * NL2SQL / Explain / Optimize 的请求组装（P9 S4，§6.7.1 五路信号）。
 *
 * 信号汇总：
 * ① feature（互斥场景 prompt，由各 builder 决定）；
 * ② 连接+库+schema+方言（prompt 声明不得跨库猜测）；
 * ③ 编辑器现场（选区=请求 / 全量 SQL）；
 * ④ `referencedTables[]`（@ 引用，schema 注入优先保留并在 prompt 声明）；
 * ⑤ 域上下文 + 默认业务指令 user-role 区块（**仅 nl2sql 注入**；explain/optimize
 *    按文档不注入）。
 */

/** 编辑器侧上下文快照（schema 可缺省：无连接/未打开会话时降级为空并给 note）。 */
export interface AiEditorContext {
  conn?: SavedConnection;
  database?: string;
  schema?: string;
  dbType?: string;
  schemaText?: string;
  tableCount: number;
  totalTables: number;
  commentCount: number;
  note?: 'no-connection' | 'no-session' | 'schema-failed' | 'disabled';
}

export interface EditorContextDeps {
  connCtx: ConnectionContext;
  manager: ConnectionManager;
  schemaBuilder: AiSchemaContextBuilder;
  contextStore: AiContextStore;
}

/** 从请求文本抽取 @ 引用表名（`@orders` / `@myapp.orders` → `orders`）；去重、≤10。 */
export function extractReferencedTables(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/@([A-Za-z0-9_\u4e00-\u9fff.]+)/g)) {
    const token = match[1].split('.').pop() ?? match[1];
    if (!token || seen.has(token.toLowerCase())) continue;
    seen.add(token.toLowerCase());
    out.push(token);
    if (out.length >= 10) break;
  }
  return out;
}

/** 解析编辑器/工作区当前连接 + schema 上下文（供 Alt+A / 右键命令）。 */
export async function resolveEditorContext(
  deps: EditorContextDeps,
  uri: string | undefined,
): Promise<AiEditorContext> {
  const bound = (uri ? deps.connCtx.getForDoc(uri) : undefined) ?? deps.connCtx.getLast();
  if (!bound) return { tableCount: 0, totalTables: 0, commentCount: 0, note: 'no-connection' };

  const config = readAiConfig();
  const base: AiEditorContext = {
    conn: bound.conn,
    ...(bound.db ? { database: bound.db } : {}),
    ...(bound.conn.dbType === DatabaseType.PG && bound.conn.schema ? { schema: bound.conn.schema } : {}),
    dbType: String(bound.conn.dbType),
    tableCount: 0,
    totalTables: 0,
    commentCount: 0,
  };
  if (config.schemaContextMode === 'off') return { ...base, note: 'disabled' };

  const session = peekSqlForConnection(deps.manager, bound.conn, bound.db);
  if (!session) return { ...base, note: 'no-session' };

  const snapshot: AiSchemaSnapshot | null = await deps.schemaBuilder.build(session, {
    connId: bound.conn.id,
    dbType: String(bound.conn.dbType),
    includeComments: config.includeColumnComments,
    ...(bound.db ? { database: bound.db } : {}),
    ...(base.schema ? { schema: base.schema } : {}),
  });
  if (!snapshot) return { ...base, note: 'schema-failed' };
  return {
    ...base,
    schemaText: snapshot.text,
    tableCount: snapshot.tableCount,
    totalTables: snapshot.totalTables,
    commentCount: snapshot.commentCount,
  };
}

/** "在 Chat 中细化"预填载荷（Alt+A 单发生成后的升级回路）。 */
export interface RefinePayload {
  request: string;
  sql: string;
  paraphrase: string;
  assumptions: string[];
  connId?: string;
  connName?: string;
  database?: string;
}

export interface AssembleNl2SqlInput {
  request: string;
  ctx: AiEditorContext;
  referencedTables: string[];
  contextStore: AiContextStore;
}

/**
 * 按场景把域上下文/默认业务指令作为 user-role 区块插入（**仅 chat/nl2sql/data-qa**；
 * explain/optimize/diagnose/schema-design 不注入——文档明确边界）。
 * 插入位置固定在 system 之后、原始用户内容之前。
 */
export function injectBusinessRules(
  messages: ChatMessage[],
  contextStore: AiContextStore,
  connId: string | undefined,
  feature: string,
): ChatMessage[] {
  if (!connId || !['chat', 'nl2sql', 'data-qa'].includes(feature)) return messages;
  const domain = contextStore.getDomainContext(connId);
  const directives = contextStore.getDefaultDirectives(connId);
  if (!domain && !directives) return messages;
  const parts = ['User-provided business rules (apply only when the referenced tables/columns exist):'];
  if (domain) parts.push(`Terminology: ${domain}`);
  if (directives) parts.push(`Default rules: ${directives}`);
  const block: ChatMessage = { role: 'user', content: parts.join('\n') };
  return [messages[0], block, ...messages.slice(1)];
}

/** NL2SQL 场景消息：注入 schema/库绑定/引用表/域上下文/默认业务指令（全五路信号）。 */
export function assembleNl2SqlMessages(input: AssembleNl2SqlInput): ChatMessage[] {
  const conn = input.ctx.conn;
  const domainContext = conn ? input.contextStore.getDomainContext(conn.id) : '';
  const defaultDirectives = conn ? input.contextStore.getDefaultDirectives(conn.id) : '';
  return buildNl2SqlMessages({
    request: input.request,
    ...(input.ctx.schemaText ? { schemaText: input.ctx.schemaText } : {}),
    ...(input.ctx.dbType ? { dbType: input.ctx.dbType } : {}),
    ...(input.ctx.database ? { database: input.ctx.database } : {}),
    ...(input.ctx.schema ? { schema: input.ctx.schema } : {}),
    ...(input.referencedTables.length > 0 ? { referencedTables: input.referencedTables } : {}),
    ...(domainContext ? { domainContext } : {}),
    ...(defaultDirectives ? { defaultDirectives } : {}),
  });
}

/** Explain 场景消息（不注入域上下文/默认业务指令）。 */
export function assembleExplainMessages(sql: string, ctx: AiEditorContext): ChatMessage[] {
  return buildExplainMessages({
    sql,
    ...(ctx.schemaText ? { schemaText: ctx.schemaText } : {}),
    ...(ctx.dbType ? { dbType: ctx.dbType } : {}),
  });
}

/** Optimize 场景消息（不注入域上下文/默认业务指令；EXPLAIN 可选）。 */
export function assembleOptimizeMessages(
  sql: string,
  explainText: string | undefined,
  ctx: AiEditorContext,
): ChatMessage[] {
  return buildOptimizeMessages({
    sql,
    ...(explainText ? { explainText } : {}),
    ...(ctx.schemaText ? { schemaText: ctx.schemaText } : {}),
    ...(ctx.dbType ? { dbType: ctx.dbType } : {}),
  });
}