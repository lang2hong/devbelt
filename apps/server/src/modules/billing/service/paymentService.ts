import { createHash, randomBytes } from 'crypto';
import {
  EntityNotFoundError,
  OrderInvalidStateError,
  OrderNotFoundError,
  PaymentSignatureInvalidError,
  UnknownPlanError,
} from '../../../domain/errors.js';
import type { Order } from '../../../domain/entities.js';
import type { PaymentChannel } from '../../../domain/enums.js';
import type {
  IOrderRepo,
  IPaymentRepo,
  IPaymentCallbackNonceRepo,
  IPlanRepo,
  IPersonalSubscriptionRepo,
} from '../../../repository/interfaces.js';
import type { Queryable, TxRunner } from '../../../repository/mysql/db.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import type { PaymentGateway, PrepayParams } from './paymentChannel.js';

/** 下单后未支付的过期时间（P4 §状态机：30 分钟）。 */
const ORDER_EXPIRES_MS = 30 * 60 * 1000;
/** 创建外部支付意图所需的最小剩余寿命（渠道需能设置有效期，避免过期即失效）。 */
const MIN_ORDER_LIFETIME_MS = 60 * 1000;
/** 付费后权益时长（占位：30 天，上线前按实际时长包调整）。 */
const ENTITLEMENT_PERIOD_MS = 30 * 24 * 3600 * 1000;

export interface CreateOrderResult {
  orderNo: string;
  channel: PaymentChannel;
  amountCents: number;
  payParams: PrepayParams;
}

export type CallbackOutcome =
  | { kind: 'fulfilled'; orderId: number }
  | { kind: 'duplicate' }
  | { kind: 'recorded' }
  | { kind: 'rejected'; code: string };

export interface OrderServiceDeps {
  orderRepo: IOrderRepo;
  paymentRepo: IPaymentRepo;
  planRepo: IPlanRepo;
  personalSubscriptionRepo: IPersonalSubscriptionRepo;
  auditWriter: AuditWriter;
  runner: TxRunner;
  gatewayFor: (channel: PaymentChannel) => PaymentGateway;
  /** 可选：回调 nonce 持久化去重（重放防护）。 */
  nonceRepo?: IPaymentCallbackNonceRepo;
  /**
   * 可选：加油包订单履约（P9.1c）——组合根注入 `AiTopupService.fulfillInTx`
   * （grants 入账 + paid→fulfilled 同事务）。billing 不 import ai 模块，
   * 回调按 `order.purpose` 分发：topup 走此注入，plan 走既有权益路径。
   */
  fulfillTopupInTx?: (tx: Queryable, orderNo: string) => Promise<void>;
}

/**
 * 支付订单服务（P4 切片 2）：下单 + 回调 + 权益生效。
 *
 * 金额一律服务端按 plan_code 计算（分）；回调不依赖 session/cookie，走渠道签名校验，
 * 按 `channel_trade_no` + 订单 `advanced` CAS 幂等；支付成功在同一事务内推进订单并
 * 重写订阅权益（§金额与安全 / §状态机规则）。
 */
export class OrderService {
  private readonly orderRepo: IOrderRepo;
  private readonly paymentRepo: IPaymentRepo;
  private readonly planRepo: IPlanRepo;
  private readonly personalSubscriptionRepo: IPersonalSubscriptionRepo;
  private readonly auditWriter: AuditWriter;
  private readonly runner: TxRunner;
  private readonly gatewayFor: (channel: PaymentChannel) => PaymentGateway;
  private readonly nonceRepo?: IPaymentCallbackNonceRepo;
  private readonly fulfillTopupInTx?: (tx: Queryable, orderNo: string) => Promise<void>

  constructor(deps: OrderServiceDeps) {
    this.orderRepo = deps.orderRepo;
    this.paymentRepo = deps.paymentRepo;
    this.planRepo = deps.planRepo;
    this.personalSubscriptionRepo = deps.personalSubscriptionRepo;
    this.auditWriter = deps.auditWriter;
    this.runner = deps.runner;
    this.gatewayFor = deps.gatewayFor;
    this.nonceRepo = deps.nonceRepo;
    this.fulfillTopupInTx = deps.fulfillTopupInTx;
  }

