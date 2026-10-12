export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/**
 * 展示性 token 估算（非计费口径）：CJK 按 1 字符 ≈ 1 token，其余按 4 字符 ≈ 1 token。
 * 仅用于 UI 提示与预占粗估；硬校验以服务端 usage 为准。
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK_RE) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * 配额判定（fail-closed）：`limit` 缺失或 ≤ 0 一律视为无配额（拒绝）；
 * 0 不表示"不限"——AI 月额度没有"不限"档（与 maxSavedConnections 的约定有意不同）。
 */
export function withinAiQuota(limit: number | undefined, used: number): boolean {
  if (limit === undefined || limit <= 0) return false;
  return used < limit;
}