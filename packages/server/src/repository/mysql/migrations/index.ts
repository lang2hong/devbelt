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
import { seedPaidPlansMigration } from './010_seed_paid_plans.js';
import { mailFlowsMigration } from './011_mail_flows.js';
import { auditEventsMigration } from './012_audit_events.js';
import { consoleSessionMigration } from './013_console_session.js';
import { idempotencyReceiptsMigration } from './014_idempotency_receipts.js';
import { platformAdminMigration } from './015_platform_admin.js';
import { idempotencyReceiptLongtextMigration } from './016_idempotency_receipt_longtext.js';
import { syncResetHandoffsMigration } from './017_sync_reset_handoffs.js';
import { paymentMigration } from './018_payment.js';

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
  seedPaidPlansMigration,
  mailFlowsMigration,
  auditEventsMigration,
  consoleSessionMigration,
  idempotencyReceiptsMigration,
  platformAdminMigration,
  idempotencyReceiptLongtextMigration,
  syncResetHandoffsMigration,
  paymentMigration,
];
