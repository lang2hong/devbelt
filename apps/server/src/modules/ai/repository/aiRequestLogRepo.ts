import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';

/**
 * AI 请求流水（`ai_request_log`，迁移 012）：每笔请求一行，结算事务内写入。
 *
 * - 只存**计量与金额快照**（原始/计费 token、当时 k 与倍率、当时成本），不存对话文本；
 * - 成本按请求当时计价折算 → 区间毛利统计为历史精确值（月账本 `ai_token_usage` 无价格维度，
 *   单月视图只能按当前价近似——两者口径在页面标注区分）；
 * - 保留 180 天（retentionCleanup 分批物理删除）；月账本不受影响；
 * - 分页：id 倒序 keyset（与全站 cursor 习惯一致，路由层用 CursorService 签名包装）。
 */
export type AiRequestStatus = 'completed' | 'failed' | 'aborted';

export interface AiRequestLogRow {
  id: number;
  userId: number;
  usageMonth: string;
  model: string;
  requestId: string | null;
  rawPromptTokens: number;
  rawCompletionTokens: number;
  billingPromptTokens: number;
  billingCompletionTokens: number;
  /** 结算当时的输出权重 k。 */
  weight: number;
  /** 结算当时的计费倍率。 */
  multiplier: number;
  /** 请求当时按计价折算的成本（分）；计价缺失时 null。 */
  costCents: number | null;
  status: AiRequestStatus;
  usageEstimated: boolean;
  latencyMs: number;
  createTime: Date;
}

export interface IAiRequestLogRepo {
  /** 结算事务内插入（与配额扣减同生共死）。 */
  insertInTx(tx: Queryable, row: Omit<AiRequestLogRow, 'id' | 'createTime'>): Promise<void>;
  /** 用户维度分页（id 倒序 keyset）。 */
  listByUser(userId: number, opts: { afterId?: number; limit: number }): Promise<{ items: AiRequestLogRow[]; nextId: number | null }>;
  /** 保留期清理：删除 create_time 早于 before 的行，返回删除数（分批）。 */
  prune(before: Date, batchSize: number): Promise<number>;
  /** 区间按月聚合（流水口径：精确成本；无流水的月份不出现）。 */
  summaryByMonth(from: string, to: string): Promise<Array<{
    usageMonth: string; requestCount: number;
    rawPromptTokens: number; rawCompletionTokens: number;
    billingPromptTokens: number; billingCompletionTokens: number;
    costCents: number | null;
  }>>;
  /** 区间按模型聚合。 */
  summaryByModel(from: string, to: string): Promise<Array<{
    model: string; requestCount: number;
    rawPromptTokens: number; rawCompletionTokens: number;
    billingPromptTokens: number; billingCompletionTokens: number;
    costCents: number | null;
  }>>;
}

const COLS = `id, user_id, usage_month, model, request_id, raw_prompt_tokens, raw_completion_tokens,
  billing_prompt_tokens, billing_completion_tokens, weight, multiplier, cost_cents, status,
  usage_estimated, latency_ms, create_time`;

function mapRow(r: any): AiRequestLogRow {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    usageMonth: String(r.usage_month),
    model: String(r.model),
    requestId: r.request_id === null || r.request_id === undefined ? null : String(r.request_id),
    rawPromptTokens: Number(r.raw_prompt_tokens ?? 0),
    rawCompletionTokens: Number(r.raw_completion_tokens ?? 0),
    billingPromptTokens: Number(r.billing_prompt_tokens ?? 0),
    billingCompletionTokens: Number(r.billing_completion_tokens ?? 0),
    weight: Number(r.weight ?? 1),
    multiplier: Number(r.multiplier ?? 1),
    costCents: r.cost_cents === null || r.cost_cents === undefined ? null : Number(r.cost_cents),
    status: (r.status === 'failed' || r.status === 'aborted' ? r.status : 'completed') as AiRequestStatus,
    usageEstimated: Boolean(r.usage_estimated),
    latencyMs: Number(r.latency_ms ?? 0),
    createTime: new Date(r.create_time as string | number | Date),
  };
}

