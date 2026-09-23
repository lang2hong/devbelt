import type { Migration } from '../migrate.js';

/**
 * P6：同步记录增明文 `entity_kind`（仅类型名，供按类型计数/配额/后台统计）。
 *
 * - 可空；**旧记录为 NULL**（向后兼容）。
 * - 协议字段（PUT body 的 entityKind）亦为可选：旧服务端会拒新字段，故发布顺序为
 *   「先上服务端（本迁移 + 接受可选字段），再上客户端」。
 * - 迁移只跑一次，无需幂等 ALTER；列可长期保留（NULL 兼容）。
 */
export const syncEntityKindMigration: Migration = {
  version: '005_sync_entity_kind',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`ALTER TABLE personal_connection_meta ADD COLUMN entity_kind VARCHAR(32) NULL`);
  },
};
