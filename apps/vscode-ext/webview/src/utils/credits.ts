/**
 * 积分展示：服务端额度以 token 记账，1 积分 = 1000 计费 token。
 * 计费 token 是整数，因此积分最多 3 位小数；不要用整数四舍五入把小額消耗显示成 0。
 */
export function formatCredits(credits: number): string {
  if (!Number.isFinite(credits)) return '—';
  return credits.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/** token → 积分展示。 */
export function formatCreditTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return '—';
  return formatCredits(tokens / 1000);
}