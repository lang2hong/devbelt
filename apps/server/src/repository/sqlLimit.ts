/**
 * 将调用方传入的 limit 收敛为**可安全内插**的正整数。
 *
 * 仓库层的 `LIMIT ${Number(x)}` 在 x 为 undefined/NaN 时会产生 `LIMIT NaN`，
 * 使查询直接报错 500。此处仅把无效值兜底为 fallback，**不设上限**，避免改变
 * 既有合法值（上限由路由层 `parseLimit` 等负责）。
 */
export function safeLimit(value: unknown, fallback = 50): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}