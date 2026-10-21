/**
 * schemaNotes 同步实体（S7f）：每个「连接 + 库」一条注记集合记录。
 *
 * 与验证器实体同模式：db-host 定义类型/校验，宿主（vscode-ext）注入 `EntityBackend`
 * 实现（`SchemaNotesSyncBackend`，底层为 AiContextStore 的本地记录存储）。
 *
 * - `connId` 在 payload 中是 **sync recordId**，在本地值中是 **localId**；
 *   apply 时经 RecordMapStore 解析（未到达 → unresolved `connId`，后续轮收敛）。
 * - `scope`：库名（SQLite 为 ''）。
 * - `tables`：`{ [表]: { note?, columns?: { [列]: { note?, sample? } } } }`，与 ext
 *   `SchemaNotes` 同构（长度/条目上限由本地存储层归一化，此处只做体积 fail-closed）。
 * - `updateTime`：本地同步修订（写入时由存储层打点，与连接实体同口径）。
 */
export const SCHEMA_NOTES_MAX_BYTES = 128 * 1024;
export const BUSINESS_RULES_MAX_CHARS = 2000;
export const BUSINESS_RULES_MAX_BYTES = 8 * 1024;

/** 连接级 AI 业务规则（复用 schemaNotes 实体，scope 为保留值）。 */
export interface SyncBusinessRules {
  domainContext: string;
  defaultDirectives: string;
}

export interface SyncSchemaNotesValue {
  id: string;
  /** 所属连接：payload 内为 recordId；本地值为 localId。 */
  connId: string;
  scope: string;
  tables: Record<string, unknown>;
  /** 可选：业务规则复用同一实体；旧客户端忽略该字段。 */
  businessRules?: SyncBusinessRules;
  updateTime: number;
  deleted?: boolean;
}

export function assertBusinessRules(raw: unknown): SyncBusinessRules {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('businessRules must be an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.domainContext !== 'string' || typeof o.defaultDirectives !== 'string') {
    throw new Error('businessRules fields must be strings');
  }
  if (o.domainContext.length > BUSINESS_RULES_MAX_CHARS || o.defaultDirectives.length > BUSINESS_RULES_MAX_CHARS) {
    throw new Error(`businessRules fields must be <= ${BUSINESS_RULES_MAX_CHARS} chars`);
  }
  const bytes = Buffer.byteLength(o.domainContext, 'utf8') + Buffer.byteLength(o.defaultDirectives, 'utf8');
  if (bytes > BUSINESS_RULES_MAX_BYTES) throw new Error('businessRules exceeds 8 KiB limit');
  return { domainContext: o.domainContext, defaultDirectives: o.defaultDirectives };
}

export function assertSchemaNotesTables(tables: unknown): Record<string, unknown> {
  if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) {
    throw new Error('schemaNotes.tables must be an object');
  }
  const json = JSON.stringify(tables);
  if (Buffer.byteLength(json, 'utf8') > SCHEMA_NOTES_MAX_BYTES) {
    throw new Error('schemaNotes.tables exceeds 128 KiB limit');
  }
  return tables as Record<string, unknown>;
}

export function assertSchemaNotesScope(scope: unknown): string {
  if (typeof scope !== 'string' || scope.length > 128) {
    throw new Error('schemaNotes.scope must be a string (<=128 chars)');
  }
  return scope;
}