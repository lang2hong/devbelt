import type { IPlanRepo, IPersonalSubscriptionRepo } from '../../../repository/interfaces.js';
import type { TxRunner } from '../../../repository/mysql/db.js';
import { deriveEntitlement } from '../../billing/service/entitlement.js';
import { AiQuotaExceededError } from '../domain/errors.js';
import type { IAiUsageRepo } from '../repository/aiUsageRepo.js';

/** 配额快照（GET /api/ai/usage 与客户端配额条展示用）。 */
export interface AiQuotaSnapshot {
  usageMonth: string;
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  requestCount: number;
  /** 下月 1 日 00:00 UTC（ISO 8601）。 */
  resetAt: string;
}

/** 一次流式请求的预占凭据（结算时必须原样回传）。 */
export interface AiReservation {
  userId: number;
  usageMonth: string;
  /** 请求开始时的 prompt 估算（finish usage 缺失时作为入账回退值）。 */
  estimatedPromptTokens: number;
  reservedPromptTokens: number;
  reservedCompletionTokens: number;
  limit: number;
  resetAt: string;
}

/**
 * 单段月额度计量（P9 v1；双段"月额度 + 加油包 grants FIFO"移 P9.1）。
 *
 * 并发模型：请求开始事务内 `ensure-row → SELECT ... FOR UPDATE → 预占`，
 * 同用户并发被行锁串行化；预占是乐观收窄而非硬令牌桶，理论超发上限
 * ≈ 单次 completion 封顶（4K）+ prompt 估算偏差，超限后下一次请求立即 409。
 */
export class AiQuotaService {
  constructor(
    private readonly usageRepo: IAiUsageRepo,
    private readonly personalSubscriptionRepo: IPersonalSubscriptionRepo,
    private readonly planRepo: IPlanRepo,
    private readonly runner: TxRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 请求开始：预占。剩余（含在途预占）不足抛 `AiQuotaExceededError` → HTTP 409。
   * 预占量：`reserve_p = min(estimatedPrompt, remaining)`，
   * `reserve_c = min(maxCompletion, remaining - reserve_p)`。
   */
  async reserve(
    userId: number,
    opts: { estimatedPromptTokens: number; maxCompletionTokens: number },
  ): Promise<AiReservation> {
    const limit = await this.resolveMonthlyLimit(userId);
    const usageMonth = monthKey(this.now());
    const resetAt = resetAtIso(usageMonth);
    const estimatedPromptTokens = Math.max(0, Math.floor(opts.estimatedPromptTokens));
    const maxCompletionTokens = Math.max(0, Math.floor(opts.maxCompletionTokens));

    return this.runner(async (tx) => {
      await this.usageRepo.ensureRowInTx(tx, userId, usageMonth);
      const row = await this.usageRepo.lockRowInTx(tx, userId, usageMonth);
      const used = row.promptTokens + row.completionTokens;
      const reserved = row.reservedPromptTokens + row.reservedCompletionTokens;
      const remaining = limit - used - reserved;
      if (limit <= 0 || remaining <= 0) {
        throw new AiQuotaExceededError({ limit, used, reserved, resetAt });
      }
      const reservedPromptTokens = Math.min(estimatedPromptTokens, remaining);
      const reservedCompletionTokens = Math.min(maxCompletionTokens, remaining - reservedPromptTokens);
      await this.usageRepo.addReservationInTx(tx, userId, usageMonth, reservedPromptTokens, reservedCompletionTokens);
      return {
        userId,
        usageMonth,
        estimatedPromptTokens,
        reservedPromptTokens,
        reservedCompletionTokens,
        limit,
        resetAt,
      };
    });
  }

  /**
   * 请求结束（finish/error/abort 都走）：释放全部预占 + 记实际用量 + request_count+1。
   * - finish usage 权威 → 传真实值；
   * - usage 缺失/中断 → 传 delta 估算值（调用方在审计行打 `usageEstimated=true`）；
   * - 上游未产生任何 token（HTTP 失败/未及响应）→ 传 0 全额返还预留。
   */
  async settle(
    reservation: AiReservation,
    charge: { promptTokens: number; completionTokens: number },
  ): Promise<void> {
    await this.runner(async (tx) => {
      await this.usageRepo.settleInTx(tx, reservation.userId, reservation.usageMonth, {
        releaseReservedPromptTokens: reservation.reservedPromptTokens,
        releaseReservedCompletionTokens: reservation.reservedCompletionTokens,
        promptTokens: Math.max(0, Math.floor(charge.promptTokens)),
        completionTokens: Math.max(0, Math.floor(charge.completionTokens)),
      });
    });
  }

  /** 当月用量快照（无行时全 0；limit 仍按当前权益派生）。 */
  async getUsage(userId: number): Promise<AiQuotaSnapshot> {
    const limit = await this.resolveMonthlyLimit(userId);
    const usageMonth = monthKey(this.now());
    const row = await this.usageRepo.find(userId, usageMonth);
    const used = row ? row.promptTokens + row.completionTokens : 0;
    const reserved = row ? row.reservedPromptTokens + row.reservedCompletionTokens : 0;
    return {
      usageMonth,
      limit,
      used,
      reserved,
      remaining: Math.max(0, limit - used - reserved),
      requestCount: row?.requestCount ?? 0,
      resetAt: resetAtIso(usageMonth),
    };
  }

  /**
   * 当前月额度：由订阅权益派生（`maxAiTokensMonthly`），fail-closed：
   * 订阅缺失/失效回落 free；特性缺失或 ≤0 视为无额度（0，不表示"不限"）。
   */
  async resolveMonthlyLimit(userId: number): Promise<number> {
    const subscription = await this.personalSubscriptionRepo.findByUserId(userId);
    const plan = subscription ? await this.planRepo.findById(subscription.planId) : undefined;
    const freePlan = await this.planRepo.findByCode('free');
    const entitlement = deriveEntitlement(subscription, plan, freePlan);
    const raw = entitlement.maxAiTokensMonthly;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }
}

/** UTC 月份键（`YYYY-MM`）；账本按月分桶，下月 1 日 UTC 自动"重置"。 */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 月份键 → 下月 1 日 00:00 UTC（ISO 8601）。 */
export function resetAtIso(usageMonth: string): string {
  const [year, month] = usageMonth.split('-').map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 0 : month;
  return new Date(Date.UTC(nextYear, nextMonth, 1)).toISOString();
}