import type { Migration } from '../migrate.js';

/**
 * Greenfield v2 的初始套餐目录。
 *
 * Team 按席位计费：基础价包含 included_seats 个席位，超出的席位按 seat_price_* 计。
 * 迁移只负责首次播种；后续商业定价与额度由管理能力调整，不会被服务重启覆盖。
 */
const PLAN_SEED = [
  {
    code: 'free', name: 'Free', priceMonth: 0, priceYear: 0,
    seatPriceMonth: null, seatPriceYear: null, includedSeats: 1,
    perSeatMaxDevices: 1, perUserMaxPrivateConnections: 10, perUserMaxOpenConnections: 2,
    perUserPrivateSyncQuotaBytes: 1 * 1024 * 1024, perUserSyncVersionRetention: 3,
    perUserHistoryRetentionCount: 50, orgMaxSharedConnections: 0, orgSharedSyncQuotaBytes: 0,
    orgMaxMembers: 1, features: 1,
  },
  {
    code: 'pro', name: 'Pro', priceMonth: 5, priceYear: 60,
    seatPriceMonth: null, seatPriceYear: null, includedSeats: 1,
    perSeatMaxDevices: 5, perUserMaxPrivateConnections: 200, perUserMaxOpenConnections: 0,
    perUserPrivateSyncQuotaBytes: 100 * 1024 * 1024, perUserSyncVersionRetention: 30,
    perUserHistoryRetentionCount: 0, orgMaxSharedConnections: 0, orgSharedSyncQuotaBytes: 0,
    orgMaxMembers: 1, features: 0b1000111,
  },
  {
    code: 'team', name: 'Team', priceMonth: 20, priceYear: 200,
    seatPriceMonth: 20, seatPriceYear: 200, includedSeats: 5,
    perSeatMaxDevices: 5, perUserMaxPrivateConnections: 200, perUserMaxOpenConnections: 0,
    perUserPrivateSyncQuotaBytes: 100 * 1024 * 1024, perUserSyncVersionRetention: 30,
    perUserHistoryRetentionCount: 0, orgMaxSharedConnections: 500,
    orgSharedSyncQuotaBytes: 1024 * 1024 * 1024, orgMaxMembers: 0, features: 0b1111111,
  },
] as const;

export const seedPlansV2: Migration = {
  version: '002_seed_plans_v2',
  async up(db): Promise<void> {
    for (const plan of PLAN_SEED) {
      await db.query(
        `INSERT INTO plans (
          code, name, price_month, price_year, seat_price_month, seat_price_year, included_seats,
          per_seat_max_devices, per_user_max_private_connections, per_user_max_open_connections,
          per_user_private_sync_quota_bytes, per_user_sync_version_retention,
          per_user_history_retention_count, org_max_shared_connections,
          org_shared_sync_quota_bytes, org_max_members, features
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE code = VALUES(code)`,
        [
          plan.code, plan.name, plan.priceMonth, plan.priceYear,
          plan.seatPriceMonth, plan.seatPriceYear, plan.includedSeats,
          plan.perSeatMaxDevices, plan.perUserMaxPrivateConnections, plan.perUserMaxOpenConnections,
          plan.perUserPrivateSyncQuotaBytes, plan.perUserSyncVersionRetention,
          plan.perUserHistoryRetentionCount, plan.orgMaxSharedConnections,
          plan.orgSharedSyncQuotaBytes, plan.orgMaxMembers, plan.features,
        ],
      );
    }
  },
};