  /** 下单：优先复用同 (user, plan, channel) 未过期 pending 订单，否则建新订单并预下单。 */
  async createOrder(userId: number, planCode: string, channel: PaymentChannel, mode?: 'qr' | 'redirect'): Promise<CreateOrderResult> {
    // 价格、状态与档位均以库内 plan 为准（不接受前端金额）。
    // priceCents <= 0（free）不可自助下单。
    const plan = await this.planRepo.findByCode(planCode);
    if (!plan || plan.kind !== 'personal' || plan.status !== 'active' || plan.priceCents <= 0) {
      throw new UnknownPlanError();
    }
    const amountCents = plan.priceCents;
    const planVersion = plan.version;
    const gateway = this.gatewayFor(channel);

    // P1b：同人同套餐同渠道的未过期 pending 直接复用，避免双击/重试产生重复付款；
    // channel 纳入复用键，防止复用旧渠道订单却按新渠道生成支付参数（跨渠道错配）。
    const existing = await this.orderRepo.findPendingByUserAndPlan(userId, planCode, channel);
    // P1：复用前校验剩余寿命。渠道有效期只能取整分钟向下取整，若剩余不足 1m 就无法表示
    // 不越过本地 deadline 的外部窗口 —— 此时不复用、改建新单（新单有完整 30m 寿命）。
    if (existing && existing.expiresTime.getTime() - Date.now() >= MIN_ORDER_LIFETIME_MS) {
      const payParams = await gateway.createPayment({ orderNo: existing.orderNo, amountCents: existing.amountCents, expiresTime: existing.expiresTime, mode });
      return { orderNo: existing.orderNo, channel, amountCents: existing.amountCents, payParams };
    }

    // 注意：不因「开了别的渠道」而把旧渠道 pending 置 expired——用户可能已拿到旧渠道
    // 支付码并完成付款，若本地单边宣告过期，回调会「确认付款但不履约」。旧订单自然过期，
    // 后续合法 callback 一律正常履约；多渠道并行订单策略/渠道取消/超时补偿见 Runbook §9。
    const orderNo = randomBytes(16).toString('hex');
    const expiresTime = new Date(Date.now() + ORDER_EXPIRES_MS);

    // 新单固定 ORDER_EXPIRES_MS(=30m) > MIN_ORDER_LIFETIME_MS(=1m)，剩余寿命恒充足，无需重复守卫；
    // 复用路径的剩余寿命校验见上方 existing 分支。
    await this.orderRepo.create({ orderNo, userId, planCode, planVersion, amountCents, channel, expiresTime });
    const payParams = await gateway.createPayment({ orderNo, amountCents, expiresTime, mode });

    this.auditWriter.write({
      eventType: 'payment.order.created',
      result: 'success',
      actorUserId: userId,
      targetType: 'order',
      targetId: orderNo,
    });
    return { orderNo, channel, amountCents, payParams };
  }

