import { ValidationError } from '../../../domain/errors.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import type { AiModelPricing, AiBillingSettingsRaw, IAiBillingRepo } from '../repository/aiBillingRepo.js';
import type { IAiRequestLogRepo, AiRequestLogRow } from '../repository/aiRequestLogRepo.js';
import type { AiUpstreamConfig } from '../aiConfig.js';

/**
 * AI 计费引擎（管理后台可配置）：
 *
 * - **生效配置**（60s 缓存，后台写后立即失效重读）：设置表优先、env 回退——
 *   模型 / 上游 baseUrl / 上游 apiKey / 统一 token 输出权重 k / 全局调整系数；
 * - **统一 token 口径**：计费 token = (输入 + 输出 × k) × 系数；k = weight_override ?? 输出单价÷输入单价
 *   （input=0 时回退 1）；预占与结算同口径，配额空间整体即计费 token；
 * - **成本折算**：cost（分） = 输入×输入单价 + 输出×输出单价（每 1M token 的分价；缓存价不分，
 *   按全价计 = 保守高估成本，站在不亏一侧）；
 * - 密钥边界：apiKey 只进「生效配置」给转发层用，管理视图与审计不回值。
 */

const CACHE_TTL_MS = 60_000;
const CODE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const MODEL_RE = /^[^\s]{1,128}$/;

/** 生效上游 + 计费参数（quota/转发共用）。 */
export interface EffectiveUpstream {
  configured: boolean;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** 统一 token 的输出权重 k（≥0.01）。 */
  weight: number;
  /** 全局调整系数（实际计费 ÷ 真实消耗）。 */
  multiplier: number;
  /** 当前生效的计价行（成本折算用；无则 null）。 */
  pricing: AiModelPricing | null;
}

/** 统一 token 权重 k：显式覆盖优先；否则由单价推导（input=0 → 1）。 */
export function deriveWeight(pricing: AiModelPricing | null | undefined): number {
  if (!pricing) return 1;
  if (pricing.weightOverride !== null && pricing.weightOverride !== undefined) return clampNum(pricing.weightOverride, 0.01, 100, 'weightOverride');
  if (pricing.inputCentsPerM > 0) return clampNum(pricing.outputCentsPerM / pricing.inputCentsPerM, 0.01, 100, 'weight');
  return 1;
}

/** 计费 token：输入 + 输出 × k，再乘全局系数（四舍五入取整，结算入账口径）。 */
export function billingTokens(promptTokens: number, completionTokens: number, weight: number, multiplier: number): { prompt: number; completion: number } {
  const m = clampNum(multiplier, 0.01, 100, 'multiplier');
  const k = clampNum(weight, 0.01, 100, 'weight');
  return {
    prompt: Math.max(0, Math.round(promptTokens * m)),
    completion: Math.max(0, Math.round(completionTokens * k * m)),
  };
}

/** 成本折算（分）：输入/输出分别按单价（分 / 1M token）。 */
export function costCents(promptTokens: number, completionTokens: number, pricing: AiModelPricing | null | undefined): number | null {
  if (!pricing) return null;
  return Math.round((promptTokens / 1_000_000) * pricing.inputCentsPerM + (completionTokens / 1_000_000) * pricing.outputCentsPerM);
}

function clampNum(v: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(v) || v < min || v > max) throw new ValidationError(`invalid ${field}`);
  return v;
}

function str(v: unknown, field: string, max: number, allowEmpty = true): string {
  if (typeof v !== 'string' || v.length > max || (!allowEmpty && !v.trim())) throw new ValidationError(`invalid ${field}`);
  return v.trim();
}

/** 管理后台「生效配置」视图：永不携带 apiKey 明文。 */
export interface BillingSettingsView {
  activeModel: string | null;
  upstreamBaseUrl: string | null;
  upstreamApiKeyConfigured: boolean;
  upstreamApiKeyHint: string | null;
  globalMultiplier: number;
  /** 成本测算的典型输出占比（0-1）。 */
  typicalOutputRatio: number;
  /** env 回退值（展示当前兜底，便于对照）。 */
  env: { model: string; baseUrl: string | null; apiKeyConfigured: boolean };
}

export class AiBillingService {
  private cache: { at: number; value: EffectiveUpstream } | undefined;

  constructor(
    private readonly repo: IAiBillingRepo,
    private readonly envConfig: AiUpstreamConfig,
    private readonly now: () => number = Date.now,
    /** 请求流水仓储（012；缺省时 summary/用户流水返回空——测试装配兼容）。 */
    private readonly requestLogRepo?: IAiRequestLogRepo,
  ) {}

