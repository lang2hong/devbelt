import type { Migration } from '../migrate.js';
import { usersAuthV3 } from './001_users_auth.js';
import { seedPersonalPlansV3 } from './002_seed_personal_plans.js';
import { rateLimitTableV3 } from './003_rate_limit.js';
import { organizationPlansV3 } from './004_organization_plans.js';
import { seedOrganizationPlansV3 } from './005_seed_organization_plans.js';
import { organizationsV3 } from './006_organizations.js';
import { invitationsV3 } from './007_invitations.js';

/** V3 新库启动时按固定顺序执行的 migration 集合（依赖顺序见各文件内注释）。 */
export const migrations: readonly Migration[] = [
  usersAuthV3,
  seedPersonalPlansV3,
  rateLimitTableV3,
  organizationPlansV3,
  seedOrganizationPlansV3,
  organizationsV3,
  invitationsV3,
];