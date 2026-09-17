import type { Plan } from '../../../domain/entities.js';

/**
 * 权益派生单出口。
 *
 * 权益不再冻结在订阅快照里，而是**读取时由 plan 特性派生**：
 * - `planEntitlement(plan)`：把 plan 的特性映射为权益对象；plan 缺失为空对象。
 * - `isSubscriptionActive(sub, now)`：读时失效（status 且 period_end_time 未过）。
 * - `deriveEntitlement(sub, plan, freePlan, now)`：唯一组合出口。**失效/缺失订阅回落到
 *   对应 free 档权益**（D2「到期回 free」）——绝不返回空对象，否则消费方以
 *   `limit > 0` 判定配额时会把 0 当作「不限」而反向全开。
 *
 * 所有消费方（/api/db/me、consoleData、authService、syncRecordService、
 * organizationResourceService 等）必须经此，不得各自判断到期或复制特性。
 *
 * 数值语义：配额以 `0 = 不限` 表达，派生**原样透出**（消费方以 `if (limit > 0)` 判定）。
 */
export type Entitlement = Record<string, unknown>;

export const EMPTY_ENTITLEMENT: Entitlement = Object.freeze({});

export function planEntitlement(plan: Plan | undefined): Entitlement {
  return plan ? { ...plan.features } : {};
}

export function isSubscriptionActive(
  sub: { status: string; periodEndTime: Date | null },
  now: Date = new Date(),
): boolean {
  if (sub.status !== 'active') return false;
  return sub.periodEndTime === null || sub.periodEndTime.getTime() > now.getTime();
}

/**
 * 派生订阅当前权益：有效订阅 → 其 plan；失效/缺失订阅或 plan 缺失 → free 档权益。
 * 调用方须按 kind 提供对应 free plan（personal → `free`，organization → `organization_free`）。
 */
export function deriveEntitlement(
  sub: { status: string; periodEndTime: Date | null } | undefined,
  plan: Plan | undefined,
  freePlan: Plan | undefined,
  now: Date = new Date(),
): Entitlement {
  if (!sub || !isSubscriptionActive(sub, now)) return planEntitlement(requireFree(freePlan));
  return planEntitlement(plan ?? requireFree(freePlan));
}

/**
 * free 档是失效回落的最终兜底：缺失会返回 `{}`，而 `0 = 不限` 的语义会让配额**反向全开**。
 * 因此 free 缺失视为不变量破坏，直接抛错（fail-closed），而不是静默放行。
 * free 档也不得被 archived（批 2 管理端写入校验）。
 */
function requireFree(freePlan: Plan | undefined): Plan {
  if (!freePlan) throw new Error('free plan is missing; cannot derive fallback entitlement');
  return freePlan;
}