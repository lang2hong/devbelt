import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';

/**
 * AI 计费引擎仓储：模型计价表 + 单行计费设置 + 财务月度聚合。
 *
 * - `upstream_api_key` 只在 `getRawSettings`（服务端内部生效配置用）与写入路径出现，
 *   任何管理视图 DTO 不回明文（由路由层 `settingsDto` 控制）；
 * - 财务聚合读 `ai_token_usage`（计费 token 口径）与 `orders`（topup/plan 实收）。
 */

export interface AiModelPricing {
  model: string;
  providerCode: string | null;
  inputCentsPerM: number;
  outputCentsPerM: number;
  weightOverride: number | null;
  status: 'active' | 'disabled';
}

export interface AiBillingSettingsRaw {
  activeModel: string | null;
  upstreamBaseUrl: string | null;
  upstreamApiKey: string | null;
  globalMultiplier: number;
}

export interface AiMonthlyUsage {
  usageMonth: string;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
}

export interface AiMonthlyRevenue {
  topupCents: number;
  planCents: number;
}

export interface IAiBillingRepo {
  listPricingAll(): Promise<AiModelPricing[]>;
  listPricingActive(): Promise<AiModelPricing[]>;
  findPricingByModel(model: string): Promise<AiModelPricing | undefined>;
  insertPricingInTx(tx: Queryable, row: AiModelPricing): Promise<boolean>;
  updatePricingInTx(tx: Queryable, model: string, patch: Partial<Omit<AiModelPricing, 'model'>>): Promise<boolean>;
  getRawSettings(): Promise<AiBillingSettingsRaw | undefined>;
  upsertSettingsInTx(tx: Queryable, patch: Partial<AiBillingSettingsRaw>): Promise<void>;
  monthlyUsage(usageMonth: string): Promise<AiMonthlyUsage>;
  monthlyRevenue(usageMonth: string): Promise<AiMonthlyRevenue>;
}

const PRICING_COLS = 'model, provider_code, input_cents_per_m, output_cents_per_m, weight_override, status';

function mapPricing(r: Record<string, unknown>): AiModelPricing {
  return {
    model: String(r.model),
    providerCode: r.provider_code === null || r.provider_code === undefined ? null : String(r.provider_code),
    inputCentsPerM: Number(r.input_cents_per_m ?? 0),
    outputCentsPerM: Number(r.output_cents_per_m ?? 0),
    weightOverride: r.weight_override === null || r.weight_override === undefined ? null : Number(r.weight_override),
    status: r.status === 'disabled' ? 'disabled' : 'active',
  };
}

