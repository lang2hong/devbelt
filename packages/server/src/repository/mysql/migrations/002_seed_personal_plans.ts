import type { Migration } from '../migrate.js';

/**
 * 个人套餐目录，当前只提供 free。
 *
 * 数值配额显式给出，`0` 表示无限。迁移只负责首次播种，服务重启不会覆盖。
 */
const PERSONAL_PLAN_SEED = {
  code: 'free',
  name: 'Free',
  allowedDatabaseTypes: ['mysql', 'sqlite'],
  maxDevices: 0,
} as const;

export const seedPersonalPlansMigration: Migration = {
  version: '002_seed_personal_plans',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(
      `INSERT INTO personal_plans (code, name, allowed_database_types, max_devices, status)
       VALUES (?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [
        PERSONAL_PLAN_SEED.code,
        PERSONAL_PLAN_SEED.name,
        JSON.stringify(PERSONAL_PLAN_SEED.allowedDatabaseTypes),
        PERSONAL_PLAN_SEED.maxDevices,
      ],
    );
  },
};
