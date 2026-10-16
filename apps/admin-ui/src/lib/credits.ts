/**
 * 积分换算（2026-10-16 定案）：1 积分 = 1000 计费 token。
 *
 * 计费 token = (输入 + 输出 × k) × 倍率；额度池（月度赠送 + 充值）即计费 token 口径，
 * 展示层统一除以 1000 显示为积分。所有「额度/余额/消耗」数字一律经 fmtCredits 输出；
 * 管理端“近月用量/请求明细”的输入输出为原始 token 计量，保留 token 字样（对账用）。
 */

const CREDIT_TOKENS = 1000;

/** 计费 token → 积分显示（最多 1 位小数，去尾零）。 */
export function fmtCredits(billingTokens: number): string {
  const credits = billingTokens / CREDIT_TOKENS;
  if (credits >= 100) return Math.round(credits).toLocaleString();
  return String(Number(credits.toFixed(1)));
}

/** 积分数值（用于表格数字列）。 */
export function creditsValue(billingTokens: number): number {
  return Math.round(billingTokens / CREDIT_TOKENS * 10) / 10;
}

/** 每积分成本（分）：混合口径 = 1000 × [(1-r)×输入价 + r×输出价] ÷ [(1-r) + r×k] ÷ 倍率。
 *  k 为价格推导时与输入价口径恒等；k 手动覆盖时此式才与配比相关（测算列专用）。 */
export function costCentsPerCredit(inputCentsPerM: number, outputCentsPerM: number, k: number, multiplier: number, outputRatio: number): number {
  const r = outputRatio;
  const costPerRawToken = (1 - r) * (inputCentsPerM / 1_000_000) + r * (outputCentsPerM / 1_000_000);
  const billingPerRawToken = ((1 - r) + r * k) * multiplier;
  if (billingPerRawToken <= 0) return 0;
  return Math.round((costPerRawToken / billingPerRawToken) * CREDIT_TOKENS * 100) / 100;
}
