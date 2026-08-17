import type { ISubscriptionRepo } from '../interfaces.js';
import type { Subscription } from '../../domain/entities.js';
import type { SubStatus, PaymentProvider, PlanCode } from '../../domain/enums.js';
import type { MysqlDb } from './db.js';

export class MysqlSubscriptionRepo implements ISubscriptionRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findByUserId(userId: number): Promise<Subscription | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM subscriptions WHERE user_id = ?', [userId]);
    return rows[0] ? mapSub(rows[0]) : undefined;
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

  async downgradeExpired(now: Date): Promise<number> {
    const [result] = await this.db().query<any>(
      `UPDATE subscriptions s
       JOIN users u ON u.id = s.user_id
       SET s.status = 'expired', u.plan_code = 'free'
       WHERE s.status = 'active' AND s.period_end_time < ?`,
      [now],
    );
    return result.affectedRows;
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
