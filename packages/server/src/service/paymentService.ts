import { randomBytes } from 'crypto';
import {
  EntityNotFoundError,
  OrderInvalidStateError,
  OrderNotFoundError,
  PaymentSignatureInvalidError,
  UnknownPlanError,
} from '../domain/errors.js';
import type { Order, PersonalPlan } from '../domain/entities.js';
import type { PaymentChannel } from '../domain/enums.js';
import type {
  IOrderRepo,
  IPaymentRepo,
  IPersonalPlanRepo,
  IPersonalSubscriptionRepo,
} from '../repository/interfaces.js';
import type { Queryable, TxRunner } from '../repository/mysql/db.js';
import type { AuditWriter } from './auditWriter.js';
import { resolvePriceCents } from './pricing.js';
import type { PaymentGateway, PrepayParams } from './paymentChannel.js';

/** 下单后未支付的过期时间（P4 §状态机：30 分钟）。 */
const ORDER_EXPIRES_MS = 30 * 60 * 1000;
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
  personalPlanRepo: IPersonalPlanRepo;
  personalSubscriptionRepo: IPersonalSubscriptionRepo;
  auditWriter: AuditWriter;
  runner: TxRunner;
  gatewayFor: (channel: PaymentChannel) => PaymentGateway;
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
  private readonly personalPlanRepo: IPersonalPlanRepo;
  private readonly personalSubscriptionRepo: IPersonalSubscriptionRepo;
  private readonly auditWriter: AuditWriter;
  private readonly runner: TxRunner;
  private readonly gatewayFor: (channel: PaymentChannel) => PaymentGateway;

  constructor(deps: OrderServiceDeps) {
    this.orderRepo = deps.orderRepo;
    this.paymentRepo = deps.paymentRepo;
    this.personalPlanRepo = deps.personalPlanRepo;
    this.personalSubscriptionRepo = deps.personalSubscriptionRepo;
    this.auditWriter = deps.auditWriter;
    this.runner = deps.runner;
    this.gatewayFor = deps.gatewayFor;
  }

  /** 下单：优先复用同 (user, plan, channel) 未过期 pending 订单，否则建新订单并预下单。 */
  async createOrder(userId: number, planCode: string, channel: PaymentChannel): Promise<CreateOrderResult> {
    const amountCents = resolvePriceCents(planCode);
    const gateway = this.gatewayFor(channel);

    // P1b：同人同套餐同渠道的未过期 pending 直接复用，避免双击/重试产生重复付款；
    // channel 纳入复用键，防止复用旧渠道订单却按新渠道生成支付参数（跨渠道错配）。
    const existing = await this.orderRepo.findPendingByUserAndPlan(userId, planCode, channel);
    if (existing) {
      const payParams = await gateway.createPayment({ orderNo: existing.orderNo, amountCents: existing.amountCents });
      return { orderNo: existing.orderNo, channel, amountCents: existing.amountCents, payParams };
    }

    // P2-E：开启新渠道订单前，过期同 (user, plan) 其他渠道的 pending，维持
    // 「同一套餐同一时刻仅一张可支付 pending」（跨渠道且付款会重复收款）。
    await this.orderRepo.expirePendingByUserAndPlanExcept(userId, planCode, channel);

    const orderNo = randomBytes(32).toString('base64url');
    const expiresTime = new Date(Date.now() + ORDER_EXPIRES_MS);

    await this.orderRepo.create({ orderNo, userId, planCode, amountCents, channel, expiresTime });
    const payParams = await gateway.createPayment({ orderNo, amountCents });

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
    const notification = rawBody.toString('utf8').slice(0, 4000);

    return this.runner(async (tx) => {
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
          rawNotification: notification,
          signatureVerified: true,
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
          rawNotification: notification,
          signatureVerified: true,
          result: 'duplicate',
        });
        return { kind: 'duplicate' };
      }

      // 过期订单：不推进为 paid，记流水。
      if (order.expiresTime <= new Date()) {
        await this.paymentRepo.create(tx, {
          orderId: order.id,
          channel,
          channelTradeNo: parsed.channelTradeNo,
          amountCents: parsed.amountCents,
          rawNotification: notification,
          signatureVerified: true,
          result: 'failure',
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
          rawNotification: notification,
          signatureVerified: true,
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

  /** 支付成功后重写订阅权益（同一事务内，锁订阅行 + 乐观版本 CAS）。 */
  private async applyEntitlementInTx(tx: Queryable, order: Order): Promise<void> {
    const plan = await this.personalPlanRepo.findByCodeInTx(tx, order.planCode);
    if (!plan || plan.status !== 'active') throw new UnknownPlanError();
    const sub = await this.personalSubscriptionRepo.findByUserIdForUpdate(tx, order.userId);
    if (!sub) throw new EntityNotFoundError('subscription', order.userId);

    const snapshot = personalEntitlementSnapshot(plan);
    // P2-C：续购从「当前到期日」往后延，不覆盖存量剩余时长（now 与既有到期日取较晚者）。
    const now = new Date();
    const base = sub.periodEndTime && sub.periodEndTime > now ? sub.periodEndTime : now;
    const periodEndTime = new Date(base.getTime() + ENTITLEMENT_PERIOD_MS);
    const ok = await this.personalSubscriptionRepo.update(tx, {
      id: sub.id,
      planId: plan.id,
      status: 'active',
      entitlementSnapshot: snapshot,
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

/** 从个人 plan 构造冻结权益快照（与注册/admin 调整口径一致）。 */
export function personalEntitlementSnapshot(plan: PersonalPlan): Record<string, unknown> {
  return {
    allowedDatabaseTypes: plan.allowedDatabaseTypes,
    maxDevices: plan.maxDevices,
    maxConnectionMetas: plan.maxConnectionMetas,
    syncStorageBytes: plan.syncStorageBytes,
    maxSavedConnections: plan.maxSavedConnections,
    allowConnectionImport: plan.allowConnectionImport,
  };
}

/** 唯一键冲突判定（MySQL ER_DUP_ENTRY）。 */
function isDuplicateKey(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'ER_DUP_ENTRY';
}