import type { Migration } from '../migrate.js';
import { initialSchemaV2 } from './001_initial_schema.js';
import { seedPlansV2 } from './002_seed_plans.js';
import { adminAuditLog } from './003_admin_audit_log.js';

/** v2 新库启动时按固定顺序执行的 migration 集合。 */
export const migrations: readonly Migration[] = [initialSchemaV2, seedPlansV2, adminAuditLog];