export class MysqlAiRequestLogRepo implements IAiRequestLogRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async insertInTx(tx: Queryable, row: Omit<AiRequestLogRow, 'id' | 'createTime'>): Promise<void> {
    await tx.query(
      `INSERT INTO ai_request_log
         (user_id, usage_month, model, request_id, raw_prompt_tokens, raw_completion_tokens,
          billing_prompt_tokens, billing_completion_tokens, weight, multiplier, cost_cents,
          status, usage_estimated, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.userId, row.usageMonth, row.model, row.requestId,
        row.rawPromptTokens, row.rawCompletionTokens,
        row.billingPromptTokens, row.billingCompletionTokens,
        row.weight, row.multiplier, row.costCents,
        row.status, row.usageEstimated ? 1 : 0, row.latencyMs,
      ],
    );
  }

  async listByUser(userId: number, opts: { afterId?: number; limit: number }): Promise<{ items: AiRequestLogRow[]; nextId: number | null }> {
    const conds = ['user_id = ?'];
    const args: unknown[] = [userId];
    if (opts.afterId != null) { conds.push('id < ?'); args.push(opts.afterId); }
    args.push(opts.limit + 1);
    const [rows] = await this.db().query<any[]>(
      `SELECT ${COLS} FROM ai_request_log WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      args,
    );
    const hasMore = rows.length > opts.limit;
    const items = (hasMore ? rows.slice(0, opts.limit) : rows).map(mapRow);
    return { items, nextId: hasMore ? items[items.length - 1].id : null };
  }

  async prune(before: Date, batchSize: number): Promise<number> {
    const [result] = await this.db().query<any>(
      'DELETE FROM ai_request_log WHERE create_time < ? ORDER BY id LIMIT ?',
      [before, batchSize],
    );
    return Number(result?.affectedRows ?? 0);
  }

  async summaryByMonth(from: string, to: string): Promise<Array<{
    usageMonth: string; requestCount: number;
    rawPromptTokens: number; rawCompletionTokens: number;
    billingPromptTokens: number; billingCompletionTokens: number;
    costCents: number | null;
  }>> {
    const [rows] = await this.db().query<any[]>(
      `SELECT usage_month,
              COUNT(*) AS n,
              COALESCE(SUM(raw_prompt_tokens), 0) AS rp,
              COALESCE(SUM(raw_completion_tokens), 0) AS rc,
              COALESCE(SUM(billing_prompt_tokens), 0) AS bp,
              COALESCE(SUM(billing_completion_tokens), 0) AS bc,
              SUM(cost_cents) AS cost
         FROM ai_request_log
        WHERE usage_month >= ? AND usage_month <= ?
        GROUP BY usage_month
        ORDER BY usage_month ASC`,
      [from, to],
    );
    return rows.map((r: any) => ({
      usageMonth: String(r.usage_month),
      requestCount: Number(r.n ?? 0),
      rawPromptTokens: Number(r.rp ?? 0),
      rawCompletionTokens: Number(r.rc ?? 0),
      billingPromptTokens: Number(r.bp ?? 0),
      billingCompletionTokens: Number(r.bc ?? 0),
      costCents: r.cost === null || r.cost === undefined ? null : Number(r.cost),
    }));
  }

  async summaryByModel(from: string, to: string): Promise<Array<{
    model: string; requestCount: number;
    rawPromptTokens: number; rawCompletionTokens: number;
    billingPromptTokens: number; billingCompletionTokens: number;
    costCents: number | null;
  }>> {
    const [rows] = await this.db().query<any[]>(
      `SELECT model,
              COUNT(*) AS n,
              COALESCE(SUM(raw_prompt_tokens), 0) AS rp,
              COALESCE(SUM(raw_completion_tokens), 0) AS rc,
              COALESCE(SUM(billing_prompt_tokens), 0) AS bp,
              COALESCE(SUM(billing_completion_tokens), 0) AS bc,
              SUM(cost_cents) AS cost
         FROM ai_request_log
        WHERE usage_month >= ? AND usage_month <= ?
        GROUP BY model
        ORDER BY bc DESC`,
      [from, to],
    );
    return rows.map((r: any) => ({
      model: String(r.model),
      requestCount: Number(r.n ?? 0),
      rawPromptTokens: Number(r.rp ?? 0),
      rawCompletionTokens: Number(r.rc ?? 0),
      billingPromptTokens: Number(r.bp ?? 0),
      billingCompletionTokens: Number(r.bc ?? 0),
      costCents: r.cost === null || r.cost === undefined ? null : Number(r.cost),
    }));
  }
}
