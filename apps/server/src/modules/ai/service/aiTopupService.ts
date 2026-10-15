import { randomBytes } from 'crypto';
import type { Queryable, TxRunner } from '../../../repository/mysql/db.js';
import type { AiGrantDetail, IAiTopupRepo, AiGrantAvailability, AiTopupOrder, AiTopupSku } from '../repository/aiTopupRepo.js';
import { TopupOrderNotFoundError, TopupOrderStateError, TopupSkuNotFoundError } from '../domain/errors.js';
import type { PrepayParams, PaymentGateway } from '../../billing/service/paymentChannel.js';
import type { PaymentChannel } from '../../../domain/enums.js';

/**
 * AI 加油包服务（P9.1）：SKU 目录 + 订单入账 + 退款撤销 + 余额查询。
 *
 * 资金/账本不变量：
 * - **订单是唯一资金事实源**；grants 入账与订单 fulfilled 推进**同事务**；
 * - **幂等（D17）**：`uq_grants_order` + `ON DUPLICATE KEY UPDATE id = id`，fulfill 重放为 no-op，
 *   订单状态机在行锁内判定（pending/paid → fulfilled；fulfilled → 幂等返回）；
 * - **manual 退款只撤销额度**（grants 剩余作废、used 保留审计），不发起渠道退款；
 * - 过期基线：`now + sku.validDays`（入账时刻起算）。
 *
 * 事务形态（P9.1b）：核心操作以 `*InTx` 暴露（并入调用方事务——管理后台写走幂等回执
 * business tx，渠道回调走回调事务）；自持 runner 的公开方法仅作薄壳（扩展侧路由/内部调用）。
 */

export interface TopupOrderResult {
  orderNo: string;
  userId: number;
  skuCode: string;
  tokens: number;
  amountCents: number;
  status: 'pending' | 'paid' | 'fulfilled' | 'failed' | 'refunded' | 'expired';
  /** 本次是否新入账了一条 grant（false = 幂等重放/已入账过）。 */
  grantInserted: boolean;
}

