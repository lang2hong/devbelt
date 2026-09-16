import type { Migration } from '../migrate.js';
import { baselineMigration } from './001_baseline.js';
import { planFeaturesV2Migration } from './002_plan_features_v2.js';

/**
 * 迁移集合（开发阶段 squash：原 001–024 已合并为单一基线）。
 * 新库/旧库均由基线重建；旧库的历史版本由 LEGACY_MIGRATION_VERSIONS 识别并放行。
 */
export const migrations: readonly Migration[] = [baselineMigration, planFeaturesV2Migration];

/**
 * squash 前的历史版本登记（001–024）。基线会重建这些表；
 * runner 遇账本里的「未知版本」（不在 migrations 也不在此表）须 fail-loud，避免静默重放。
 */
export const LEGACY_MIGRATION_VERSIONS: readonly string[] = [
  '001_users_auth',
  '002_seed_personal_plans',
  '003_rate_limit',
  '004_organization_plans',
  '005_seed_organization_plans',
  '006_organizations',
  '007_invitations',
  '008_organization_resources',
  '009_personal_sync',
  '010_seed_paid_plans',
  '011_mail_flows',
  '012_audit_events',
  '013_console_session',
  '014_idempotency_receipts',
  '015_platform_admin',
  '016_idempotency_receipt_longtext',
  '017_sync_reset_handoffs',
  '018_payment',
  '019_invoice_order_unique',
  '020_cleanup_indexes',
  '021_payment_callback_nonces',
  '022_account_recovery',
  '023_invoice_status_reason',
  '024_sync_mutation_recovery_time',
];