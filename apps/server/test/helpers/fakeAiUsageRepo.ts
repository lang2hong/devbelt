import type { AiSettlement, AiUsageRow, IAiUsageRepo } from '../../src/modules/ai/repository/aiUsageRepo.js';
import type { Queryable, TxRunner } from '../../src/repository/mysql/db.js';

/**
 * 内存版月额度账本（测试用）：整事务串行化，模拟同用户 `SELECT ... FOR UPDATE` 行锁。
 * 真库并发语义由 `test/integration/aiQuota.test.ts` 用 MySQL 验证。
 */
export class MemoryAiUsageRepo implements IAiUsageRepo {
  // 行结构：AiUsageRow + raw（012）。
  private readonly rows = new Map<string, AiUsageRow>();
  private lock: Promise<unknown> = Promise.resolve();

  /** 串行事务执行器（整个事务持锁，对齐真库行锁语义）。 */
  runner(): TxRunner {
    return <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
      const run = this.lock.then(
        () => fn({} as Queryable),
        () => fn({} as Queryable),
      );
      this.lock = run.catch(() => undefined);
      return run;
    };
  }

  private key(userId: number, usageMonth: string): string {
    return `${userId}:${usageMonth}`;
  }

  async listMonthlyByUser(userId: number, months: number): Promise<Array<AiUsageRow & { usageMonth: string }>> {
    const out: Array<AiUsageRow & { usageMonth: string }> = [];
    for (const key of [...this.rows.keys()].sort().reverse()) {
      const [uid, usageMonth] = key.split(':');
      if (Number(uid) !== userId) continue;
      if (out.length >= Math.max(1, Math.min(Math.floor(months), 24))) break;
      out.push({ usageMonth, ...this.rows.get(key)! });
    }
    return out;
  }

  async ensureRowInTx(_exec: Queryable, userId: number, usageMonth: string): Promise<void> {
    if (!this.rows.has(this.key(userId, usageMonth))) {
      this.rows.set(this.key(userId, usageMonth), {
        promptTokens: 0,
        completionTokens: 0,
        rawPromptTokens: 0,
        rawCompletionTokens: 0,
        reservedPromptTokens: 0,
        reservedCompletionTokens: 0,
        requestCount: 0,
      });
    }
  }

  async lockRowInTx(_exec: Queryable, userId: number, usageMonth: string): Promise<AiUsageRow> {
    const row = this.get(userId, usageMonth);
    if (!row) throw new Error('row missing');
    return { ...row };
  }

  async addReservationInTx(
    _exec: Queryable,
    userId: number,
    usageMonth: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    const row = this.get(userId, usageMonth);
    if (!row) throw new Error('row missing');
    row.reservedPromptTokens += promptTokens;
    row.reservedCompletionTokens += completionTokens;
  }

  async settleInTx(_exec: Queryable, userId: number, usageMonth: string, s: AiSettlement): Promise<void> {
    const row = this.get(userId, usageMonth);
    if (!row) throw new Error('row missing');
    row.reservedPromptTokens = Math.max(0, row.reservedPromptTokens - Math.min(row.reservedPromptTokens, s.releaseReservedPromptTokens));
    row.reservedCompletionTokens = Math.max(0, row.reservedCompletionTokens - Math.min(row.reservedCompletionTokens, s.releaseReservedCompletionTokens));
    row.promptTokens += s.promptTokens;
    row.completionTokens += s.completionTokens;
    row.rawPromptTokens = (row.rawPromptTokens ?? 0) + (s.rawPromptTokens ?? s.promptTokens);
    row.rawCompletionTokens = (row.rawCompletionTokens ?? 0) + (s.rawCompletionTokens ?? s.completionTokens);
    row.requestCount += 1;
  }

  async find(userId: number, usageMonth: string): Promise<AiUsageRow | undefined> {
    const row = this.get(userId, usageMonth);
    return row ? { ...row } : undefined;
  }

  /** 测试直写：模拟历史已用额度 / 预占。 */
  seed(
    userId: number,
    usageMonth: string,
    input: Partial<AiUsageRow> = {},
  ): void {
    this.rows.set(this.key(userId, usageMonth), {
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      rawPromptTokens: input.rawPromptTokens ?? 0,
      rawCompletionTokens: input.rawCompletionTokens ?? 0,
      reservedPromptTokens: input.reservedPromptTokens ?? 0,
      reservedCompletionTokens: input.reservedCompletionTokens ?? 0,
      requestCount: input.requestCount ?? 0,
    });
  }

  get(userId: number, usageMonth: string): AiUsageRow | undefined {
    return this.rows.get(this.key(userId, usageMonth));
  }
}