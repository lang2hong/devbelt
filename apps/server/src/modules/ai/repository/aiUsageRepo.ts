import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';

/**
 * `ai_token_usage` 当月行（按 `(user_id, usage_month)` 分桶的单段月额度账本）。
 * `reserved_*` 为请求期预占：请求开始累加、结算时释放（LEAST 防无符号下溢）。
 */
export interface AiUsageRow {
  promptTokens: number;
  completionTokens: number;
  reservedPromptTokens: number;
  reservedCompletionTokens: number;
  requestCount: number;
}

export interface AiSettlement {
  /** 释放的预占量（请求开始时 reserve 的量）。 */
  releaseReservedPromptTokens: number;
  releaseReservedCompletionTokens: number;
  /** 实际入账用量（finish usage 权威；缺失时为估算值）。 */
  promptTokens: number;
  completionTokens: number;
}

export interface IAiUsageRepo {
  /**
   * 保证当月行存在（`INSERT ... ON DUPLICATE KEY UPDATE id=id`，幂等）。
   * 必须先于 `lockRowInTx`：首次请求若直接 `SELECT ... FOR UPDATE` 只能拿到间隙锁，
   * 并发首请求会撞唯一键或死锁。
   */
  ensureRowInTx(exec: Queryable, userId: number, usageMonth: string): Promise<void>;
  /** 事务内 `SELECT ... FOR UPDATE` 串行化同用户同月并发（调用前必须先 ensureRow）。 */
  lockRowInTx(exec: Queryable, userId: number, usageMonth: string): Promise<AiUsageRow>;
  /** 预占累加（reserved_prompt/completion += 传入值）。 */
  addReservationInTx(
    exec: Queryable,
    userId: number,
    usageMonth: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void>;
  /** 结算：释放预占 + 实际用量入账 + request_count+1。 */
  settleInTx(exec: Queryable, userId: number, usageMonth: string, settlement: AiSettlement): Promise<void>;
  /** 只读查询当月行（不存在返回 undefined，用于 GET /api/ai/usage 与 409 上下文）。 */
  find(userId: number, usageMonth: string): Promise<AiUsageRow | undefined>;
  /** 近 N 个月的用量行（按 usage_month 降序；计费 token 口径；管理后台用户视图）。 */
  listMonthlyByUser(userId: number, months: number): Promise<Array<AiUsageRow & { usageMonth: string }>>;
}

const ROW_COLS =
  'prompt_tokens, completion_tokens, reserved_prompt_tokens, reserved_completion_tokens, request_count';

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function mapRow(r: Record<string, unknown>): AiUsageRow {
  return {
    promptTokens: toCount(r.prompt_tokens),
    completionTokens: toCount(r.completion_tokens),
    reservedPromptTokens: toCount(r.reserved_prompt_tokens),
    reservedCompletionTokens: toCount(r.reserved_completion_tokens),
    requestCount: toCount(r.request_count),
  };
}

export class MysqlAiUsageRepo implements IAiUsageRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async ensureRowInTx(exec: Queryable, userId: number, usageMonth: string): Promise<void> {
    await exec.query(
      'INSERT INTO ai_token_usage (user_id, usage_month) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
      [userId, usageMonth],
    );
  }

  async lockRowInTx(exec: Queryable, userId: number, usageMonth: string): Promise<AiUsageRow> {
    const [rows] = await exec.query<any[]>(
      `SELECT ${ROW_COLS} FROM ai_token_usage WHERE user_id = ? AND usage_month = ? FOR UPDATE`,
      [userId, usageMonth],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    // ensureRowInTx 之后该行必然存在；缺失说明事务/调序被破坏，直接失败而不是静默新建。
    if (!row) throw new Error('ai_token_usage row missing after ensureRowInTx');
    return mapRow(row);
  }

  async addReservationInTx(
    exec: Queryable,
    userId: number,
    usageMonth: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    await exec.query(
      `UPDATE ai_token_usage
          SET reserved_prompt_tokens = reserved_prompt_tokens + ?,
              reserved_completion_tokens = reserved_completion_tokens + ?
        WHERE user_id = ? AND usage_month = ?`,
      [promptTokens, completionTokens, userId, usageMonth],
    );
  }

  async settleInTx(exec: Queryable, userId: number, usageMonth: string, s: AiSettlement): Promise<void> {
    // 释放用 `reserved - LEAST(reserved, x)` 而非 `GREATEST(reserved - x, 0)`：
    // 后者在 x > reserved 时先做无符号减法，MySQL 直接报 "BIGINT UNSIGNED value is out of range"。
    await exec.query(
      `UPDATE ai_token_usage
          SET reserved_prompt_tokens = reserved_prompt_tokens - LEAST(reserved_prompt_tokens, ?),
              reserved_completion_tokens = reserved_completion_tokens - LEAST(reserved_completion_tokens, ?),
              prompt_tokens = prompt_tokens + ?,
              completion_tokens = completion_tokens + ?,
              request_count = request_count + 1
        WHERE user_id = ? AND usage_month = ?`,
      [
        s.releaseReservedPromptTokens,
        s.releaseReservedCompletionTokens,
        s.promptTokens,
        s.completionTokens,
        userId,
        usageMonth,
      ],
    );
  }

  async listMonthlyByUser(userId: number, months: number): Promise<Array<AiUsageRow & { usageMonth: string }>> {
    const [rows] = await this.db().query<any[]>(
      `SELECT usage_month, prompt_tokens, completion_tokens, reserved_prompt_tokens, reserved_completion_tokens, request_count
         FROM ai_token_usage
        WHERE user_id = ?
        ORDER BY usage_month DESC
        LIMIT ${Math.max(1, Math.min(Math.floor(months), 24))}`,
      [userId],
    );
    return rows.map((r: Record<string, unknown>) => ({
      usageMonth: String(r.usage_month),
      promptTokens: Number(r.prompt_tokens ?? 0),
      completionTokens: Number(r.completion_tokens ?? 0),
      reservedPromptTokens: Number(r.reserved_prompt_tokens ?? 0),
      reservedCompletionTokens: Number(r.reserved_completion_tokens ?? 0),
      requestCount: Number(r.request_count ?? 0),
    }));
  }

  async find(userId: number, usageMonth: string): Promise<AiUsageRow | undefined> {
    const [rows] = await this.db().query<any[]>(
      `SELECT ${ROW_COLS} FROM ai_token_usage WHERE user_id = ? AND usage_month = ?`,
      [userId, usageMonth],
    );
    return rows[0] ? mapRow(rows[0] as Record<string, unknown>) : undefined;
  }
}