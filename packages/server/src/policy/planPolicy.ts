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
      case 'history': return plan.historyRetentionCount;
    }
  }

  /**
   * 校验「再增加 delta 个」是否越界。
   *
   * `current` 语义是**新增之前的已用量**，所以判据是 `current + delta > limit`。
   */
  async checkIncrement(
    code: Plan['code'],
    quota: QuotaType,
    current: number,
    delta = 1,
  ): Promise<void> {
    const limit = await this.limit(code, quota);
    const projected = current + delta;
    if (limit > 0 && projected > limit) throw new QuotaExceededError(quota, limit, projected);
  }

  /**
   * 校验**写入后的总量**是否越界。
   *
   * 两个语义必须分开，否则调用方得靠猜。原来只有一个 `check(current)`，判据是
   * `current >= limit`（「已用量」语义下正确），但两个调用方传的都是写入后的
   * 总量 —— 于是实际可用上限变成 `limit - 1`：free 宣传 5 个连接，第 5 个就被
   * 拒绝，而错误信息还写着 `5/5`，用户和客服都判断不出是超限还是 bug。
   */
  async checkTotal(code: Plan['code'], quota: QuotaType, projected: number): Promise<void> {
    const limit = await this.limit(code, quota);
    if (limit > 0 && projected > limit) throw new QuotaExceededError(quota, limit, projected);
  }

  /**
   * @deprecated 语义含糊，用 checkTotal（写入后总量）或 checkIncrement（增量）。
   * 保留仅为兼容既有调用方。
   */
  async check(code: Plan['code'], quota: QuotaType, current: number): Promise<void> {
    return this.checkTotal(code, quota, current);
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
