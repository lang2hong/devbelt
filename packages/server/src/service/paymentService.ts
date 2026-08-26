import type {
  ISubscriptionRepo, IOrganizationRepo, IPlanRepo, IOrderRepo, ISeatRepo, IWebhookEventRepo, IMembershipRepo,
} from '../repository/interfaces.js';
import type { PaymentProvider, WebhookEvent, PaymentPeriod } from '../adapter/paymentProvider.js';
import type { PlanCode, PaymentProvider as ProviderName } from '../domain/enums.js';
import type { Subscription } from '../domain/entities.js';
import { EntityNotFoundError, ValidationError } from '../domain/errors.js';

/**
 * 支付服务：编排支付适配器 + 订阅状态同步 + 席位增减。
 * - renew：admin 手动续费（或后续 webhook 触发）
 * - applyWebhookEvent：支付商回调 → 更新本地订阅 + 记订单 + 调整席位
 *
 * v2：订阅与订单挂组织。订单写 seat_delta，席位按 delta 增/撤（订货驱动席位）。
 * 金额暂取套餐基础价；加席的逐席折算属「尚未决策」项（见 docs/数据库设计v2.md §5）。
 */
export class PaymentService {
  private readonly providers = new Map<ProviderName, PaymentProvider>();

  constructor(
    private readonly subRepo: ISubscriptionRepo,
    private readonly orgRepo: IOrganizationRepo,
    private readonly planRepo: IPlanRepo,
    private readonly orderRepo: IOrderRepo,
    private readonly seatRepo: ISeatRepo,
    private readonly eventRepo: IWebhookEventRepo,
    private readonly membershipRepo: IMembershipRepo,
  ) {}

