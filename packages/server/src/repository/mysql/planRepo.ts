import type { IPlanRepo, PlanEditableFields } from '../interfaces.js';
import type { Plan } from '../../domain/entities.js';
import type { PlanCode } from '../../domain/enums.js';
import type { MysqlDb } from './db.js';

/**
 * 套餐仓库。v2：plans 表新增 id（外键目标）、seat_price_*、included_seats、
 * per_seat / per_user / org 三段额度字段。seed 保留但 v2 Greenfield 实际由
 * migration 002 播种，此方法仅供测试与管理路径使用。
 */
export class MysqlPlanRepo implements IPlanRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findById(id: number): Promise<Plan | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM plans WHERE id = ?', [id]);
    return rows[0] ? mapPlan(rows[0]) : undefined;
  }

  async findByCode(code: PlanCode): Promise<Plan | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM plans WHERE code = ?', [code]);
    return rows[0] ? mapPlan(rows[0]) : undefined;
  }

  async listAll(): Promise<Plan[]> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM plans ORDER BY price_month');
    return rows.map(mapPlan);
  }

  async seed(plans: Array<Omit<Plan, 'createTime' | 'updateTime'>>): Promise<void> {
    for (const p of plans) {
      await this.db().query(
        `INSERT INTO plans (
           code, name, price_month, price_year, seat_price_month, seat_price_year, included_seats,
           per_seat_max_devices, per_user_max_private_connections, per_user_max_open_connections,
           per_user_private_sync_quota_bytes, per_user_sync_version_retention,
           per_user_history_retention_count, org_max_shared_connections,
           org_shared_sync_quota_bytes, org_max_members, features
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE code = VALUES(code)`,
        [
          p.code, p.name, p.priceMonth, p.priceYear, p.seatPriceMonth ?? null, p.seatPriceYear ?? null,
          p.includedSeats, p.perSeatMaxDevices, p.perUserMaxPrivateConnections,
          p.perUserMaxOpenConnections, p.perUserPrivateSyncQuotaBytes, p.perUserSyncVersionRetention,
          p.perUserHistoryRetentionCount, p.orgMaxSharedConnections, p.orgSharedSyncQuotaBytes,
          p.orgMaxMembers, p.features,
        ],
      );
    }
  }

  async update(code: PlanCode, fields: PlanEditableFields): Promise<void> {
    // 动态拼 SET：只更新入参出现的字段，避免把未提供的字段写成 NULL/默认。
    // 与 organizationResourceRepo.update 同构；admin 端真实表单发全字段时
    // 行为不变，分步 PATCH 也不会误清空。
    const sets: string[] = [];
    const params: any[] = [];
    const map: Array<[string, unknown]> = [
      ['name', fields.name],
      ['price_month', fields.priceMonth],
      ['price_year', fields.priceYear],
      ['seat_price_month', fields.seatPriceMonth],
      ['seat_price_year', fields.seatPriceYear],
      ['included_seats', fields.includedSeats],
      ['per_seat_max_devices', fields.perSeatMaxDevices],
      ['per_user_max_private_connections', fields.perUserMaxPrivateConnections],
      ['per_user_max_open_connections', fields.perUserMaxOpenConnections],
      ['per_user_private_sync_quota_bytes', fields.perUserPrivateSyncQuotaBytes],
      ['per_user_sync_version_retention', fields.perUserSyncVersionRetention],
      ['per_user_history_retention_count', fields.perUserHistoryRetentionCount],
      ['org_max_shared_connections', fields.orgMaxSharedConnections],
      ['org_shared_sync_quota_bytes', fields.orgSharedSyncQuotaBytes],
      ['org_max_members', fields.orgMaxMembers],
      ['features', fields.features],
    ];
    for (const [col, val] of map) {
      if (val !== undefined) {
        sets.push(`${col} = ?`);
        params.push(val);
      }
    }
    if (sets.length === 0) return;
    params.push(code);
    await this.db().query(`UPDATE plans SET ${sets.join(', ')} WHERE code = ?`, params);
  }
}

function mapPlan(r: any): Plan {
  return {
    id: r.id,
    code: r.code as PlanCode,
    name: r.name,
    priceMonth: Number(r.price_month),
    priceYear: Number(r.price_year),
    seatPriceMonth: r.seat_price_month != null ? Number(r.seat_price_month) : undefined,
    seatPriceYear: r.seat_price_year != null ? Number(r.seat_price_year) : undefined,
    includedSeats: r.included_seats,
    perSeatMaxDevices: r.per_seat_max_devices,
    perUserMaxPrivateConnections: r.per_user_max_private_connections,
    perUserMaxOpenConnections: r.per_user_max_open_connections,
    perUserPrivateSyncQuotaBytes: Number(r.per_user_private_sync_quota_bytes),
    perUserSyncVersionRetention: r.per_user_sync_version_retention,
    perUserHistoryRetentionCount: r.per_user_history_retention_count,
    orgMaxSharedConnections: r.org_max_shared_connections,
    orgSharedSyncQuotaBytes: Number(r.org_shared_sync_quota_bytes),
    orgMaxMembers: r.org_max_members,
    features: r.features,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}