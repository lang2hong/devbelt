import type { IPlanRepo, IPersonalSubscriptionRepo } from '../../../repository/interfaces.js';
import type { TxRunner } from '../../../repository/mysql/db.js';
import { deriveEntitlement } from '../../billing/service/entitlement.js';
import { AiQuotaExceededError } from '../domain/errors.js';
import type { IAiUsageRepo } from '../repository/aiUsageRepo.js';
import type { IAiGrantRepo } from '../repository/aiTopupRepo.js';
import type { IAiRequestLogRepo } from '../repository/aiRequestLogRepo.js';

/** 配额快照（GET /api/ai/usage 与客户端配额条展示用；P9.1 后 `remaining` = 月额度剩余 + 加油包余额）。 */
export interface AiQuotaSnapshot {
  usageMonth: string;
  limit: number;
  used: number;
  reserved: number;
  /** 月段剩余（limit - used - reserved，不含加油包）。 */
  monthlyRemaining: number;
  /** 加油包可用余额（活跃未过期 grants 剩余合计）。 */
  topupRemaining: number;
  /** 合计可用 = monthlyRemaining + topupRemaining（旧字段语义不变：可用总量）。 */
  remaining: number;
  requestCount: number;
  /** 下月 1 日 00:00 UTC（ISO 8601）。 */
  resetAt: string;
}

/** 预占分配到加油包某条 grant 的量（结算按此释放/入账）。 */
export interface AiGrantAllocation {
  grantId: number;
  /** 该 grant 的预占量（prompt+completion 合并池）。 */
  tokens: number;
}

/** 一次流式请求的预占凭据（结算时必须原样回传）。 */
export interface AiReservation {
  userId: number;
  usageMonth: string;
  /** 请求开始时的 prompt 估算（finish usage 缺失时作为入账回退值）。 */
  estimatedPromptTokens: number;
  /** 月段预占（不含 grants；结算释放用）。 */
  reservedPromptTokens: number;
  reservedCompletionTokens: number;
  /** 加油包段预占分配（FIFO 顺序；结算释放/入账用）。 */
  grantAllocations: AiGrantAllocation[];
  limit: number;
  resetAt: string;
}

/**
 * 双段配额计量（P9.1）：月额度 + 加油包 grants 双段 FIFO。
 *
 * 扣减顺序：**月额度优先，不足按 `expires_time` 升序扣 grants**。
 * - 预占（reserve）：事务内锁月额度行；月段不足时才 `FOR UPDATE` 锁活跃 grants（升序），
 *   合计可用 = 月段剩余 + grants 剩余；分配写入 `AiReservation`（月段两腿 + grants 合并池分配）。
 * - 结算（settle）：释放双段预占；实际用量按「月段分配优先、超出部分最多吃满 grants 分配」
 *   入账（grants 永不超过其分配量；超出分配的部分由月段吸收——沿用乐观收窄模型，
 *   理论超发上限 ≈ 单次 completion 封顶 + prompt 估算偏差）。
 * - 并发模型不变：同用户同月/同 grants 行被行锁串行化；超限后下一次请求立即 409。
 */
/** 结算元数据（写 ai_request_log；由转发层提供——含原始 token 与当时计价快照）。 */
export interface AiSettleMeta {
  model: string;
  requestId?: string | null;
  rawPromptTokens: number;
  rawCompletionTokens: number;
  weight: number;
  multiplier: number;
  costCents: number | null;
  status: 'completed' | 'failed' | 'aborted';
  usageEstimated: boolean;
  latencyMs: number;
}

export class AiQuotaService {
  constructor(
    private readonly usageRepo: IAiUsageRepo,
    private readonly grantsRepo: IAiGrantRepo,
    private readonly personalSubscriptionRepo: IPersonalSubscriptionRepo,
    private readonly planRepo: IPlanRepo,
    private readonly runner: TxRunner,
    private readonly now: () => Date = () => new Date(),
    /** 请求流水仓储（012；缺省不记流水——测试装配/旧部署兼容）。 */
    private readonly requestLogRepo?: IAiRequestLogRepo,
  ) {}

