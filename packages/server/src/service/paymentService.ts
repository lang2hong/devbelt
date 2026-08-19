import type {
  ISubscriptionRepo, IUserRepo, IPlanRepo, IWebhookEventRepo,
} from '../repository/interfaces.js';
import type { PaymentProvider, WebhookEvent, PaymentPeriod } from '../adapter/paymentProvider.js';
import type { PlanCode, PaymentProvider as ProviderName } from '../domain/enums.js';
import type { Subscription } from '../domain/entities.js';
import { EntityNotFoundError, ValidationError } from '../domain/errors.js';

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
    private readonly planRepo: IPlanRepo,
    private readonly eventRepo: IWebhookEventRepo,
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

  /**
   * 应用 webhook 事件：校验 → 去重 → 更新本地订阅 + 套餐 → 记幂等。
   *
   * ## 为什么必须校验
   *
   * 入参来自**支付商发来的载荷**（经适配器解析）。验签只证明"这条消息来自
   * 支付商"，不证明里面的字段是本系统认得的值：
   *
   *  - `planCode` 任意字符串 → `users.plan_code` 无外键指向 `plans.code`
   *    → 孤儿套餐码 → 此后每次 `/api/me` 因 `plan not found` 抛裸 Error 变 500。
   *    用户彻底用不了，排查还要从"支付商发来什么"一路倒推。
   *    admin 侧早就做了白名单（adminService.updateUser），webhook 侧没做 ——
   *    同一个字段两条写入路径只有一条设防。
   *  - `userId` 不存在 → 靠数据库外键报错，表现为 500 而不是明确拒绝。
   *
   * 白名单取自 plans 表而不是硬编码字面量：后台能新增套餐码，硬编码会让
   * 新套餐的回调被误拒。
   *
   * ## 为什么必须去重
   *
   * 支付商在请求超时或收到 5xx 时**必然重试**（Stripe 持续重试到 3 天），
   * 同一事件到达多次是常态。`subscription_renewed` 处理两次就把周期延长
   * 两倍 —— 白送一个月。
   *
   * 幂等记录写在**处理成功之后**。先记后做的话，一次中途失败（DB 抖动）会让
   * 该事件被永久标记为已处理，支付商的重试全被挡掉，用户付了钱但套餐没生效，
   * 而且再没有重试机会 —— 那比重复处理更难发现、更难补救。
   *
   * 重复投递**不抛错**：对支付商必须回 200，否则它会一直重试同一个已处理的事件。
   */
  async applyWebhookEvent(evt: WebhookEvent): Promise<void> {
    await this.validateEvent(evt);

    const key = eventKeyOf(evt);
    if (await this.eventRepo.seen(evt.provider, key)) return;

    await this.applyEventEffects(evt);

    await this.eventRepo.record(evt.provider, key, {
      type: evt.type,
      userId: evt.userId,
      planCode: evt.planCode,
      externalId: evt.externalId,
      occurredAt: evt.occurredAt?.toISOString(),
    });
  }

  /**
   * 落库前校验。任何一项不过就整体拒绝 —— 部分生效比完全不生效更难排查
   * （没有事务，只能靠前置校验保证原子性）。
   */
  private async validateEvent(evt: WebhookEvent): Promise<void> {
    if (!Number.isInteger(evt.userId) || evt.userId <= 0) {
      throw new ValidationError(`invalid userId in webhook event: ${evt.userId}`);
    }
    const user = await this.userRepo.findById(evt.userId);
    if (!user) throw new EntityNotFoundError('user', evt.userId);

    const plan = await this.planRepo.findByCode(evt.planCode);
    if (!plan) throw new ValidationError(`unknown planCode in webhook event: ${evt.planCode}`);
  }

  /** 事件的实际状态变更（校验与去重之后） */
  private async applyEventEffects(evt: WebhookEvent): Promise<void> {
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

/**
 * 幂等键。
 *
 * 优先用支付商的事件 id。缺失时（并非所有支付商都提供）退回按事件内容摘要：
 * 同样的 (type, userId, planCode, externalId, periodEnd) 视为同一事件。
 * 摘要方案不如 eventId 精确 —— 一个用户在同一秒被续费两次会被误判为重复 ——
 * 但这个方向的误差是安全的：少处理一次可由后续事件或对账修正，
 * 而多处理一次是直接的收入损失。
 */
function eventKeyOf(evt: WebhookEvent): string {
  if (evt.eventId) return evt.eventId;
  return [
    'digest',
    evt.type,
    evt.userId,
    evt.planCode,
    evt.externalId,
    evt.periodEnd instanceof Date ? evt.periodEnd.toISOString() : String(evt.periodEnd),
  ].join(':');
}
