import type { Migration } from '../migrate.js';
import { baselineMigration } from './001_baseline.js';
import { planFeaturesV2Migration } from './002_plan_features_v2.js';
import { planOrderingMigration } from './003_plan_ordering.js';
import { authenticatorQuotaMigration } from './004_authenticator_quota.js';
import { syncEntityKindMigration } from './005_sync_entity_kind.js';
import { redisEngineMigration } from './006_redis_engine.js';
import { auditQueryIndexesMigration } from './007_audit_query_indexes.js';
import { aiQuotaMigration } from './008_ai_quota.js';
import { aiTopupMigration } from './009_ai_topup.js';
import { aiProvidersMigration } from './010_ai_providers.js';
import { aiModelPricingMigration } from './011_ai_model_pricing.js';
import { aiCreditsBillingMigration } from './012_ai_credits_billing.js';
import { aiCreditTiersMigration } from './013_ai_credit_tiers.js';
import { planEnginesDevicesMigration } from './014_plan_engines_devices.js';
import { userFeedbackMigration } from './015_user_feedback.js';
import { extensionTelemetryMigration } from './016_extension_telemetry.js';
import { feedbackRepliesMigration } from './017_feedback_replies.js';

/**
 * 迁移集合（开发阶段 squash：原 001–024 已合并为单一基线）。
 * 新库/旧库均由基线重建；旧库的历史版本由 LEGACY_MIGRATION_VERSIONS 识别并放行。
 */
export const migrations: readonly Migration[] = [baselineMigration, planFeaturesV2Migration, planOrderingMigration, authenticatorQuotaMigration, syncEntityKindMigration, redisEngineMigration, auditQueryIndexesMigration, aiQuotaMigration, aiTopupMigration, aiProvidersMigration, aiModelPricingMigration, aiCreditsBillingMigration, aiCreditTiersMigration, planEnginesDevicesMigration, userFeedbackMigration, extensionTelemetryMigration, feedbackRepliesMigration];

/**
 * squash 前的历史版本登记（001–024）。基线会重建这些表；
 * runner 遇账本里的「未知版本」（不在 migrations 也不在此表）须 fail-loud，避免静默重放。
 */
export const LEGACY_MIGRATION_VERSIONS: readonly string[] = [
  '001_users_auth',
  '002_seed_personal_plans',
  '003_rate_limit',
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