export class MysqlAiBillingRepo implements IAiBillingRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async listPricingAll(): Promise<AiModelPricing[]> {
    const [rows] = await this.db().query<any[]>(`SELECT ${PRICING_COLS} FROM ai_model_pricing ORDER BY model ASC`);
    return rows.map(mapPricing);
  }

  async listPricingActive(): Promise<AiModelPricing[]> {
    const [rows] = await this.db().query<any[]>(
      `SELECT ${PRICING_COLS} FROM ai_model_pricing WHERE status = 'active' ORDER BY model ASC`,
    );
    return rows.map(mapPricing);
  }

  async findPricingByModel(model: string): Promise<AiModelPricing | undefined> {
    const [rows] = await this.db().query<any[]>(`SELECT ${PRICING_COLS} FROM ai_model_pricing WHERE model = ?`, [model]);
    return rows[0] ? mapPricing(rows[0]) : undefined;
  }

  async insertPricingInTx(tx: Queryable, row: AiModelPricing): Promise<boolean> {
    const [result] = await tx.query<any>(
      `INSERT INTO ai_model_pricing (model, provider_code, input_cents_per_m, output_cents_per_m, weight_override, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE model = model`,
      [row.model, row.providerCode, row.inputCentsPerM, row.outputCentsPerM, row.weightOverride, row.status],
    );
    return Number(result?.affectedRows ?? 0) === 1;
  }

  async updatePricingInTx(tx: Queryable, model: string, patch: Partial<Omit<AiModelPricing, 'model'>>): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.providerCode !== undefined) {
      sets.push('provider_code = ?');
      params.push(patch.providerCode);
    }
    if (patch.inputCentsPerM !== undefined) {
      sets.push('input_cents_per_m = ?');
      params.push(patch.inputCentsPerM);
    }
    if (patch.outputCentsPerM !== undefined) {
      sets.push('output_cents_per_m = ?');
      params.push(patch.outputCentsPerM);
    }
    if (patch.weightOverride !== undefined) {
      sets.push('weight_override = ?');
      params.push(patch.weightOverride);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (sets.length === 0) return true;
    const [result] = await tx.query<any>(`UPDATE ai_model_pricing SET ${sets.join(', ')} WHERE model = ?`, [...params, model]);
    return Number(result?.affectedRows ?? 0) > 0;
  }

  async getRawSettings(): Promise<AiBillingSettingsRaw | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT active_model, upstream_base_url, upstream_api_key, global_multiplier FROM ai_billing_settings WHERE id = 1',
    );
    const r = rows[0];
    if (!r) return undefined;
    return {
      activeModel: r.active_model === null || r.active_model === undefined ? null : String(r.active_model),
      upstreamBaseUrl: r.upstream_base_url === null || r.upstream_base_url === undefined ? null : String(r.upstream_base_url),
      upstreamApiKey: r.upstream_api_key === null || r.upstream_api_key === undefined ? null : String(r.upstream_api_key),
      globalMultiplier: Number(r.global_multiplier ?? 1),
    };
  }

  async upsertSettingsInTx(tx: Queryable, patch: Partial<AiBillingSettingsRaw>): Promise<void> {
    const current = await this.getRawSettings();
    const next = {
      activeModel: patch.activeModel !== undefined ? patch.activeModel : (current?.activeModel ?? null),
      upstreamBaseUrl: patch.upstreamBaseUrl !== undefined ? patch.upstreamBaseUrl : (current?.upstreamBaseUrl ?? null),
      upstreamApiKey: patch.upstreamApiKey !== undefined ? patch.upstreamApiKey : (current?.upstreamApiKey ?? null),
      globalMultiplier: patch.globalMultiplier !== undefined ? patch.globalMultiplier : (current?.globalMultiplier ?? 1),
    };
    await tx.query<any>(
      `INSERT INTO ai_billing_settings (id, active_model, upstream_base_url, upstream_api_key, global_multiplier)
       VALUES (1, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         active_model = VALUES(active_model),
         upstream_base_url = VALUES(upstream_base_url),
         upstream_api_key = VALUES(upstream_api_key),
         global_multiplier = VALUES(global_multiplier)`,
      [next.activeModel, next.upstreamBaseUrl, next.upstreamApiKey, next.globalMultiplier],
    );
  }

  async monthlyUsage(usageMonth: string): Promise<AiMonthlyUsage> {
    const [rows] = await this.db().query<any[]>(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS p, COALESCE(SUM(completion_tokens), 0) AS c, COALESCE(SUM(request_count), 0) AS n
         FROM ai_token_usage WHERE usage_month = ?`,
      [usageMonth],
    );
    const r = (rows[0] ?? {}) as Record<string, unknown>;
    return {
      usageMonth,
      promptTokens: Number(r.p ?? 0),
      completionTokens: Number(r.c ?? 0),
      requestCount: Number(r.n ?? 0),
    };
  }

  async monthlyRevenue(usageMonth: string): Promise<AiMonthlyRevenue> {
    const [rows] = await this.db().query<any[]>(
      `SELECT purpose, COALESCE(SUM(amount_cents), 0) AS cents
         FROM orders
        WHERE status IN ('paid', 'fulfilled')
          AND ((paid_time IS NOT NULL AND DATE_FORMAT(paid_time, '%Y-%m') = ?)
            OR (paid_time IS NULL AND DATE_FORMAT(create_time, '%Y-%m') = ?))
        GROUP BY purpose`,
      [usageMonth, usageMonth],
    );
    const byPurpose = new Map<string, number>(
      rows.map((r: Record<string, unknown>): [string, number] => [String(r.purpose), Number(r.cents ?? 0)]),
    );
    return {
      topupCents: byPurpose.get('topup') ?? 0,
      planCents: byPurpose.get('plan') ?? 0,
    };
  }
}