  /**
   * 回调处理（事务内幂等）：
   * 1. 验签（失败 → PAYMENT_SIGNATURE_INVALID，4xx，不落库）；
   * 2. 先锁订单行，同 tx 按 channel_trade_no 查重（duplicate 不重复处理）；
   * 3. 金额复核，按状态机推进 pending→paid→fulfilled 并在 paid 后重写订阅权益。
   * 验签通过后的领域失败（金额不符/订单不存在/状态非法/过期）返回 rejected 而非抛错，
   * 使路由能回 200 终止渠道重试。
   */
  async handleCallback(channel: PaymentChannel, rawBody: Buffer, headers: Record<string, string>): Promise<CallbackOutcome> {
    const gateway = this.gatewayFor(channel);
    if (!gateway.verifyCallback(rawBody, headers)) {
      throw new PaymentSignatureInvalidError();
    }
    const parsed = gateway.parseCallback(rawBody);
    // 敏感信息边界：只落渠道适配器产出的白名单脱敏摘要，绝不落原始回调 body/加密信封/完整表单。
    const notification = JSON.stringify(parsed.summary ?? {});

    return this.runner(async (tx) => {
      // 微信回调重放防护：nonce 持久化去重。必须在**同一事务内**记录 —— 若在事务外
      // 先落 nonce，业务步骤失败后 nonce 已提交，渠道重试会被误判为重放并回 ack，
      // 订单永远停在 pending、权益不生效。重复 nonce 直接判 duplicate 终止。
      if (channel === 'wechat' && this.nonceRepo) {
        const nonce = headers['wechatpay-nonce'];
        if (typeof nonce === 'string' && nonce) {
          const nonceHash = createHash('sha256').update(nonce).digest('hex');
          const fresh = await this.nonceRepo.insertIfAbsent(tx, channel, nonceHash, new Date(Date.now() + 30 * 60 * 1000));
          if (!fresh) return { kind: 'duplicate' };
        }
      }
      const order = await this.orderRepo.findByOrderNoForUpdate(tx, parsed.orderNo);
      if (!order) return { kind: 'rejected', code: 'ORDER_NOT_FOUND' };
      if (order.channel !== channel) return { kind: 'rejected', code: 'ORDER_NOT_FOUND' };

      const existing = await this.paymentRepo.findByChannelTradeNo(tx, channel, parsed.channelTradeNo);
      if (existing) return { kind: 'duplicate' };

      if (order.amountCents !== parsed.amountCents) return { kind: 'rejected', code: 'PAYMENT_AMOUNT_MISMATCH' };

      // 支付失败回调：只记流水，不推进订单为 paid。
      if (parsed.status === 'failure') {
        await this.paymentRepo.create(tx, {
          orderId: order.id,
          channel,
          channelTradeNo: parsed.channelTradeNo,
          amountCents: parsed.amountCents,
          notifySummary: notification,
          result: 'failure',
        });
        return { kind: 'recorded' };
      }

      // 已非 pending（已支付/已完成/已过期/已退款）→ 仅记流水，不重复推进。
      if (order.status !== 'pending') {
        await this.paymentRepo.create(tx, {
          orderId: order.id,
          channel,
          channelTradeNo: parsed.channelTradeNo,
          amountCents: parsed.amountCents,
          notifySummary: notification,
          result: 'duplicate',
        });
        return { kind: 'duplicate' };
      }

      // 过期订单：不推进为 paid，记流水 + 审计（付款已发生但本地过期 → 需对账/退款兜底，不静默）。
      if (order.expiresTime <= new Date()) {
        await this.paymentRepo.create(tx, {
          orderId: order.id,
          channel,
          channelTradeNo: parsed.channelTradeNo,
          amountCents: parsed.amountCents,
          notifySummary: notification,
          result: 'failure',
        });
        this.auditWriter.writeInTx(tx, {
          eventType: 'payment.callback.failed',
          result: 'failure',
          failureCode: 'ORDER_EXPIRED',
          actorUserId: order.userId,
          targetType: 'order',
          targetId: order.orderNo,
        });
        return { kind: 'recorded' };
      }

      // 先以 (channel, channel_trade_no) 唯一键插入成功流水，作为跨订单的串行化点：
      // 若另一订单已用同一 trade 插过，本插入触发 ER_DUP_ENTRY —— 回读胜者归属，
      // 属本单则 duplicate，属他单则审计 + rejected，绝不推进本单、绝不把资金回调
      // 交给裸 MySQL 异常（P1）。
      try {
        await this.paymentRepo.create(tx, {
          orderId: order.id,
          channel,
          channelTradeNo: parsed.channelTradeNo,
          amountCents: parsed.amountCents,
          notifySummary: notification,
          result: 'success',
        });
      } catch (e) {
        if (isDuplicateKey(e)) {
          const winner = await this.paymentRepo.findByChannelTradeNo(tx, channel, parsed.channelTradeNo);
          if (winner && winner.orderId === order.id) {
            return { kind: 'duplicate' };
          }
          this.auditWriter.writeInTx(tx, {
            eventType: 'payment.callback.failed',
            result: 'failure',
            failureCode: 'PAYMENT_TRADE_CONFLICT',
            actorUserId: order.userId,
            targetType: 'order',
            targetId: order.orderNo,
          });
          return { kind: 'rejected', code: 'PAYMENT_TRADE_CONFLICT' };
        }
        throw e;
      }

      // 推进 pending → paid。
      const advanced = await this.orderRepo.advance(tx, {
        id: order.id,
        expectedStatus: 'pending',
        status: 'paid',
        channelTradeNo: parsed.channelTradeNo,
        paidTime: new Date(),
      });
      if (!advanced) return { kind: 'rejected', code: 'ORDER_INVALID_STATE' };

      this.auditWriter.writeInTx(tx, {
        eventType: 'payment.order.paid',
        result: 'success',
        actorUserId: order.userId,
        targetType: 'order',
        targetId: order.orderNo,
      });

      // P9.1c：按 purpose 分发履约——topup 走注入的 AiTopupService.fulfillInTx
      // （grants 入账 + paid→fulfilled 同事务，自身幂等）；plan 走既有权益路径。
      if (order.purpose === 'topup') {
        if (!this.fulfillTopupInTx) throw new OrderInvalidStateError('topup fulfillment is not wired');
        await this.fulfillTopupInTx(tx, order.orderNo);
      } else {
        await this.applyEntitlementInTx(tx, order);

        // paid → fulfilled（同一事务）。
        const fulfilled = await this.orderRepo.advance(tx, {
          id: order.id,
          expectedStatus: 'paid',
          status: 'fulfilled',
          channelTradeNo: null,
          paidTime: null,
        });
        if (!fulfilled) throw new OrderInvalidStateError();
      }

      this.auditWriter.writeInTx(tx, {
        eventType: 'payment.order.fulfilled',
        result: 'success',
        actorUserId: order.userId,
        targetType: 'order',
        targetId: order.orderNo,
      });
      return { kind: 'fulfilled', orderId: order.id };
    });
  }

