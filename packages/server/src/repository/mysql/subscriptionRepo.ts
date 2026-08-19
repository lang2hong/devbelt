import type { ISubscriptionRepo } from '../interfaces.js';
import type { Subscription } from '../../domain/entities.js';
import type { SubStatus, PaymentProvider, PlanCode } from '../../domain/enums.js';
import { withTransaction, type MysqlDb } from './db.js';

export class MysqlSubscriptionRepo implements ISubscriptionRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findByUserId(userId: number): Promise<Subscription | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM subscriptions WHERE user_id = ?', [userId]);
    return rows[0] ? mapSub(rows[0]) : undefined;
  }

  /**
   * 批量取订阅。一条 `IN (?)` 取代 N 次单查，见 ISubscriptionRepo 的说明。
   *
   * mysql2 对数组参数会展开成逗号分隔的占位符列表，所以这里只需一个 `?`。
   * 空数组必须提前返回：`IN ()` 是语法错误。
   */
  async findByUserIds(userIds: number[]): Promise<Subscription[]> {
    if (userIds.length === 0) return [];
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM subscriptions WHERE user_id IN (?)',
      [userIds],
    );
    return rows.map(mapSub);
  }

  async upsert(sub: Omit<Subscription, 'id' | 'createTime' | 'updateTime'> & { id?: number }): Promise<Subscription> {
    await this.db().query(
      `INSERT INTO subscriptions (user_id, plan_code, status, period_end_time, trial_end_time, cancel_time, provider, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         plan_code = VALUES(plan_code), status = VALUES(status), period_end_time = VALUES(period_end_time),
         trial_end_time = VALUES(trial_end_time), cancel_time = VALUES(cancel_time),
         provider = VALUES(provider), external_id = VALUES(external_id)`,
      [sub.userId, sub.planCode, sub.status, sub.periodEndTime, sub.trialEndTime ?? null, sub.cancelTime ?? null, sub.provider, sub.externalId ?? null],
    );
    const [rows] = await this.db().query<any[]>('SELECT * FROM subscriptions WHERE user_id = ?', [sub.userId]);
    if (!rows[0]) throw new Error('subscription upsert failed');
    return mapSub(rows[0]);
  }

  async listByStatus(status: SubStatus): Promise<Subscription[]> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM subscriptions WHERE status = ?', [status]);
    return rows.map(mapSub);
  }

  async listAll(): Promise<Subscription[]> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM subscriptions ORDER BY create_time DESC');
    return rows.map(mapSub);
  }

  /**
   * 单用户到期降级。
   *
   * `ensureActive` 原先在这里调 `downgradeExpired(now)` —— 一条
   * `UPDATE subscriptions JOIN users` 的**全表**语句。而 ensureActive 挂在
   * `/api/me` 上，每个客户端启动、每次刷新面板都会走一次：一个用户的订阅到期，
   * 就让所有在线用户各自触发一次全表 JOIN UPDATE，并发下互相锁等待。
   *
   * 比较符与 downgradeExpired 统一为 `<=`。此前 service 判 `periodEndTime <= now`
   * 而 SQL 用 `< ?`：periodEndTime 恰好等于 now 时 SQL 一行都不匹配，
   * 旧代码却仍单独执行 `updatePlan(userId, 'free')` —— 留下
   * user.plan_code=free 但 subscription.status=active 的半套状态，
   * 此后每次 /api/me 都重新触发一次全表 UPDATE。
   *
   * 多表 UPDATE 的 affectedRows 是两张表改动行数之和；plan_code 已是 free 时
   * 只计 1（那一行没变化）。所以判据是 `> 0` 而不是 `=== 2`。
   */
  async expireOne(userId: number, now: Date): Promise<boolean> {
    const [result] = await this.db().query<any>(
      `UPDATE subscriptions s
       JOIN users u ON u.id = s.user_id
       SET s.status = 'expired', u.plan_code = 'free'
       WHERE s.user_id = ? AND s.status = 'active' AND s.period_end_time <= ?`,
      [userId, now],
    );
    return (result?.affectedRows ?? 0) > 0;
  }

  /**
   * 全表到期降级（定时任务 / 启动时），返回**降级的订阅行数**。
   *
   * 拆成两条单表 UPDATE 而不是一条 JOIN UPDATE，就为了返回值可信：
   * 多表 UPDATE 的 affectedRows 是各表改动行数之和，plan_code 恰好已是 free
   * 的用户又只计 1 —— 于是「降级了几个人」这个数字既不是 N 也不是 2N，
   * 运维照着它排查会被直接带偏。单表 UPDATE 的 affectedRows 就是行数。
   *
   * 顺序不能反：先改 users（JOIN 条件依赖 subscriptions 仍是 active），
   * 再把 subscriptions 置 expired。事务保证两张表不会只改一半。
   */
  async downgradeExpired(now: Date): Promise<number> {
    return withTransaction(this.db(), async (tx) => {
      await tx.query(
        `UPDATE users u
           JOIN subscriptions s ON s.user_id = u.id
            SET u.plan_code = 'free'
          WHERE s.status = 'active' AND s.period_end_time <= ?`,
        [now],
      );
      const [result] = await tx.query<any>(
        `UPDATE subscriptions SET status = 'expired'
          WHERE status = 'active' AND period_end_time <= ?`,
        [now],
      );
      return result?.affectedRows ?? 0;
    });
  }
}

function mapSub(r: any): Subscription {
  return {
    id: r.id,
    userId: r.user_id,
    planCode: r.plan_code as PlanCode,
    status: r.status as SubStatus,
    periodEndTime: new Date(r.period_end_time),
    trialEndTime: r.trial_end_time ? new Date(r.trial_end_time) : undefined,
    cancelTime: r.cancel_time ? new Date(r.cancel_time) : undefined,
    provider: r.provider as PaymentProvider,
    externalId: r.external_id ?? undefined,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
