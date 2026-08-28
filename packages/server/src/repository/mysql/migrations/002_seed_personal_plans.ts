import type { Migration } from '../migrate.js';

/**
 * V3 Greenfield 个人套餐目录（Phase 1 仅 free）。
 *
 * 数值配额显式给出，`0` 表示无限（实施规格 §4.2）。不得从 V2 seed 隐式继承。
 * 迁移只负责首次播种；Part 商业目录由后续专项调整，不会被服务重启覆盖。
 */
const PERSONAL_PLAN_SEED = {
  code: 'free',
  name: 'Free',
  allowedDatabaseTypes: ['mysql', 'sqlite'],
  maxDevices: 0,
} as const;

export const seedPersonalPlansV3: Migration = {
  version: '002_seed_personal_plans_v3',
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