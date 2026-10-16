import type { Queryable } from '../../src/repository/mysql/db.js';
import type { AiModelPricing, AiBillingSettingsRaw, IAiBillingRepo, AiMonthlyUsage, AiMonthlyRevenue } from '../../src/modules/ai/repository/aiBillingRepo.js';
import type { IAiRequestLogRepo, AiRequestLogRow, AiRequestStatus } from '../../src/modules/ai/repository/aiRequestLogRepo.js';
import type { Queryable as Q } from '../../src/repository/mysql/db.js';

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
      typicalOutputRatio: patch.typicalOutputRatio !== undefined ? patch.typicalOutputRatio : (cur?.typicalOutputRatio ?? 0.2),
    };
  }
  async monthlyUsage(usageMonth: string): Promise<AiMonthlyUsage> {
    return this.usageByMonth.get(usageMonth) ?? { usageMonth, promptTokens: 0, completionTokens: 0, billingPromptTokens: 0, billingCompletionTokens: 0, requestCount: 0 };
  }
  async monthlyRevenue(usageMonth: string): Promise<AiMonthlyRevenue> {
    return this.revenueByMonth.get(usageMonth) ?? { topupCents: 0, planCents: 0 };
  }
}

/** 内存版 AI 请求流水仓储（测试用；id 自增、id 倒序 keyset、按月/按模型聚合）。 */
export class MemoryAiRequestLogRepo implements IAiRequestLogRepo {
  readonly rows: Array<AiRequestLogRow> = [];
  private nextId = 1;

  async insertInTx(_tx: Q, row: Omit<AiRequestLogRow, 'id' | 'createTime'>): Promise<void> {
    this.rows.push({ ...row, id: this.nextId++, createTime: new Date() });
  }

  async listByUser(userId: number, opts: { afterId?: number; limit: number }): Promise<{ items: AiRequestLogRow[]; nextId: number | null }> {
    const filtered = this.rows
      .filter((r) => r.userId === userId && (opts.afterId != null ? r.id < opts.afterId : true))
      .sort((a, b) => b.id - a.id);
    const hasMore = filtered.length > opts.limit;
    const items = hasMore ? filtered.slice(0, opts.limit) : filtered;
    return { items, nextId: hasMore ? items[items.length - 1].id : null };
  }

  async prune(before: Date, batchSize: number): Promise<number> {
    const doomed = this.rows.filter((r) => r.createTime < before).slice(0, batchSize);
    for (const d of doomed) this.rows.splice(this.rows.indexOf(d), 1);
    return doomed.length;
  }

  async summaryByMonth(from: string, to: string): Promise<Array<{ usageMonth: string; requestCount: number; rawPromptTokens: number; rawCompletionTokens: number; billingPromptTokens: number; billingCompletionTokens: number; costCents: number | null }>> {
    const acc = new Map<string, { usageMonth: string; requestCount: number; rawPromptTokens: number; rawCompletionTokens: number; billingPromptTokens: number; billingCompletionTokens: number; costCents: number | null; hasCost: boolean }>();
    for (const r of this.rows) {
      if (r.usageMonth < from || r.usageMonth > to) continue;
      const cur = acc.get(r.usageMonth) ?? { usageMonth: r.usageMonth, requestCount: 0, rawPromptTokens: 0, rawCompletionTokens: 0, billingPromptTokens: 0, billingCompletionTokens: 0, costCents: 0, hasCost: false };
      cur.requestCount += 1;
      cur.rawPromptTokens += r.rawPromptTokens;
      cur.rawCompletionTokens += r.rawCompletionTokens;
      cur.billingPromptTokens += r.billingPromptTokens;
      cur.billingCompletionTokens += r.billingCompletionTokens;
      if (r.costCents !== null) { cur.costCents = (cur.costCents ?? 0) + r.costCents; cur.hasCost = true; }
      acc.set(r.usageMonth, cur);
    }
    return [...acc.values()].sort((a, b) => a.usageMonth.localeCompare(b.usageMonth)).map(({ hasCost, ...rest }) => ({ ...rest, costCents: hasCost ? rest.costCents : null }));
  }

  async summaryByModel(from: string, to: string): Promise<Array<{ model: string; requestCount: number; rawPromptTokens: number; rawCompletionTokens: number; billingPromptTokens: number; billingCompletionTokens: number; costCents: number | null }>> {
    const acc = new Map<string, { model: string; requestCount: number; rawPromptTokens: number; rawCompletionTokens: number; billingPromptTokens: number; billingCompletionTokens: number; costCents: number | null; hasCost: boolean }>();
    for (const r of this.rows) {
      if (r.usageMonth < from || r.usageMonth > to) continue;
      const cur = acc.get(r.model) ?? { model: r.model, requestCount: 0, rawPromptTokens: 0, rawCompletionTokens: 0, billingPromptTokens: 0, billingCompletionTokens: 0, costCents: 0, hasCost: false };
      cur.requestCount += 1;
      cur.rawPromptTokens += r.rawPromptTokens;
      cur.rawCompletionTokens += r.rawCompletionTokens;
      cur.billingPromptTokens += r.billingPromptTokens;
      cur.billingCompletionTokens += r.billingCompletionTokens;
      if (r.costCents !== null) { cur.costCents = (cur.costCents ?? 0) + r.costCents; cur.hasCost = true; }
      acc.set(r.model, cur);
    }
    return [...acc.values()].sort((a, b) => b.billingCompletionTokens - a.billingCompletionTokens).map(({ hasCost, ...rest }) => ({ ...rest, costCents: hasCost ? rest.costCents : null }));
  }
}

export type { AiRequestStatus };
