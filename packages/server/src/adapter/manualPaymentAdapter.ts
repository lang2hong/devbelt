import type { PaymentProvider, PaymentPeriod, WebhookEvent } from './paymentProvider.js';
import type { PlanCode, PaymentProvider as ProviderName } from '../domain/enums.js';

/**
 * 手动支付适配器（admin 手动续费，不接真实支付商）。
 * MVP 阶段唯一实现；生产接 Stripe/LemonSqueezy 时新增适配器并注册。
 */
export class ManualPaymentAdapter implements PaymentProvider {
  readonly name: ProviderName = 'manual';

  async createSubscription(userId: number, _planCode: PlanCode, period: PaymentPeriod): Promise<{ externalId: string; periodEnd: Date }> {
    const days = period === 'year' ? 365 : 30;
    return {
      externalId: `manual-${userId}-${Date.now()}`,
      periodEnd: new Date(Date.now() + days * 86400000),
    };
  }

  async cancelSubscription(_externalId: string): Promise<void> {
    // manual 模式无外部订阅，直接由 PaymentService 更新本地状态
  }

  async handleWebhook(): Promise<WebhookEvent> {
    throw new Error('manual provider has no webhook');
  }
}