  registerProvider(provider: PaymentProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** 续费：用指定适配器创建订阅 + 更新本地订阅 + 记订单 */
  async renew(
    organizationId: number,
    planCode: PlanCode,
    period: PaymentPeriod,
    providerName: ProviderName = 'manual',
  ): Promise<Subscription> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`payment provider not registered: ${providerName}`);
    const plan = await this.planRepo.findByCode(planCode);
    if (!plan) throw new EntityNotFoundError('plan', planCode);
    const { externalId, periodEnd } = await provider.createSubscription(organizationId, planCode, period);
    const sub = await this.subRepo.upsert({
      organizationId, planId: plan.id, status: 'active',
      periodStartTime: new Date(), periodEndTime: periodEnd, provider: providerName, externalId,
    });
    await this.orderRepo.create({
      organizationId, subscriptionId: sub.id, planId: plan.id,
      amount: period === 'month' ? plan.priceMonth : plan.priceYear, currency: 'CNY',
      status: 'paid', provider: providerName, externalId, seatDelta: 0, periodMonths: period === 'month' ? 1 : 12,
    });
    return sub;
  }

  /** 处理 webhook 原始载荷（路由层调用） */
  async handleWebhook(providerName: ProviderName, payload: Buffer, signature?: string): Promise<void> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`payment provider not registered: ${providerName}`);
    const evt = await provider.handleWebhook(payload, signature);
    await this.applyWebhookEvent(evt);
  }

  /**
   * 应用 webhook 事件：校验 → 去重 → 更新本地订阅 + 记订单 + 调整席位 → 记幂等。
   *
   * 幂等：同一支付商事件到达多次是常态（支付商超时/5xx 必然重试）。
   * 幂等记录写在**处理成功之后**——先记后做的话，一次中途失败会把事件永久
   * 标记为已处理，重试全被挡掉，用户付了钱套餐却没生效。重复投递不抛错（对
   * 支付商必须回 200）。
   */
  async applyWebhookEvent(evt: WebhookEvent): Promise<void> {
    await this.validateEvent(evt);

    const key = eventKeyOf(evt);
    if (await this.eventRepo.seen(evt.provider, key)) return;

    await this.applyEventEffects(evt);

    await this.eventRepo.record(evt.provider, key, {
      type: evt.type,
      organizationId: evt.organizationId,
      planCode: evt.planCode,
      seatDelta: evt.seatDelta,
      externalId: evt.externalId,
      occurredAt: evt.occurredAt?.toISOString(),
    });
  }

  private async validateEvent(evt: WebhookEvent): Promise<void> {
    if (!Number.isInteger(evt.organizationId) || evt.organizationId <= 0) {
      throw new ValidationError(`invalid organizationId in webhook event: ${evt.organizationId}`);
    }
    const org = await this.orgRepo.findById(evt.organizationId);
    if (!org) throw new EntityNotFoundError('organization', evt.organizationId);

    const plan = await this.planRepo.findByCode(evt.planCode);
    if (!plan) throw new ValidationError(`unknown planCode in webhook event: ${evt.planCode}`);
  }

  /** 事件的实际状态变更（校验与去重之后） */
  private async applyEventEffects(evt: WebhookEvent): Promise<void> {
    const plan = await this.planRepo.findByCode(evt.planCode);
    if (!plan) throw new ValidationError(`unknown planCode: ${evt.planCode}`);

    switch (evt.type) {
      case 'subscription_activated':
      case 'subscription_renewed': {
        const sub = await this.subRepo.upsert({
          organizationId: evt.organizationId, planId: plan.id, status: 'active',
          periodStartTime: new Date(), periodEndTime: evt.periodEnd,
          provider: evt.provider, externalId: evt.externalId,
        });
        await this.orderRepo.create({
          organizationId: evt.organizationId, subscriptionId: sub.id, planId: plan.id,
          amount: plan.priceMonth, currency: 'CNY', status: 'paid',
          provider: evt.provider, externalId: evt.externalId,
          seatDelta: evt.seatDelta, periodMonths: 1,
        });
        await this.applySeatDelta(evt.organizationId, sub.id, evt.seatDelta);
        break;
      }
      case 'subscription_canceled':
      case 'subscription_expired': {
        const cur = await this.subRepo.findByOrganizationId(evt.organizationId);
        if (cur) {
          await this.subRepo.upsert({
            id: cur.id, organizationId: evt.organizationId, planId: plan.id,
            status: evt.type === 'subscription_canceled' ? 'canceled' : 'expired',
            periodEndTime: cur.periodEndTime, provider: evt.provider, externalId: evt.externalId,
            cancelTime: evt.type === 'subscription_canceled' ? new Date() : cur.cancelTime,
          });
        }
        break;
      }
    }
  }

  /**
   * 席位增减：正数创建、负数撤销。
   *
   * 撤席受「活跃成员数 ≤ 活跃席位数」约束：最多只能撤到 activeSeats ==
   * activeMembers，再撤会让在用成员失去席位。因此负 delta 的可撤上限是
   * max(0, activeSeats - activeMembers)；超出部分不撤并告警，而不是击穿
   * 约束把人架空。席位是数量，撤席失败不回滚订阅（仍尽力而为）。
   */
  private async applySeatDelta(organizationId: number, subscriptionId: number, seatDelta: number): Promise<void> {
    if (seatDelta > 0) {
      for (let i = 0; i < seatDelta; i++) {
        await this.seatRepo.create({ subscriptionId, organizationId });
      }
    } else if (seatDelta < 0) {
      const seats = await this.seatRepo.listByOrganization(organizationId);
      const active = seats.filter((s) => s.status === 'active');
      const activeMembers = await this.membershipRepo.countActiveByOrganization(organizationId);
      const maxRevoke = Math.max(0, active.length - activeMembers);
      const requested = Math.abs(seatDelta);
      const toRevoke = active.slice(0, Math.min(requested, maxRevoke));
      if (toRevoke.length < requested) {
        console.warn(
          `[payment] seat revocation capped for org ${organizationId}: ` +
          `requested ${requested}, revoked ${toRevoke.length} ` +
          `(activeSeats=${active.length}, activeMembers=${activeMembers})`,
        );
      }
      for (const s of toRevoke) await this.seatRepo.revoke(s.id);
    }
  }
}

/** 幂等键。优先支付商事件 id，缺失时按事件内容摘要（保守方向：少处理可由对账修正） */
function eventKeyOf(evt: WebhookEvent): string {
  if (evt.eventId) return evt.eventId;
  return [
    'digest',
    evt.type,
    evt.organizationId,
    evt.planCode,
    evt.seatDelta,
    evt.externalId,
    evt.periodEnd instanceof Date ? evt.periodEnd.toISOString() : String(evt.periodEnd),
  ].join(':');
}