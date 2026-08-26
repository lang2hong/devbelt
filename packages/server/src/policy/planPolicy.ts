import type { Plan } from '../domain/entities.js';
import type { QuotaType } from '../domain/enums.js';
import { QuotaExceededError } from '../domain/errors.js';
import { Feature } from '../domain/enums.js';
import type { IMembershipRepo, ISubscriptionRepo, IPlanRepo } from '../repository/interfaces.js';

/** 有效席位套餐解析：给定 userId 返回其所有活跃席位对应的套餐列表。 */
export type EffectivePlansResolver = (userId: number) => Promise<Plan[]>;

/**
 * 解析某用户的有效席位套餐列表：member → organization → subscription → plan。
 * 个人额度取所有有效席位套餐中的最高值，不叠加；personal org 的 free 套餐是
 * 最低保底 —— 当没有任何活跃订阅解出套餐时，回落到 free 套餐（按 code 查）。
 * 供 app.ts 与测试共同复用，避免三处各写一遍还写漂移。
 */
export async function resolveEffectivePlans(
  userId: number,
  deps: { membershipRepo: IMembershipRepo; subRepo: ISubscriptionRepo; planRepo: IPlanRepo },
): Promise<Plan[]> {
  const memberships = (await deps.membershipRepo.listByUser(userId)).filter((m) => m.status === 'active');
  const subs = await deps.subRepo.findByOrganizationIds(memberships.map((m) => m.organizationId));
  const subByOrg = new Map(subs.map((s) => [s.organizationId, s]));
  const now = new Date();
  const plans = new Map<number, Plan>();
  for (const m of memberships) {
    const sub = subByOrg.get(m.organizationId);
    if (!sub || sub.status === 'expired') continue;
    // active/canceled 按 period_end_time 到期；trialing 按 trial_end_time 到期。
    // 试用必须能过期，否则建 team 组织即永久免费 team（付费门禁旁路）。
    if (sub.periodEndTime && sub.periodEndTime <= now) continue;
    if (sub.status === 'trialing' && sub.trialEndTime && sub.trialEndTime <= now) continue;
    const plan = await deps.planRepo.findById(sub.planId);
    if (plan) plans.set(plan.id, plan);
  }
  if (plans.size === 0) {
    const free = await deps.planRepo.findByCode('free');
    if (free) plans.set(free.id, free);
  }
  return [...plans.values()];
}

/**
 * 套餐策略（Strategy 模式，v2 per-seat 语义）。
 *
 * 个人额度按「有效席位套餐最高值」取：同一用户属于多个组织时，每个配额维度
 * 取所有有效席位套餐中的最高值，不相加；personal org 的 free 套餐是最低保底。
 * `0` 表示无限 —— 只要有一个有效套餐在该维度为 0，个人在该维度即无限。
 *
 * 阈值数据驱动（plans 表）；PlanPolicy 负责解析 + 比较 + 校验。
 */
export class PlanPolicy {
  constructor(private readonly resolvePlans: EffectivePlansResolver) {}

  /** 取某用户的全部有效套餐（原始列表，供装配 /api/me 等） */
  async effectivePlans(userId: number): Promise<Plan[]> {
    return this.resolvePlans(userId);
  }

  /** 取配额阈值（取有效席位套餐中的最高值）；0 = 无限 */
  async limit(userId: number, quota: QuotaType): Promise<number> {
    const plans = await this.resolvePlans(userId);
    return pickLimit(plans.map((p) => planQuota(p, quota)));
  }

  /** 校验「再增加 delta 个」是否越界。current 是新增之前的已用量 */
  async checkIncrement(userId: number, quota: QuotaType, current: number, delta = 1): Promise<void> {
    const limit = await this.limit(userId, quota);
    const projected = current + delta;
    if (limit > 0 && projected > limit) throw new QuotaExceededError(quota, limit, projected);
  }

  /** 校验「写入后的总量」是否越界 */
  async checkTotal(userId: number, quota: QuotaType, projected: number): Promise<void> {
    const limit = await this.limit(userId, quota);
    if (limit > 0 && projected > limit) throw new QuotaExceededError(quota, limit, projected);
  }

  /** 功能位校验（任一有效席位套餐持有该 feature 即通过） */
  async hasFeature(userId: number, feature: number): Promise<boolean> {
    const plans = await this.resolvePlans(userId);
    return plans.some((p) => (p.features & feature) === feature);
  }

  /** 同步历史版本保留数（取有效席位套餐中的最高值） */
  async syncVersionRetention(userId: number): Promise<number> {
    const plans = await this.resolvePlans(userId);
    return pickLimit(plans.map((p) => p.perUserSyncVersionRetention));
  }
}

function planQuota(plan: Plan, quota: QuotaType): number {
  switch (quota) {
    case 'devices': return plan.perSeatMaxDevices;
    case 'connections': return plan.perUserMaxPrivateConnections;
    case 'sync_bytes': return plan.perUserPrivateSyncQuotaBytes;
    case 'history': return plan.perUserHistoryRetentionCount;
  }
}

/**
 * 多个套餐的同维度限额取最高：0 表示无限，故任一为 0 即整体无限，否则取最大。
 * 空列表是数据完整性问题（注册必建 personal org + free 订阅），抛错以 loud fail。
 */
function pickLimit(values: number[]): number {
  if (values.length === 0) throw new Error('no effective plan resolved; registration should guarantee a personal org');
  if (values.some((v) => v === 0)) return 0;
  return Math.max(...values);
}

/** 便于调用方按功能名取位标志 */
export { Feature };