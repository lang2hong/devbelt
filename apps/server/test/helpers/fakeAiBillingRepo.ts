import type { Queryable } from '../../src/repository/mysql/db.js';
import type { AiModelPricing, AiBillingSettingsRaw, IAiBillingRepo, AiMonthlyUsage, AiMonthlyRevenue } from '../../src/modules/ai/repository/aiBillingRepo.js';

/** 内存版计费仓储（测试用）。 */
export class MemoryAiBillingRepo implements IAiBillingRepo {
  readonly pricing = new Map<string, AiModelPricing>();
  settings: AiBillingSettingsRaw | undefined;
  usageByMonth = new Map<string, AiMonthlyUsage>();
  revenueByMonth = new Map<string, AiMonthlyRevenue>();

  async listPricingAll(): Promise<AiModelPricing[]> {
    return [...this.pricing.values()].sort((a, b) => a.model.localeCompare(b.model));
  }
  async listPricingActive(): Promise<AiModelPricing[]> {
    return (await this.listPricingAll()).filter((p) => p.status === 'active');
  }
  async findPricingByModel(model: string): Promise<AiModelPricing | undefined> {
    return this.pricing.get(model);
  }
  async insertPricingInTx(_tx: Queryable, row: AiModelPricing): Promise<boolean> {
    if (this.pricing.has(row.model)) return false;
    this.pricing.set(row.model, row);
    return true;
  }
  async updatePricingInTx(_tx: Queryable, model: string, patch: Partial<AiModelPricing>): Promise<boolean> {
    const cur = this.pricing.get(model);
    if (!cur) return false;
    this.pricing.set(model, { ...cur, ...patch });
    return true;
  }
  async getRawSettings(): Promise<AiBillingSettingsRaw | undefined> {
    return this.settings;
  }
  async upsertSettingsInTx(_tx: Queryable, patch: Partial<AiBillingSettingsRaw>): Promise<void> {
    const cur = this.settings;
    this.settings = {
      activeModel: patch.activeModel !== undefined ? patch.activeModel : (cur?.activeModel ?? null),
      upstreamBaseUrl: patch.upstreamBaseUrl !== undefined ? patch.upstreamBaseUrl : (cur?.upstreamBaseUrl ?? null),
      upstreamApiKey: patch.upstreamApiKey !== undefined ? patch.upstreamApiKey : (cur?.upstreamApiKey ?? null),
      globalMultiplier: patch.globalMultiplier !== undefined ? patch.globalMultiplier : (cur?.globalMultiplier ?? 1),
    };
  }
  async monthlyUsage(usageMonth: string): Promise<AiMonthlyUsage> {
    return this.usageByMonth.get(usageMonth) ?? { usageMonth, promptTokens: 0, completionTokens: 0, requestCount: 0 };
  }
  async monthlyRevenue(usageMonth: string): Promise<AiMonthlyRevenue> {
    return this.revenueByMonth.get(usageMonth) ?? { topupCents: 0, planCents: 0 };
  }
}
