import type { PlanCode, PaymentProvider as ProviderName } from '../domain/enums.js';

export type PaymentPeriod = 'month' | 'year';

export interface WebhookEvent {
  type: 'subscription_activated' | 'subscription_renewed' | 'subscription_canceled' | 'subscription_expired';
  userId: number;
  planCode: PlanCode;
  periodEnd: Date;
  externalId: string;
  provider: ProviderName;
}

/**
 * 支付商适配器接口（Adapter 模式）。
 * 不同支付商实现此接口，PaymentService 通过统一接口编排。
 * MVP 仅 ManualPaymentAdapter；接 Stripe/LemonSqueezy 时新增实现。
 */
export interface PaymentProvider {
  readonly name: ProviderName;
  /** 创建/同步订阅，返回外部 ID 与到期时间 */
  createSubscription(userId: number, planCode: PlanCode, period: PaymentPeriod): Promise<{ externalId: string; periodEnd: Date }>;
  /** 取消订阅（预约期末取消） */
  cancelSubscription(externalId: string): Promise<void>;
  /** 解析 webhook 原始载荷（含验签）→ 标准事件 */
  handleWebhook(payload: Buffer, signature?: string): Promise<WebhookEvent>;
}
