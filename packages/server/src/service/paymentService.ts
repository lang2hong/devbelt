import type { ISubscriptionRepo, IUserRepo } from '../repository/interfaces.js';
import type { PaymentProvider, WebhookEvent, PaymentPeriod } from '../adapter/paymentProvider.js';
import type { PlanCode, PaymentProvider as ProviderName } from '../domain/enums.js';
import type { Subscription } from '../domain/entities.js';

/**
 * 支付服务：编排支付适配器 + 订阅状态同步。
 * - renew：admin 手动续费（或后续 webhook 触发）
 * - applyWebhookEvent：支付商回调 → 更新本地订阅 + 套餐
 *
 * 适配器注册式（开闭）：新增支付商只需 registerProvider，不改本类。
 */
export class PaymentService {
  private readonly providers = new Map<ProviderName, PaymentProvider>();

  constructor(
    private readonly subRepo: ISubscriptionRepo,
    private readonly userRepo: IUserRepo,
  ) {}

  registerProvider(provider: PaymentProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** 续费：用指定适配器创建订阅 + 更新本地 + 切换套餐 */
  async renew(userId: number, planCode: PlanCode, period: PaymentPeriod, providerName: ProviderName = 'manual'): Promise<Subscription> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`payment provider not registered: ${providerName}`);
    const { externalId, periodEnd } = await provider.createSubscription(userId, planCode, period);
    const sub = await this.subRepo.upsert({
      userId, planCode, status: 'active', periodEndTime: periodEnd, provider: providerName, externalId,
    });
    await this.userRepo.updatePlan(userId, planCode);
    return sub;
  }

  /** 处理 webhook 原始载荷（路由层调用） */
  async handleWebhook(providerName: ProviderName, payload: Buffer, signature?: string): Promise<void> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`payment provider not registered: ${providerName}`);
    const evt = await provider.handleWebhook(payload, signature);
    await this.applyWebhookEvent(evt);
  }

  /** 应用 webhook 事件：更新本地订阅 + 套餐 */
  async applyWebhookEvent(evt: WebhookEvent): Promise<void> {
    switch (evt.type) {
      case 'subscription_activated':
      case 'subscription_renewed':
        await this.subRepo.upsert({
          userId: evt.userId, planCode: evt.planCode, status: 'active',
          periodEndTime: evt.periodEnd, provider: evt.provider, externalId: evt.externalId,
        });
        await this.userRepo.updatePlan(evt.userId, evt.planCode);
        break;
      case 'subscription_canceled':
      case 'subscription_expired': {
        const cur = await this.subRepo.findByUserId(evt.userId);
        if (cur) {
          await this.subRepo.upsert({
            id: cur.id, userId: evt.userId, planCode: evt.planCode,
            status: evt.type === 'subscription_canceled' ? 'canceled' : 'expired',
            periodEndTime: cur.periodEndTime, provider: evt.provider, externalId: evt.externalId,
            cancelTime: evt.type === 'subscription_canceled' ? new Date() : cur.cancelTime,
          });
        }
        await this.userRepo.updatePlan(evt.userId, 'free');
        break;
      }
    }
  }
}