  /** 后台写后失效（下一请求即时生效，不等 TTL）。 */
  invalidate(): void {
    this.cache = undefined;
  }

  /** 生效上游 + 计费参数（60s 缓存）。 */
  async upstream(): Promise<EffectiveUpstream> {
    if (this.cache && this.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    const settings = await this.repo.getRawSettings();
    const model = settings?.activeModel?.trim() || this.envConfig.model;
    const baseUrl = settings?.upstreamBaseUrl?.trim() || this.envConfig.baseUrl;
    const apiKey = settings?.upstreamApiKey?.trim() || this.envConfig.apiKey;
    const pricing = model ? ((await this.repo.findPricingByModel(model)) ?? null) : null;
    const value: EffectiveUpstream = {
      configured: Boolean(model && baseUrl),
      model,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      weight: deriveWeight(pricing),
      // 每模型倍率优先（012）；缺省回退全局。
      multiplier: settings
        ? clampNum(
            pricing && pricing.multiplierOverride !== null && pricing.multiplierOverride !== undefined
              ? pricing.multiplierOverride
              : settings.globalMultiplier,
            0.01, 100, 'multiplier')
        : 1,
      pricing,
    };
    this.cache = { at: this.now(), value };
    return value;
  }

  /** 管理视图（不含 Key 明文）。 */
  async settingsView(): Promise<BillingSettingsView> {
    const settings = await this.repo.getRawSettings();
    return {
      activeModel: settings?.activeModel ?? null,
      upstreamBaseUrl: settings?.upstreamBaseUrl ?? null,
      upstreamApiKeyConfigured: Boolean(settings?.upstreamApiKey?.trim()),
      upstreamApiKeyHint: settings?.upstreamApiKey ? `…${settings.upstreamApiKey.slice(-4)}` : null,
      globalMultiplier: settings?.globalMultiplier ?? 1,
      typicalOutputRatio: settings?.typicalOutputRatio ?? 0.2,
      env: {
        model: this.envConfig.model,
        baseUrl: this.envConfig.baseUrl ?? null,
        apiKeyConfigured: Boolean(this.envConfig.apiKey),
      },
    };
  }

  /** 更新设置（空串 = 清除该项回退 env；apiKey 仅此处接收明文）。 */
  async updateSettingsInTx(
    tx: Queryable,
    input: { activeModel?: unknown; upstreamBaseUrl?: unknown; upstreamApiKey?: unknown; clearUpstreamApiKey?: boolean; globalMultiplier?: unknown; typicalOutputRatio?: unknown },
  ): Promise<void> {
    const patch: Partial<AiBillingSettingsRaw> = {};
    if (input.activeModel !== undefined) {
      const v = typeof input.activeModel === 'string' ? input.activeModel.trim() : '';
      if (v && !MODEL_RE.test(v)) throw new ValidationError('invalid activeModel');
      patch.activeModel = v || null;
    }
    if (input.upstreamBaseUrl !== undefined) {
      const v = typeof input.upstreamBaseUrl === 'string' ? input.upstreamBaseUrl.trim() : '';
      if (v) {
        let url: URL;
        try {
          url = new URL(v);
        } catch {
          throw new ValidationError('invalid upstreamBaseUrl');
        }
        if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
          throw new ValidationError('upstreamBaseUrl must use https');
        }
        patch.upstreamBaseUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
      } else {
        patch.upstreamBaseUrl = null;
      }
    }
    if (input.clearUpstreamApiKey === true) patch.upstreamApiKey = null;
    else if (input.upstreamApiKey !== undefined) {
      const v = typeof input.upstreamApiKey === 'string' ? input.upstreamApiKey.trim() : '';
      // eslint-disable-next-line no-control-regex
      if (v && (/[\s\u0000-\u001f]/.test(v) || v.length > 512)) throw new ValidationError('invalid upstreamApiKey');
      patch.upstreamApiKey = v || null;
    }
    if (input.globalMultiplier !== undefined) {
      const n = Number(input.globalMultiplier);
      patch.globalMultiplier = clampNum(n, 0.01, 100, 'globalMultiplier');
    }
    if (input.typicalOutputRatio !== undefined) {
      const n = Number(input.typicalOutputRatio);
      patch.typicalOutputRatio = clampNum(n, 0.0001, 0.9999, 'typicalOutputRatio');
    }
    await this.repo.upsertSettingsInTx(tx, patch);
    this.invalidate();
  }

  async listPricingAll(): Promise<AiModelPricing[]> {
    return this.repo.listPricingAll();
  }

