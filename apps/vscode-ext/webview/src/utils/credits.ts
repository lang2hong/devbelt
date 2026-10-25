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
/** 剩余额度占上限的比例低于该值时，顶栏常驻提示（其余时候只在「⋯ → 额度」里查看）。 */
export const LOW_QUOTA_RATIO = 0.1;

/**
 * 是否属于「低额度」：剩余 ≤ 0，或剩余 ≤ 上限 × LOW_QUOTA_RATIO。
 * 上限未知（0）时只看是否耗尽。
 */
export function isQuotaLow(quota: { limit: number; remaining: number } | null | undefined): boolean {
  if (!quota) return false;
  if (!Number.isFinite(quota.remaining)) return false;
  if (quota.remaining <= 0) return true;
  if (!Number.isFinite(quota.limit) || quota.limit <= 0) return false;
  return quota.remaining <= quota.limit * LOW_QUOTA_RATIO;
}
