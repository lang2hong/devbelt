import { DatabaseType } from '@devbelt/db-core';

/** 回复发起时的执行上下文（连接 + 库/scope）。 */
export interface ReplyBinding {
  connId?: string;
  scope?: string;
}

/** 自动执行仅限关系引擎（与 CodeBlock 运行按钮的引擎匹配口径一致）。 */
const AUTORUN_DB_TYPES = new Set<string>([DatabaseType.MYSQL, DatabaseType.PG, DatabaseType.SQLITE]);

/**
 * 回复级自动执行门禁（语句级门禁见 autoRun.ts）：
 * - 连接/库必须与回复发起时一致（生成期间切换后，按旧 schema 生成的 SQL 不得跑在新目标上）；
 * - 生产连接不自动执行（保留手动按钮）；
 * - 仅关系引擎。
 */
/** 是否关系引擎（MySQL/PG/SQLite）。 */
export function isRelationalDbType(dbType: string): boolean {
  return AUTORUN_DB_TYPES.has(dbType);
}

export function canAutoRunForReply(
  binding: ReplyBinding | undefined,
  current: ReplyBinding,
  conn: { dbType: string; environment?: string } | undefined,
): boolean {
  if (!binding || !conn) return false;
  if (!binding.connId || binding.connId !== current.connId) return false;
  if ((binding.scope ?? '') !== (current.scope ?? '')) return false;
  if (conn.environment === 'production') return false;
  return isRelationalDbType(conn.dbType);
}
