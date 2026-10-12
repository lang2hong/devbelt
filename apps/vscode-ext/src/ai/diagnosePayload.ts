import { containsSecretSql } from '../utils/sqlSecret';

/** 错误诊断请求载荷（脱敏后；sql 缺省表示被阻断/未提供）。 */
export interface DiagnosePayload {
  error: string;
  sql?: string;
  dbType?: string;
}

/**
 * 错误诊断载荷的 host 侧二次脱敏（P9 S6 抽取为纯函数以便机械断言）。
 *
 * 即便 webview 已做"secretRisk 显式确认"，host 仍不信任入站消息：
 * - message 命中口令模式（`SECRET_SQL`，含未跟引号的 `WITH (LOGIN)? PASSWORD` 形态）
 *   → **整段以 `[REDACTED]` 替代**：模式只匹配关键词形态、匹配不到其后的引号字面量，
 *   局部替换会漏出密码本身（UI 文案也承诺"默认不发送 SQL/错误原文"）；
 * - sql 命中 → 整个字段剔除以 undefined 表达（不发送原文）；
 * - 非字符串输入（伪造消息）一律按缺失处理。
 */
export function sanitizeDiagnosePayload(input: {
  message?: unknown;
  sql?: unknown;
  dbType?: unknown;
}): DiagnosePayload {
  const rawMessage = typeof input.message === 'string' ? input.message : String(input.message ?? '');
  const error = containsSecretSql(rawMessage) ? '[REDACTED]' : rawMessage;
  const sql =
    typeof input.sql === 'string' && input.sql.trim() && !containsSecretSql(input.sql) ? input.sql : undefined;
  return {
    error,
    ...(sql ? { sql } : {}),
    ...(typeof input.dbType === 'string' ? { dbType: input.dbType } : {}),
  };
}