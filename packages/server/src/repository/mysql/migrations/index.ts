import type { Migration } from '../migrate.js';
import { usersAuthMigration } from './001_users_auth.js';
import { seedPersonalPlansMigration } from './002_seed_personal_plans.js';
import { rateLimitMigration } from './003_rate_limit.js';
import { organizationPlansMigration } from './004_organization_plans.js';
import { seedOrganizationPlansMigration } from './005_seed_organization_plans.js';
import { organizationsMigration } from './006_organizations.js';
import { invitationsMigration } from './007_invitations.js';
import { organizationResourcesMigration } from './008_organization_resources.js';
import { personalSyncMigration } from './009_personal_sync.js';

/** 新库启动时按固定依赖顺序执行的 migration 集合。 */
export const migrations: readonly Migration[] = [
  usersAuthMigration,
  seedPersonalPlansMigration,
  rateLimitMigration,
  organizationPlansMigration,
  seedOrganizationPlansMigration,
  organizationsMigration,
  invitationsMigration,
  organizationResourcesMigration,
  personalSyncMigration,
];
