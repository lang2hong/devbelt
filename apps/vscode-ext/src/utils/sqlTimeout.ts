import { QueryService } from '@devbelt/db-core';

/**
 * SQL 语句执行超时（全局默认，设置 `devbelt.sql.queryTimeoutSeconds`，单位秒）。
 *
 * - 生效链：连接表单 `requestTimeout`（毫秒，连接级覆盖）→ 本设置（全局默认）；
 *   `QueryService.timeoutMs` 每次查询读取静态值，因此设置改动**实时生效**（无需重连）；
 * - 0 = 不超时；非法/越界回退默认 300 秒。
 */
export const DEFAULT_QUERY_TIMEOUT_SECONDS = 300;
export const MAX_QUERY_TIMEOUT_SECONDS = 86_400;

/** 设置原始值 → 毫秒（供 QueryService.queryTimeout）。 */
export function resolveQueryTimeoutMs(raw: unknown): number {
  const seconds =
    typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_QUERY_TIMEOUT_SECONDS;
  const clamped = Math.min(MAX_QUERY_TIMEOUT_SECONDS, Math.max(0, Math.floor(seconds)));
  return clamped * 1000;
}

/** 读取当前设置并应用到 QueryService 静态默认（激活时 + 配置变更时调用）。`get` 形如 `(key) => config.get(key)`。 */
export function applyQueryTimeoutFromConfig(get: (key: string) => unknown): void {
  QueryService.queryTimeout = resolveQueryTimeoutMs(get('sql.queryTimeoutSeconds'));
}
