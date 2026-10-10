import type { Migration } from '../migrate.js';
import { addOrVerify } from './migrationGuards.js';

/**
 * 007：审计查询复合索引（`(<过滤列>, id)`）。
 *
 * 背景：`auditRepo.buildFilter` 支持 actor_user_id / event_type / target_type 过滤，并以
 * `id < ?` + `ORDER BY id DESC LIMIT` 游标分页；基线索引均为 `(<列>, event_time)`，
 * 无法同时服务过滤与 id 排序 → filesort。本迁移补 `(<列>, id)`，新库与存量库统一由 007 补齐。
 *
 * 幂等：`addOrVerify` 仅在「对象已存在」错误码下吞错，并回验 information_schema。
 *
 * 注意：audit_events 为高写入表，ADD INDEX 建议低峰执行（MySQL 8 默认 ONLINE DDL）。
 * 回滚（见 docs/迁移回滚.md）：DROP INDEX 后删除账本行。
 */
const INDEXES: readonly { name: string; columns: string }[] = [
  { name: 'idx_audit_actor_id', columns: '(actor_user_id, id)' },
  { name: 'idx_audit_type_id', columns: '(event_type, id)' },
  { name: 'idx_audit_target_id', columns: '(target_type, id)' },
];

export const auditQueryIndexesMigration: Migration = {
  version: '007_audit_query_indexes',
  async up(db): Promise<void> {
    for (const idx of INDEXES) {
      await addOrVerify(
        db,
        `ALTER TABLE audit_events ADD INDEX ${idx.name} ${idx.columns}`,
        `SELECT 1 FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'audit_events' AND index_name = '${idx.name}' LIMIT 1`,
      );
    }
  },
};