  /**
   * 请求开始：预占。合计（月段剩余 + 加油包余额）不足抛 `AiQuotaExceededError` → HTTP 409。
   * 分配顺序：月段优先（prompt 腿先吃、completion 吃剩余），溢出按 grants FIFO（expires_time 升序）
   * 合并池分配；`reserve_*` 均按合计可用收敛。
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
    const now = this.now();

    return this.runner(async (tx) => {
      await this.usageRepo.ensureRowInTx(tx, userId, usageMonth);
      const row = await this.usageRepo.lockRowInTx(tx, userId, usageMonth);
      const used = row.promptTokens + row.completionTokens;
      const reserved = row.reservedPromptTokens + row.reservedCompletionTokens;
      const monthlyRemaining = Math.max(0, limit - used - reserved);

      // 月段不足时才锁 grants（减少争用）；升序保证 FIFO。
      let grantRows: Awaited<ReturnType<IAiGrantRepo['lockActiveInTx']>> = [];
      if (monthlyRemaining < estimatedPromptTokens + maxCompletionTokens) {
        await this.grantsRepo.expireStaleInTx(tx, userId, now);
        grantRows = await this.grantsRepo.lockActiveInTx(tx, userId, now);
      }
      const grantAvailable = grantRows.reduce(
        (n, g) => n + Math.max(0, g.tokensTotal - g.tokensUsed - g.tokensReserved),
        0,
      );
      const available = monthlyRemaining + grantAvailable;
      if (available <= 0) {
        throw new AiQuotaExceededError({ limit, used, reserved, topupRemaining: 0, resetAt });
      }

      const reservedPromptTokens = Math.min(estimatedPromptTokens, available);
      const reservedCompletionTokens = Math.min(maxCompletionTokens, available - reservedPromptTokens);

      // 月段优先分配。
      const monthlyPrompt = Math.min(reservedPromptTokens, monthlyRemaining);
      const monthlyCompletion = Math.min(reservedCompletionTokens, Math.max(0, monthlyRemaining - monthlyPrompt));
      let grantTake = reservedPromptTokens + reservedCompletionTokens - monthlyPrompt - monthlyCompletion;
      const grantAllocations: AiGrantAllocation[] = [];
      for (const g of grantRows) {
        if (grantTake <= 0) break;
        const free = Math.max(0, g.tokensTotal - g.tokensUsed - g.tokensReserved);
        const take = Math.min(free, grantTake);
        if (take <= 0) continue;
        grantTake -= take;
        grantAllocations.push({ grantId: g.id, tokens: take });
        await this.grantsRepo.addReservationInTx(tx, g.id, take);
      }
      await this.usageRepo.addReservationInTx(tx, userId, usageMonth, monthlyPrompt, monthlyCompletion);
      return {
        userId,
        usageMonth,
        estimatedPromptTokens,
        reservedPromptTokens: monthlyPrompt,
        reservedCompletionTokens: monthlyCompletion,
        grantAllocations,
        limit,
        resetAt,
      };
    });
  }

  /**
   * 请求结束（finish/error/abort 都走）：释放双段预占 + 记实际用量 + request_count+1。
   * 入账规则：月段吸收全部实际用量（沿用旧模型）；grants 只吃「超出月段分配」的部分、
   * 每條最多吃满其预占分配（不足分配的部分全额释放）。
   * - finish usage 权威 → 传真实值；usage 缺失/中断 → 传 delta 估算值（调用方在审计行打 `usageEstimated=true`）；
   * - 上游未产生任何 token（HTTP 失败/未及响应）→ 传 0 全额返还双段预留。
   */
  async settle(
    reservation: AiReservation,
    charge: { promptTokens: number; completionTokens: number },
    meta?: AiSettleMeta,
  ): Promise<void> {
    const promptTokens = Math.max(0, Math.floor(charge.promptTokens));
    const completionTokens = Math.max(0, Math.floor(charge.completionTokens));
    const rawPromptTokens = Math.max(0, Math.floor(meta?.rawPromptTokens ?? promptTokens));
    const rawCompletionTokens = Math.max(0, Math.floor(meta?.rawCompletionTokens ?? completionTokens));
    await this.runner(async (tx) => {
      // grants 入账：超出月段分配的合计部分，按分配 FIFO 吃满。
      const total = promptTokens + completionTokens;
      const monthlyAlloc = reservation.reservedPromptTokens + reservation.reservedCompletionTokens;
      let grantCharge = Math.min(
        reservation.grantAllocations.reduce((n, a) => n + a.tokens, 0),
        Math.max(0, total - monthlyAlloc),
      );
      for (const allocation of reservation.grantAllocations) {
        const chargeThis = Math.min(allocation.tokens, grantCharge);
        grantCharge -= chargeThis;
        await this.grantsRepo.settleInTx(tx, allocation.grantId, allocation.tokens, chargeThis);
      }
      await this.usageRepo.settleInTx(tx, reservation.userId, reservation.usageMonth, {
        releaseReservedPromptTokens: reservation.reservedPromptTokens,
        releaseReservedCompletionTokens: reservation.reservedCompletionTokens,
        promptTokens,
        completionTokens,
        rawPromptTokens,
        rawCompletionTokens,
      });
      // 请求流水与配额扣减同事务：同生共死，不漏账不重复（012）。
      if (meta && this.requestLogRepo) {
        await this.requestLogRepo.insertInTx(tx, {
          userId: reservation.userId,
          usageMonth: reservation.usageMonth,
          model: meta.model,
          requestId: meta.requestId ?? null,
          rawPromptTokens,
          rawCompletionTokens,
          billingPromptTokens: promptTokens,
          billingCompletionTokens: completionTokens,
          weight: meta.weight,
          multiplier: meta.multiplier,
          costCents: meta.costCents,
          status: meta.status,
          usageEstimated: meta.usageEstimated,
          latencyMs: meta.latencyMs,
        });
      }
    });
  }

  /** 近 N 个月用量历史（计费 token 口径；按月降序）。 */
  monthlyUsageHistory(userId: number, months = 6): Promise<Array<{ usageMonth: string; promptTokens: number; completionTokens: number; requestCount: number }>> {
    return this.usageRepo.listMonthlyByUser(userId, months).then((rows) =>
      rows.map((r) => ({
        usageMonth: r.usageMonth,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        requestCount: r.requestCount,
      })),
    );
  }

  /** 当月用量快照（无行时全 0；limit 仍按当前权益派生；`remaining` = 月段 + 加油包合计）。 */
  async getUsage(userId: number): Promise<AiQuotaSnapshot> {
    const limit = await this.resolveMonthlyLimit(userId);
    const usageMonth = monthKey(this.now());
    const row = await this.usageRepo.find(userId, usageMonth);
    const used = row ? row.promptTokens + row.completionTokens : 0;
    const reserved = row ? row.reservedPromptTokens + row.reservedCompletionTokens : 0;
    const monthlyRemaining = Math.max(0, limit - used - reserved);
    const availability = await this.grantsRepo.availability(userId, this.now());
    return {
      usageMonth,
      limit,
      used,
      reserved,
      monthlyRemaining,
      topupRemaining: availability.remaining,
      remaining: monthlyRemaining + availability.remaining,
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