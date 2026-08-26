import type { ISubscriptionRepo } from '../interfaces.js';
import type { Subscription } from '../../domain/entities.js';
import type { SubStatus, PaymentProvider } from '../../domain/enums.js';
import { EXPIRABLE_STATUSES } from '../../domain/enums.js';
import { type MysqlDb } from './db.js';

/** `IN (?, ?, ?)` 的占位符，随 EXPIRABLE_STATUSES 长度自动对齐 */
const EXPIRABLE_PLACEHOLDERS = EXPIRABLE_STATUSES.map(() => '?').join(', ');

/**
 * 订阅仓库。v2：订阅挂组织（organization_id + plan_id），一组织一条当前订阅
 * （UNIQUE organization_id）。到期降级只置 status=expired，不再改 users.plan_code。
 */
export class MysqlSubscriptionRepo implements ISubscriptionRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findByOrganizationId(organizationId: number): Promise<Subscription | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM subscriptions WHERE organization_id = ?', [organizationId]);
    return rows[0] ? mapSub(rows[0]) : undefined;
  }

  async findByOrganizationIds(organizationIds: number[]): Promise<Subscription[]> {
    if (organizationIds.length === 0) return [];
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM subscriptions WHERE organization_id IN (?)',
      [organizationIds],
    );
    return rows.map(mapSub);
  }

  async upsert(sub: Omit<Subscription, 'id' | 'createTime' | 'updateTime'> & { id?: number }): Promise<Subscription> {
    await this.db().query(
      `INSERT INTO subscriptions (organization_id, plan_id, status, period_start_time, period_end_time, trial_end_time, cancel_time, provider, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         plan_id = VALUES(plan_id), status = VALUES(status), period_start_time = VALUES(period_start_time),
         period_end_time = VALUES(period_end_time), trial_end_time = VALUES(trial_end_time),
         cancel_time = VALUES(cancel_time), provider = VALUES(provider), external_id = VALUES(external_id)`,
      [
        sub.organizationId, sub.planId, sub.status, sub.periodStartTime ?? null,
        sub.periodEndTime ?? null, sub.trialEndTime ?? null, sub.cancelTime ?? null,
        sub.provider, sub.externalId ?? null,
      ],
    );
    const [rows] = await this.db().query<any[]>('SELECT * FROM subscriptions WHERE organization_id = ?', [sub.organizationId]);
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
   * 单组织到期降级：status 可降级且（period_end_time 到期 或 trialing 的 trial_end_time 到期）→ status=expired。
   *
   * `<=` 而非 `<`：周期/试用结束时刻到达即结束。service 判据与这两条 SQL 统一到 `<=`。
   * trialing 必须能按 trial_end_time 到期，否则建 team 组织即永久免费 team（付费门禁旁路）。
   */
  async expireOne(organizationId: number, now: Date): Promise<boolean> {
    const [result] = await this.db().query<any>(
      `UPDATE subscriptions
           SET status = 'expired'
         WHERE organization_id = ?
           AND status IN (${EXPIRABLE_PLACEHOLDERS})
           AND (
             (period_end_time IS NOT NULL AND period_end_time <= ?)
             OR (status = 'trialing' AND trial_end_time IS NOT NULL AND trial_end_time <= ?)
           )`,
      [organizationId, ...EXPIRABLE_STATUSES, now, now],
    );
    return (result?.affectedRows ?? 0) > 0;
  }

  /** 全表到期降级（定时任务 / 启动时），返回降级行数。单条单表 UPDATE 的 affectedRows 即行数 */
  async downgradeExpired(now: Date): Promise<number> {
    const [result] = await this.db().query<any>(
      `UPDATE subscriptions SET status = 'expired'
        WHERE status IN (${EXPIRABLE_PLACEHOLDERS})
          AND (
            (period_end_time IS NOT NULL AND period_end_time <= ?)
            OR (status = 'trialing' AND trial_end_time IS NOT NULL AND trial_end_time <= ?)
          )`,
      [...EXPIRABLE_STATUSES, now, now],
    );
    return result?.affectedRows ?? 0;
  }
}

function mapSub(r: any): Subscription {
  return {
    id: r.id,
    organizationId: r.organization_id,
    planId: r.plan_id,
    status: r.status as SubStatus,
    periodStartTime: r.period_start_time ? new Date(r.period_start_time) : undefined,
    periodEndTime: r.period_end_time ? new Date(r.period_end_time) : undefined,
    trialEndTime: r.trial_end_time ? new Date(r.trial_end_time) : undefined,
    cancelTime: r.cancel_time ? new Date(r.cancel_time) : undefined,
    provider: r.provider as PaymentProvider,
    externalId: r.external_id ?? undefined,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}