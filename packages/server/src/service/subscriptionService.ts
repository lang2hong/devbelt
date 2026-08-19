import type {
  IUserRepo, IPlanRepo, ISubscriptionRepo, IRefreshTokenRepo, ISyncRepo, IConnectionMetaRepo,
} from '../repository/interfaces.js';
import type { Plan, User, Subscription, Usage } from '../domain/entities.js';
import { EntityNotFoundError } from '../domain/errors.js';
import { EXPIRABLE_STATUSES } from '../domain/enums.js';

export interface MeResponse {
  user: Omit<User, 'passwordHash'>;
  plan: Plan;
  subscription?: Subscription;
  usage: Usage;
}

/**
 * 订阅服务：到期降级 + /api/me 装配。
 *
 * 到期降级策略：status=active 且 period_end_time <= now → status=expired + user.plan_code=free。
 * `<=` 而非 `<`：periodEndTime 是周期的**结束时刻**，到达即结束；列是秒精度的
 * TIMESTAMP，用 `<` 会让整个第 N 秒仍算有效。service 判据与两条 SQL 现在
 * 全部统一到 `<=`（此前 service 用 `<=`、SQL 用 `<`，边界上互相打架）。
 *
 * ensureActive 走单用户 expireOne（挂在 /api/me 上，不能扫全表）；
 * 全表批量降级是 downgradeExpired，由启动与定时清理任务调用。
 */
export class SubscriptionService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly planRepo: IPlanRepo,
    private readonly subRepo: ISubscriptionRepo,
    private readonly refreshTokenRepo: IRefreshTokenRepo,
    private readonly syncRepo: ISyncRepo,
    private readonly connectionMetaRepo: IConnectionMetaRepo,
  ) {}

  /**
   * 确保**当前用户**订阅状态最新（到期则降级）。
   *
   * 只碰这一个用户。旧实现在这里调全表 `downgradeExpired`，而本方法挂在
   * `/api/me` 上：一个用户到期就让所有在线用户各自触发一次全表 JOIN UPDATE。
   *
   * 状态与套餐由 `expireOne` 一条语句一起改，不再另外调 `updatePlan` ——
   * 分开写时 SQL 没匹配到行、updatePlan 却照样执行，会留下
   * plan_code=free 但 status=active 的半套状态。
   *
   * now 可注入，供测试构造「恰好等于周期结束时刻」的边界。
   */
  async ensureActive(userId: number, now: Date = new Date()): Promise<void> {
    const sub = await this.subRepo.findByUserId(userId);
    // 与 repo 的 EXPIRABLE_STATUSES 对齐：trialing 与 canceled 到期同样要降级。
    // 只判 'active' 时，注册写下的 trialing 行永远不会被处理 ——
    // 用户 7 天后 /api/me 里仍显示"试用中"，而这些行也永不被索引扫到。
    if (!sub || !EXPIRABLE_STATUSES.includes(sub.status)) return;
    if (sub.periodEndTime > now) return;
    await this.subRepo.expireOne(userId, now);
  }

  /** 批量降级所有到期订阅（启动/定时调用），返回降级的订阅行数 */
  async downgradeExpired(now: Date = new Date()): Promise<number> {
    return this.subRepo.downgradeExpired(now);
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
      connections: await this.connectionMetaRepo.countActive(userId),
      syncBytes: await this.syncRepo.sumBytes(userId),
      history: 0,       // 客户端维度
    };
    const { passwordHash, ...safeUser } = user;
    return { user: safeUser, plan, subscription, usage };
  }
}
