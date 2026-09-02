import type { Migration } from '../migrate.js';

const ORGANIZATION_FREE_SEED = {
  code: 'organization_free',
  name: 'Organization Free',
  includedSeats: 3,
  maxSharedResources: 50,
  sharedStorageQuotaBytes: 10485760,
  allowedTemplateDatabaseTypes: ['mysql'],
} as const;

/**
 * Seed organization_free 套餐。
 */
export const seedOrganizationPlansMigration: Migration = {
  version: '005_seed_organization_plans',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(
      `INSERT INTO organization_plans (code, name, included_seats, max_shared_resources, shared_storage_quota_bytes, allowed_template_database_types, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [
        ORGANIZATION_FREE_SEED.code,
        ORGANIZATION_FREE_SEED.name,
        ORGANIZATION_FREE_SEED.includedSeats,
        ORGANIZATION_FREE_SEED.maxSharedResources,
        ORGANIZATION_FREE_SEED.sharedStorageQuotaBytes,
        JSON.stringify(ORGANIZATION_FREE_SEED.allowedTemplateDatabaseTypes),
      ],
    );
  },
};
