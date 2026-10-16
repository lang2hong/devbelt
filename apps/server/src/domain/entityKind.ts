/**
 * 同步 record 的明文类型白名单（P6）。
 *
 * 服务端不接受客户端任取 `entityKind`（否则可用任意 kind 规避按类型配额 / 污染统计）。
 * 取值与 db-host `SYNC_ENTITY_TYPES` 一致；两侧**各自维护**以避免 server → db-host 依赖，
 * 新增类型需两边同步（有「未知 kind 拒绝」测试兜底）。
 */
export const ENTITY_KINDS = [
  'connection', 'group', 'queryFolder', 'query',
  'authenticatorEntry', 'authenticatorGroup', 'authenticatorTag',
  // S7f：AI 表/列注记（每连接+库一条）。
  'schemaNotes',
  // AI 模型接入配置（厂商/baseUrl/模型/自定义厂商，端到端加密；每用户一条）。
  'aiModelAccess',
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

const KNOWN: ReadonlySet<string> = new Set(ENTITY_KINDS);

export function isEntityKind(v: unknown): v is EntityKind {
  return typeof v === 'string' && KNOWN.has(v);
}
