import type { Plan } from '../domain/entities.js';
import type { QuotaType } from '../domain/enums.js';
import { QuotaExceededError } from '../domain/errors.js';
import { Feature } from '../domain/enums.js';

/**
 * 套餐策略（Strategy 模式）：
 * 阈值数据驱动（plans 表），PlanPolicy 负责读取 + 比较 + 校验。
 * 后续新增套餐仅加 plans 行，无需改此类（开闭原则）。
 */
export class PlanPolicy {
  constructor(private readonly getPlan: (code: Plan['code']) => Promise<Plan | undefined>) {}

  /** 取配额阈值；0 = 无限 */
  async limit(code: Plan['code'], quota: QuotaType): Promise<number> {
    const plan = await this.requirePlan(code);
    switch (quota) {
      case 'devices': return plan.maxDevices;
      case 'connections': return plan.maxConnections;
      case 'sync_bytes': return plan.syncQuotaBytes;
      case 'pats': return plan.maxPats;
      case 'history': return plan.historyRetentionCount;
    }
  }

  /** 校验用量是否超限；超限抛 QuotaExceededError */
  async check(code: Plan['code'], quota: QuotaType, current: number): Promise<void> {
    const limit = await this.limit(code, quota);
    if (limit > 0 && current >= limit) throw new QuotaExceededError(quota, limit, current);
  }

  /** 功能位校验（features 位掩码） */
  async hasFeature(code: Plan['code'], feature: number): Promise<boolean> {
    const plan = await this.requirePlan(code);
    return (plan.features & feature) === feature;
  }

  /** 同步历史版本保留数 */
  async syncVersionRetention(code: Plan['code']): Promise<number> {
    const plan = await this.requirePlan(code);
    return plan.syncVersionRetention;
  }

  private async requirePlan(code: Plan['code']): Promise<Plan> {
    const plan = await this.getPlan(code);
    if (!plan) throw new Error(`plan not found: ${code}`);
    return plan;
  }
}

/** 便于调用方按功能名取位标志 */
export { Feature };