  async listPricingActive(): Promise<AiModelPricing[]> {
    return this.repo.listPricingActive();
  }

  /** 新增计价行；model 重复返回 undefined（路由 409）。 */
  async createPricingInTx(tx: Queryable, input: { model: unknown; providerCode?: unknown; inputCentsPerM?: unknown; outputCentsPerM?: unknown; weightOverride?: unknown; multiplierOverride?: unknown }): Promise<AiModelPricing | undefined> {
    const model = str(input.model, 'model', 128, false);
    if (!MODEL_RE.test(model)) throw new ValidationError('invalid model');
    const row: AiModelPricing = {
      model,
      providerCode: parseProviderCode(input.providerCode),
      inputCentsPerM: parseCents(input.inputCentsPerM, 'inputCentsPerM'),
      outputCentsPerM: parseCents(input.outputCentsPerM, 'outputCentsPerM'),
      weightOverride: parseWeight(input.weightOverride),
      multiplierOverride: parseWeight(input.multiplierOverride),
      status: 'active',
    };
    const inserted = await this.repo.insertPricingInTx(tx, row);
    this.invalidate();
    return inserted ? row : undefined;
  }

  async updatePricingInTx(tx: Queryable, model: string, input: { providerCode?: unknown; inputCentsPerM?: unknown; outputCentsPerM?: unknown; weightOverride?: unknown; multiplierOverride?: unknown; status?: unknown }): Promise<AiModelPricing | undefined> {
    const patch: Partial<AiModelPricing> = {};
    if (input.providerCode !== undefined) patch.providerCode = parseProviderCode(input.providerCode);
    if (input.inputCentsPerM !== undefined) patch.inputCentsPerM = parseCents(input.inputCentsPerM, 'inputCentsPerM');
    if (input.outputCentsPerM !== undefined) patch.outputCentsPerM = parseCents(input.outputCentsPerM, 'outputCentsPerM');
    if (input.weightOverride !== undefined) patch.weightOverride = parseWeight(input.weightOverride);
    if (input.multiplierOverride !== undefined) patch.multiplierOverride = parseWeight(input.multiplierOverride);
    if (input.status !== undefined) {
      if (input.status !== 'active' && input.status !== 'disabled') throw new ValidationError('invalid status');
      patch.status = input.status;
    }
    const ok = await this.repo.updatePricingInTx(tx, model, patch);
    this.invalidate();
    if (!ok) return undefined;
    return this.repo.findPricingByModel(model);
  }

