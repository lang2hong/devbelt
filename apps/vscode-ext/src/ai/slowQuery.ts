/**
 * 慢查询判定（AI Chat in-chat 执行，纯函数，host 与 webview 均可导入）。
 * - 执行中超过 RUNNING_SLOW_HINT_MS：提示「较慢，可继续等待或取消」；
 * - 完成/取消时耗时 ≥ SLOW_QUERY_MS：提供「让 AI 优化」入口。
 */
export const RUNNING_SLOW_HINT_MS = 10_000;
export const SLOW_QUERY_MS = 5_000;

export function isSlowQuery(costMs: number | undefined): boolean {
  return typeof costMs === 'number' && Number.isFinite(costMs) && costMs >= SLOW_QUERY_MS;
}

export function isRunningSlow(elapsedMs: number): boolean {
  return elapsedMs >= RUNNING_SLOW_HINT_MS;
}

/** 毫秒 → 展示用秒数（<10s 保留 1 位小数；≥10s 取整；非法值按 0）。 */
export function formatElapsed(ms: number): string {
  const sec = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`;
}
