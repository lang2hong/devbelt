import type {
  IUserRepo, IPlanRepo, ISubscriptionRepo, IRefreshTokenRepo, IPatRepo, ISyncRepo,
} from '../repository/interfaces.js';
import type { Plan, User, Subscription, Usage } from '../domain/entities.js';
import { EntityNotFoundError } from '../domain/errors.js';

export interface MeResponse {
  user: Omit<User, 'passwordHash'>;
  plan: Plan;
  subscription?: Subscription;
  usage: Usage;
}

/**
 * 订阅服务：到期降级 + /api/me 装配。
 *
 * 到期降级策略：status=active 且 period_end_time < now → status=expired + user.plan_code=free。
 * ensureActive 在每次取用户信息时调用，保证返回最新订阅态。
 * 全局批量降级由 downgradeExpired（定时/启动调用），此处仅做单用户兜底。
 */
export class SubscriptionService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly planRepo: IPlanRepo,
    private readonly subRepo: ISubscriptionRepo,
    private readonly refreshTokenRepo: IRefreshTokenRepo,
    private readonly patRepo: IPatRepo,
    private readonly syncRepo: ISyncRepo,
  ) {}

  /** 确保用户订阅状态最新（到期则降级） */
  async ensureActive(userId: number): Promise<void> {
    const sub = await this.subRepo.findByUserId(userId);
    const now = new Date();
    if (sub && sub.status === 'active' && sub.periodEndTime <= now) {
      await this.subRepo.downgradeExpired(now);
      await this.userRepo.updatePlan(userId, 'free');
    }
  }

  /** 批量降级所有到期订阅（启动/定时调用） */
  async downgradeExpired(): Promise<number> {
    return this.subRepo.downgradeExpired(new Date());
  }

  /** 装配 /api/me 响应：用户 + 套餐 + 订阅 + 配额用量 */
  async getMe(userId: number): Promise<MeResponse> {
    await this.ensureActive(userId);
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('user', userId);
    const plan = await this.planRepo.findByCode(user.planCode);
    if (!plan) throw new Error(`plan not found: ${user.planCode}`);
    const subscription = await this.subRepo.findByUserId(userId);
    const now = new Date();
    const usage: Usage = {
      devices: await this.refreshTokenRepo.countActiveForUser(userId, now),
      connections: 0,   // 客户端维度，server 不可见（同步数据加密）
      syncBytes: await this.syncRepo.sumBytes(userId),
      pats: await this.patRepo.countActiveForUser(userId),
      history: 0,       // 客户端维度
    };
    const { passwordHash, ...safeUser } = user;
    return { user: safeUser, plan, subscription, usage };
  }
}