  /** 财务月报（usageMonth 形如 YYYY-MM）：token 用量折算成本（按激活模型现价，历史为近似）+ 实收。 */
  async finance(usageMonth: string): Promise<{
    usageMonth: string;
    usage: { promptTokens: number; completionTokens: number; requestCount: number };
    billing: { promptTokens: number; completionTokens: number };
    costCents: number | null;
    pricingModel: string | null;
    weight: number;
    multiplier: number;
    revenue: { topupCents: number; planCents: number };
    marginCents: number | null;
  }> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(usageMonth)) throw new ValidationError('invalid month');
    const [usage, revenue, upstream] = await Promise.all([
      this.repo.monthlyUsage(usageMonth),
      this.repo.monthlyRevenue(usageMonth),
      this.upstream(),
    ]);
    // 012 修复：usage 月账本 raw_* 列为原始 token、prompt/completion 列为计费 token——
    // 不再对计费 token 二次加权；成本按原始 token × 单价（此前把计费 token 当原始用，
    // 输出部分被多乘 k，成本高估）。
    const billing = { promptTokens: usage.billingPromptTokens, completionTokens: usage.billingCompletionTokens };
    const cost = costCents(usage.promptTokens, usage.completionTokens, upstream.pricing);
    return {
      usageMonth,
      usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, requestCount: usage.requestCount },
      billing,
      costCents: cost,
      pricingModel: upstream.pricing?.model ?? null,
      weight: upstream.weight,
      multiplier: upstream.multiplier,
      revenue,
      marginCents: cost === null ? null : revenue.topupCents + revenue.planCents - cost,
    };
  }

  /**
   * 区间毛利统计（from/to 形如 YYYY-MM，跨度 ≤ 12 个月；from ≤ to）。
   * 成本/用量从 `ai_request_log` 流水聚合——按请求当时计价，历史精确；
   * 收入按订单精确；流水上线前的月份不在统计内（单月近似口径见 finance）。
   */
  async financeSummary(from: string, to: string): Promise<{
    from: string;
    to: string;
    total: {
      requestCount: number;
      rawPromptTokens: number;
      rawCompletionTokens: number;
      billingPromptTokens: number;
      billingCompletionTokens: number;
      costCents: number | null;
      topupCents: number;
      planCents: number;
      marginCents: number | null;
    };
    months: Array<{
      usageMonth: string;
      requestCount: number;
      rawPromptTokens: number;
      rawCompletionTokens: number;
      billingPromptTokens: number;
      billingCompletionTokens: number;
      costCents: number | null;
      topupCents: number;
      planCents: number;
      marginCents: number | null;
    }>;
    models: Array<{
      model: string;
      requestCount: number;
      rawPromptTokens: number;
      rawCompletionTokens: number;
      billingPromptTokens: number;
      billingCompletionTokens: number;
      costCents: number | null;
    }>;
  }> {
    this.assertMonthKey(from, 'from');
    this.assertMonthKey(to, 'to');
    if (from > to) throw new ValidationError('from must be <= to');
    if (monthSpan(from, to) > 12) throw new ValidationError('range too large (max 12 months)');
    const monthsList = monthKeysBetween(from, to);
    const [byMonth, byModel, revenues] = await Promise.all([
      this.requestLogRepo ? this.requestLogRepo.summaryByMonth(from, to) : Promise.resolve([]),
      this.requestLogRepo ? this.requestLogRepo.summaryByModel(from, to) : Promise.resolve([]),
      Promise.all(monthsList.map((m) => this.repo.monthlyRevenue(m))),
    ]);
    const revenueByMonth = new Map(monthsList.map((m, i) => [m, revenues[i]!]));
    const months = monthsList.map((m) => {
      const row = byMonth.find((r) => r.usageMonth === m);
      const revenue = revenueByMonth.get(m) ?? { topupCents: 0, planCents: 0 };
      const cost = row?.costCents ?? null;
      return {
        usageMonth: m,
        requestCount: row?.requestCount ?? 0,
        rawPromptTokens: row?.rawPromptTokens ?? 0,
        rawCompletionTokens: row?.rawCompletionTokens ?? 0,
        billingPromptTokens: row?.billingPromptTokens ?? 0,
        billingCompletionTokens: row?.billingCompletionTokens ?? 0,
        costCents: cost,
        topupCents: revenue.topupCents,
        planCents: revenue.planCents,
        marginCents: cost === null ? null : revenue.topupCents + revenue.planCents - cost,
      };
    });
    const hasCost = months.some((m) => m.costCents !== null);
    const totalCost = hasCost ? months.reduce((n, m) => n + (m.costCents ?? 0), 0) : null;
    const topupCents = months.reduce((n, m) => n + m.topupCents, 0);
    const planCents = months.reduce((n, m) => n + m.planCents, 0);
    return {
      from, to,
      total: {
        requestCount: months.reduce((n, m) => n + m.requestCount, 0),
        rawPromptTokens: months.reduce((n, m) => n + m.rawPromptTokens, 0),
        rawCompletionTokens: months.reduce((n, m) => n + m.rawCompletionTokens, 0),
        billingPromptTokens: months.reduce((n, m) => n + m.billingPromptTokens, 0),
        billingCompletionTokens: months.reduce((n, m) => n + m.billingCompletionTokens, 0),
        costCents: totalCost,
        topupCents,
        planCents,
        marginCents: totalCost === null ? null : topupCents + planCents - totalCost,
      },
      months,
      models: byModel,
    };
  }

  /** 用户请求流水（管理视图；id 倒序 keyset）。 */
  async userRequests(userId: number, opts: { afterId?: number; limit: number }): Promise<{ items: AiRequestLogRow[]; nextId: number | null }> {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new ValidationError('invalid userId');
    if (!this.requestLogRepo) return { items: [], nextId: null };
    return this.requestLogRepo.listByUser(userId, opts);
  }

  private assertMonthKey(v: string, field: string): void {
    if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(v)) throw new ValidationError(`invalid ${field}`);
  }
}

function monthSpan(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function monthKeysBetween(from: string, to: string): string[] {
  const keys: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return keys;
}

function parseProviderCode(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return null;
  if (!CODE_RE.test(v)) throw new ValidationError('invalid providerCode');
  return v;
}

function parseCents(raw: unknown, field: string): number {
  if (raw === undefined || raw === null) return 0;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0 || n > 1_000_000) throw new ValidationError(`invalid ${field}`);
  return n;
}

function parseWeight(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return clampNum(n, 0.01, 100, 'weightOverride');
}