  /** 支付成功后重写订阅权益（同一事务内，锁订阅行 + 乐观版本 CAS）。仅 plan 订单调用（P9.1 topup 不走此路径）。 */
  private async applyEntitlementInTx(tx: Queryable, order: Order): Promise<void> {
    // P9.1：topup 订单无套餐（planCode=null），不进入权益派生；由 AiTopupService 入账 grants。
    if (order.purpose === 'topup' || order.planCode === null) throw new OrderInvalidStateError('topup orders must be fulfilled via AiTopupService, not entitlement apply');
    const plan = await this.planRepo.findByCodeInTx(tx, order.planCode);
    if (!plan || plan.kind !== 'personal' || plan.status !== 'active') throw new UnknownPlanError();
    const sub = await this.personalSubscriptionRepo.findByUserIdForUpdate(tx, order.userId);
    if (!sub) throw new EntityNotFoundError('subscription', order.userId);

    // P2-C：续购从「当前到期日」往后延，不覆盖存量剩余时长（now 与既有到期日取较晚者）。
    // 权益不落库（派生），此处只换 plan 与到期时间。
    const now = new Date();
    const base = sub.periodEndTime && sub.periodEndTime > now ? sub.periodEndTime : now;
    const periodEndTime = new Date(base.getTime() + ENTITLEMENT_PERIOD_MS);
    const ok = await this.personalSubscriptionRepo.update(tx, {
      id: sub.id,
      planId: plan.id,
      status: 'active',
      // 新周期从 base 开始（提前续费时接在旧到期日之后，过期后续费从 now 开始）。
      periodStartTime: base,
      periodEndTime,
      expectedVersion: sub.version,
    });
    if (!ok) throw new OrderInvalidStateError('subscription version conflict');
  }

  /** 用户订单历史。 */
  async listOrders(userId: number, cursor: number | undefined, limit: number): Promise<Order[]> {
    return this.orderRepo.listByUser(userId, cursor, limit);
  }

  /** 按对外订单号读单（归属校验由调用方/路由做，避免订单号枚举）。 */
  async getOrder(userId: number, orderNo: string): Promise<Order> {
    const order = await this.orderRepo.findByOrderNo(orderNo);
    if (!order || order.userId !== userId) throw new OrderNotFoundError();
    return order;
  }
}

/** 唯一键冲突判定（MySQL ER_DUP_ENTRY）。 */
function isDuplicateKey(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'ER_DUP_ENTRY';
}