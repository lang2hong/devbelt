/** 管理端趋势图共用的 UTC 日期序列工具。 */

/** 近 N 天（含今天）的 UTC 日期键，从旧到新。 */
export function lastDaysUtc(days: number, now = new Date()): string[] {
  const n = Math.max(1, Math.floor(days));
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** DATE 列在 mysql2 下可能是 Date 也可能是字符串；统一成 `YYYY-MM-DD`。 */
export function dayKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}