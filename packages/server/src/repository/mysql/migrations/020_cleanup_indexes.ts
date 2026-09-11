import type { Migration } from '../migrate.js';
import { addOrVerify } from './migrationGuards.js';

/**
 * 清理类全表扫索引补齐 + handoff status CHECK（P3 收尾）。
 *
 * 三处 cleanup/过期查询此前无可用索引（现有索引均不以 expires/revoked 为前缀）：
 * - refresh_tokens：轮换式追加表，只增不减；过期/已撤销清理按 expires_time/revoked_time 扫。
 * - personal_sync_mutations：mutation receipt 24h 保留期，按 expires_time 分批清理。
 * - organization_invitations：findExpiredOrganizationIds 按 expires_time 扫。
 *
 * 另补 `sync_reset_handoffs.status` 的 CHECK 约束：状态机只允许
 * issued/processing/completed/revoked/expired 五个值，服务层外的非法写入一律拒绝。
 */
export const cleanupIndexesMigration: Migration = {
  version: '020_cleanup_indexes',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await addOrVerify(db,
      `ALTER TABLE sync_reset_handoffs ADD CONSTRAINT chk_sync_handoff_status
       CHECK (status IN ('issued','processing','completed','revoked','expired'))`,
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_reset_handoffs'
         AND CONSTRAINT_NAME = 'chk_sync_handoff_status'`,
    );

    await addOrVerify(db,
      `CREATE INDEX idx_rt_expires ON refresh_tokens (expires_time)`,
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens'
         AND INDEX_NAME = 'idx_rt_expires'`,
    );
    await addOrVerify(db,
      `CREATE INDEX idx_rt_revoked ON refresh_tokens (revoked_time)`,
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens'
         AND INDEX_NAME = 'idx_rt_revoked'`,
    );
    await addOrVerify(db,
      `CREATE INDEX idx_sync_mutations_expires ON personal_sync_mutations (expires_time)`,
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_sync_mutations'
         AND INDEX_NAME = 'idx_sync_mutations_expires'`,
    );
    await addOrVerify(db,
      `CREATE INDEX idx_invitation_expires ON organization_invitations (expires_time)`,
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organization_invitations'
         AND INDEX_NAME = 'idx_invitation_expires'`,
    );
    await addOrVerify(db,
      `CREATE INDEX idx_orders_status_expires ON orders (status, expires_time)`,
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
         AND INDEX_NAME = 'idx_orders_status_expires'`,
    );
  },
};