export class AiTopupService {
  constructor(
    private readonly repo: IAiTopupRepo,
    private readonly runner: TxRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 上架 SKU（用户侧购买页/客户端展示）。 */
  async listSkus(): Promise<AiTopupSku[]> {
    return this.repo.listActiveSkus();
  }

  /** 全量 SKU（含停用；管理后台 SKU 管理，P9.1b）。 */
  async listAllSkus(): Promise<AiTopupSku[]> {
    return this.repo.listSkusAll();
  }

  /** 用户全部 grants（含历史状态；管理后台配额明细，P9.1b）。 */
  async listGrants(userId: number, limit = 50): Promise<AiGrantDetail[]> {
    return this.repo.listGrantsByUser(userId, limit);
  }

  /** 事务内按 code 查 SKU（幂等回执 business 内的当前价读取，P9.1b）。 */
  async findSkuInTx(tx: Queryable, code: string): Promise<AiTopupSku | undefined> {
    return this.repo.findSkuByCodeInTx(tx, code);
  }

  /** 事务内更新 SKU（价格/状态/文案/有效期/排序；管理后台，P9.1b）。审计由 admin 路由层落。 */
  async updateSkuInTx(
    tx: Queryable,
    code: string,
    patch: { priceCents?: number; status?: 'active' | 'disabled'; label?: { en: string; zh: string }; validDays?: number; sortOrder?: number },
  ): Promise<boolean> {
    return this.repo.updateSkuInTx(tx, code, patch);
  }

  /**
   * 管理后台手工建单（channel='manual'）：建单即 fulfilled 并同事务入账。
   * 审计（actor/reason）由 admin 路由层落 audit_events（P9.1b）。
   */
  async createManualOrder(input: { userId: number; skuCode: string }): Promise<TopupOrderResult> {
    return this.runner((tx) => this.createManualOrderInTx(tx, input));
  }

  /**
   * 渠道订单入账（支付回调/管理后台重试，P9.1b 接线）：`paid → fulfilled` + grant 入账同事务。
   * 幂等：已 fulfilled 直接返回（grantInserted=false）；已 refunded 抛状态错（防退款后重放入账）。
   */
  async fulfill(orderNo: string): Promise<TopupOrderResult> {
    return this.runner((tx) => this.fulfillInTx(tx, orderNo));
  }

  /**
   * 退款（manual 语义）：仅撤销额度——grants 剩余作废（used 保留审计）、订单 → refunded；
   * 不发起渠道退款。仅 fulfilled 可退；重复调用幂等。
   */
  async refund(orderNo: string): Promise<TopupOrderResult> {
    return this.runner((tx) => this.refundInTx(tx, orderNo));
  }

  /** 用户加油包可用余额（配额快照/409 上下文/购买页展示用）。 */
  async grantBalance(userId: number): Promise<AiGrantAvailability> {
    return this.repo.availability(userId, this.now());
  }

  /**
   * 用户侧渠道下单（P9.1c，复用 P4 收银台语义）：
   * - 价格以库内 SKU 为准（不接受前端金额）；
   * - 同人同 SKU 同渠道未过期 pending 直接复用（剩余寿命 ≥1m 才复用，P1b），
   *   防双击/重试重复付款；
   * - prepay 是事务外副作用，故本方法**不落回执事务**（对齐 OrderService.createOrder 决策）；
   * - 多渠道并行不互相作废：旧渠道订单自然过期，合法回调一律履约。
   */
  async createChannelOrder(
    input: { userId: number; skuCode: string; channel: PaymentChannel; mode?: 'qr' | 'redirect' },
    deps: {
      /** 非事务执行器（连接池直写：单条 INSERT，无需事务包裹）。 */
      exec: Queryable;
      gatewayFor: (channel: PaymentChannel) => PaymentGateway;
      /** 订单寿命（对齐 P4 的 30m）。 */
      expiresMs: number;
      /** pending 复用的最小剩余寿命（对齐 P4 的 1m）。 */
      minLifetimeMs: number;
      auditWrite: (orderNo: string, amountCents: number) => void;
    },
  ): Promise<{ order: AiTopupOrder; payParams: PrepayParams }> {
    const sku = await this.repo.findSkuByCode(input.skuCode);
    if (!sku || sku.status !== 'active' || sku.priceCents <= 0) throw new TopupSkuNotFoundError(input.skuCode);
    const gateway = deps.gatewayFor(input.channel);

    const existing = await this.repo.findPendingByUserAndSku(input.userId, sku.code, input.channel);
    if (existing && existing.expiresTime.getTime() - Date.now() >= deps.minLifetimeMs) {
      const payParams = await gateway.createPayment({
        orderNo: existing.orderNo,
        amountCents: existing.amountCents,
        expiresTime: existing.expiresTime,
        mode: input.mode,
      });
      return { order: existing, payParams };
    }

    const orderNo = mintOrderNo();
    const expiresTime = new Date(Date.now() + deps.expiresMs);
    const order = await this.repo.insertTopupOrderInTx(deps.exec, {
      orderNo,
      userId: input.userId,
      skuCode: sku.code,
      amountCents: sku.priceCents,
      channel: input.channel,
      status: 'pending',
      expiresTime,
    });
    const payParams = await gateway.createPayment({
      orderNo,
      amountCents: sku.priceCents,
      expiresTime,
      mode: input.mode,
    });
    deps.auditWrite(orderNo, sku.priceCents);
    return { order, payParams };
  }

  // ── InTx 核心（并入调用方事务；管理后台幂等回执/渠道回调用）──

  async createManualOrderInTx(tx: Queryable, input: { userId: number; skuCode: string }): Promise<TopupOrderResult> {
    const sku = await this.repo.findSkuByCode(input.skuCode);
    if (!sku || sku.status !== 'active') throw new TopupSkuNotFoundError(input.skuCode);
    const now = this.now();
    const expiresTime = grantExpiry(now, sku.validDays);
    const orderNo = mintOrderNo();
    const order = await this.repo.insertTopupOrderInTx(tx, {
      orderNo,
      userId: input.userId,
      skuCode: sku.code,
      amountCents: sku.priceCents,
      channel: 'manual',
      status: 'fulfilled',
      expiresTime,
    });
    const grantInserted = await this.repo.insertGrantInTx(tx, {
      userId: input.userId,
      orderId: order.id,
      skuCode: sku.code,
      tokens: sku.tokens,
      expiresTime,
    });
    return {
      orderNo,
      userId: input.userId,
      skuCode: sku.code,
      tokens: sku.tokens,
      amountCents: sku.priceCents,
      status: 'fulfilled' as const,
      grantInserted,
    };
  }

  async fulfillInTx(tx: Queryable, orderNo: string): Promise<TopupOrderResult> {
    const order = await this.repo.lockOrderByNoInTx(tx, orderNo);
    if (!order) throw new TopupOrderNotFoundError(orderNo);
    const sku = await this.repo.findSkuByCode(order.skuCode);
    if (!sku) throw new TopupSkuNotFoundError(order.skuCode);

    if (order.status === 'fulfilled') {
      return { ...toResult(order, sku.tokens), grantInserted: false };
    }
    if (order.status !== 'paid') {
      throw new TopupOrderStateError(orderNo, `order is ${order.status}; fulfill requires paid`);
    }
    const expiresTime = grantExpiry(this.now(), sku.validDays);
    const grantInserted = await this.repo.insertGrantInTx(tx, {
      userId: order.userId,
      orderId: order.id,
      skuCode: order.skuCode,
      tokens: sku.tokens,
      expiresTime,
    });
    await this.repo.setOrderStatusInTx(tx, order.id, 'paid', 'fulfilled');
    return { ...toResult(order, sku.tokens), status: 'fulfilled' as const, grantInserted };
  }

  async refundInTx(tx: Queryable, orderNo: string): Promise<TopupOrderResult> {
    const order = await this.repo.lockOrderByNoInTx(tx, orderNo);
    if (!order) throw new TopupOrderNotFoundError(orderNo);
    const sku = await this.repo.findSkuByCode(order.skuCode);
    const tokens = sku?.tokens ?? 0;
    if (order.status === 'refunded') {
      return { ...toResult(order, tokens), grantInserted: false };
    }
    if (order.status !== 'fulfilled') {
      throw new TopupOrderStateError(orderNo, `order is ${order.status}; refund requires fulfilled`);
    }
    await this.repo.refundGrantByOrderInTx(tx, order.id);
    await this.repo.setOrderStatusInTx(tx, order.id, 'fulfilled', 'refunded');
    return { ...toResult(order, tokens), status: 'refunded' as const, grantInserted: false };
  }
}

/** 入账起算的过期时刻（UTC）。 */
function grantExpiry(now: Date, validDays: number): Date {
  return new Date(now.getTime() + Math.max(1, validDays) * 24 * 60 * 60 * 1000);
}

function mintOrderNo(): string {
  return randomBytes(16).toString('hex');
}

function toResult(order: { orderNo: string; userId: number; skuCode: string; amountCents: number; status: TopupOrderResult['status'] }, tokens: number): Omit<TopupOrderResult, 'grantInserted'> {
  return {
    orderNo: order.orderNo,
    userId: order.userId,
    skuCode: order.skuCode,
    tokens,
    amountCents: order.amountCents,
    status: order.status,
  };
}