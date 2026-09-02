import type { IOrganizationSubscriptionRepo } from '../interfaces.js';
import type { OrganizationSubscription } from '../../domain/entities.js';
import type { OrganizationSubscriptionStatus } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/** 组织订阅仓储。当前支持读取和创建组织时写入。 */
export class MysqlOrganizationSubscriptionRepo implements IOrganizationSubscriptionRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findByOrganizationId(organizationId: number): Promise<OrganizationSubscription | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM organization_subscriptions WHERE organization_id = ?',
      [organizationId],
    );
    return rows[0] ? mapSubscription(rows[0]) : undefined;
  }

  async findByOrganizationIdForUpdate(exec: Queryable, organizationId: number): Promise<OrganizationSubscription | undefined> {
    const [rows] = await exec.query<any[]>(
      'SELECT * FROM organization_subscriptions WHERE organization_id = ? FOR UPDATE',
      [organizationId],
    );
    return rows[0] ? mapSubscription(rows[0]) : undefined;
  }

  async create(exec: Queryable, input: {
    organizationId: number;
    planId: number;
    seatLimit: number;
    status: OrganizationSubscriptionStatus;
    entitlementSnapshot: Record<string, unknown>;
    periodStartTime: Date;
    periodEndTime: Date | null;
  }): Promise<OrganizationSubscription> {
    const [result] = await exec.query<any>(
      `INSERT INTO organization_subscriptions (organization_id, plan_id, seat_limit, status, entitlement_snapshot, period_start_time, period_end_time)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.organizationId,
        input.planId,
        input.seatLimit,
        input.status,
        JSON.stringify(input.entitlementSnapshot),
        input.periodStartTime,
        input.periodEndTime ?? null,
      ],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM organization_subscriptions WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('organization_subscription insert failed');
    return mapSubscription(rows[0]);
  }
}

function mapSubscription(r: any): OrganizationSubscription {
  const snapshot = typeof r.entitlement_snapshot === 'string' ? JSON.parse(r.entitlement_snapshot) : r.entitlement_snapshot;
  return {
    id: r.id,
    organizationId: r.organization_id,
    planId: r.plan_id,
    seatLimit: r.seat_limit,
    status: r.status as OrganizationSubscriptionStatus,
    entitlementSnapshot: snapshot ?? {},
    periodStartTime: new Date(r.period_start_time),
    periodEndTime: r.period_end_time ? new Date(r.period_end_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
