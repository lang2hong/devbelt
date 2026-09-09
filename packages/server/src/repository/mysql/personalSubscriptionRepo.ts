import type { IPersonalSubscriptionRepo } from '../interfaces.js';
import type { PersonalSubscription } from '../../domain/entities.js';
import type { PersonalSubscriptionStatus } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/** 个人订阅仓储。支持读取、注册写入与平台乐观订阅调整（§6.2）。 */
export class MysqlPersonalSubscriptionRepo implements IPersonalSubscriptionRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findByUserId(userId: number): Promise<PersonalSubscription | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM personal_subscriptions WHERE user_id = ?',
      [userId],
    );
    return rows[0] ? mapSubscription(rows[0]) : undefined;
  }

  async findByUserIdInTx(exec: Queryable, userId: number): Promise<PersonalSubscription | undefined> {
    const [rows] = await exec.query<any[]>(
      'SELECT * FROM personal_subscriptions WHERE user_id = ?',
      [userId],
    );
    return rows[0] ? mapSubscription(rows[0]) : undefined;
  }

  async findByUserIdForUpdate(exec: Queryable, userId: number): Promise<PersonalSubscription | undefined> {
    const [rows] = await exec.query<any[]>(
      'SELECT * FROM personal_subscriptions WHERE user_id = ? FOR UPDATE',
      [userId],
    );
    return rows[0] ? mapSubscription(rows[0]) : undefined;
  }

  async create(input: {
    userId: number;
    planId: number;
    status: PersonalSubscriptionStatus;
    entitlementSnapshot: Record<string, unknown>;
    periodStartTime: Date;
    periodEndTime: Date | null;
  }): Promise<PersonalSubscription> {
    const [result] = await this.db().query<any>(
      `INSERT INTO personal_subscriptions (user_id, plan_id, status, entitlement_snapshot, period_start_time, period_end_time)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.userId,
        input.planId,
        input.status,
        JSON.stringify(input.entitlementSnapshot),
        input.periodStartTime,
        input.periodEndTime ?? null,
      ],
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('personal_subscription insert failed');
    return created;
  }

  async update(exec: Queryable, input: {
    id: number;
    planId: number;
    status: PersonalSubscriptionStatus;
    entitlementSnapshot: Record<string, unknown>;
    periodEndTime: Date | null;
    expectedVersion: number;
  }): Promise<boolean> {
    const [result] = await exec.query<any>(
      `UPDATE personal_subscriptions
       SET plan_id = ?, status = ?, entitlement_snapshot = ?, period_end_time = ?, version = version + 1
       WHERE id = ? AND version = ?`,
      [
        input.planId,
        input.status,
        JSON.stringify(input.entitlementSnapshot),
        input.periodEndTime ?? null,
        input.id,
        input.expectedVersion,
      ],
    );
    return result.affectedRows === 1;
  }

  private async findById(id: number): Promise<PersonalSubscription | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM personal_subscriptions WHERE id = ?', [id]);
    return rows[0] ? mapSubscription(rows[0]) : undefined;
  }
}

function mapSubscription(r: any): PersonalSubscription {
  const snapshot = typeof r.entitlement_snapshot === 'string' ? JSON.parse(r.entitlement_snapshot) : r.entitlement_snapshot;
  return {
    id: r.id,
    userId: r.user_id,
    planId: r.plan_id,
    status: r.status as PersonalSubscriptionStatus,
    entitlementSnapshot: snapshot ?? {},
    periodStartTime: new Date(r.period_start_time),
    periodEndTime: r.period_end_time ? new Date(r.period_end_time) : null,
    version: Number(r.version ?? 0),
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}