import type {
  IUserRepo, IPlanRepo, ISubscriptionRepo, IMembershipRepo, IOrganizationRepo,
  IDeviceRepo, ISyncRepo, IConnectionMetaRepo,
} from '../repository/interfaces.js';
import type { Plan, User, Subscription, Usage } from '../domain/entities.js';
import { EntityNotFoundError } from '../domain/errors.js';
import { EXPIRABLE_STATUSES } from '../domain/enums.js';
import type { PlanPolicy } from '../policy/planPolicy.js';

export interface MeResponse {
  user: Omit<User, 'passwordHash'>;
  plan: Plan;
  plans: Plan[];
  subscription?: Subscription;
  usage: Usage;
}

/**
 * 订阅服务：到期降级 + /api/me 装配。
 *
 * v2：订阅挂组织，个人套餐由「有效席位套餐」推导（PlanPolicy.effectivePlans）。
 * 到期降级按组织逐个 expireOne；全表批量降级 downgradeExpired 由启动/定时调用。
 */
export class SubscriptionService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly planRepo: IPlanRepo,
    private readonly subRepo: ISubscriptionRepo,
    private readonly membershipRepo: IMembershipRepo,
    private readonly organizationRepo: IOrganizationRepo,
    private readonly deviceRepo: IDeviceRepo,
    private readonly syncRepo: ISyncRepo,
    private readonly connectionMetaRepo: IConnectionMetaRepo,
    private readonly planPolicy: PlanPolicy,
  ) {}

  /**
   * 确保**当前用户**相关组织的订阅状态最新（到期则降级）。
   * 只碰该用户活跃成员关系指向的组织，不扫全表。
   *
   * active/canceled 按 periodEndTime 到期；trialing 按 trialEndTime 到期。
   * 试用必须能过期，否则建 team 组织即永久免费 team（付费门禁旁路）。
   */
  async ensureActive(userId: number, now: Date = new Date()): Promise<void> {
    const memberships = await this.membershipRepo.listByUser(userId);
    for (const m of memberships) {
      if (m.status !== 'active') continue;
      const sub = await this.subRepo.findByOrganizationId(m.organizationId);
      if (!sub || !EXPIRABLE_STATUSES.includes(sub.status)) continue;
      const expired = (sub.periodEndTime && sub.periodEndTime <= now)
        || (sub.status === 'trialing' && sub.trialEndTime && sub.trialEndTime <= now);
      if (expired) {
        await this.subRepo.expireOne(m.organizationId, now);
      }
    }
  }

  /** 批量降级所有到期订阅（启动/定时调用），返回降级的订阅行数 */
  async downgradeExpired(now: Date = new Date()): Promise<number> {
    return this.subRepo.downgradeExpired(now);
  }

  /** 装配 /api/me 响应：用户 + 有效套餐 + 全套餐列表 + 订阅 + 配额用量 */
  async getMe(userId: number): Promise<MeResponse> {
    await this.ensureActive(userId);
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('user', userId);

    const effective = await this.planPolicy.effectivePlans(userId);
    const plan = pickPrimaryPlan(effective);
    const plans = await this.planRepo.listAll();
    const subscription = await this.personalSubscription(userId);

    const usage: Usage = {
      devices: await this.deviceRepo.countBound(userId),
      connections: await this.connectionMetaRepo.countActive(userId),
      syncBytes: await this.syncRepo.sumBytes(userId),
      history: 0,       // 客户端维度
    };
    const { passwordHash, ...safeUser } = user;
    return { user: safeUser, plan, plans, subscription, usage };
  }

  /** 取用户 personal org 的当前订阅（显示用；个人套餐由 effectivePlans 决定） */
  private async personalSubscription(userId: number): Promise<Subscription | undefined> {
    const memberships = await this.membershipRepo.listByUser(userId);
    for (const m of memberships) {
      const org = await this.organizationRepo.findById(m.organizationId);
      if (org && org.type === 'personal') {
        return this.subRepo.findByOrganizationId(org.id);
      }
    }
    return undefined;
  }
}

import { pickPrimaryPlan } from './planUtils.js';

