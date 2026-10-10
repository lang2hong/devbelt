import { describe, expect, it } from 'vitest';
import { auditQueryIndexesMigration } from '../../src/repository/mysql/migrations/007_audit_query_indexes.js';
import type { MigrationDb } from '../../src/repository/mysql/migrate.js';

/**
 * 007：审计查询索引（不依赖 MySQL 的单测）——校验 DDL 形状与守卫行为：
 * 重复索引仅在 information_schema 回验命中时吞错；未命中必须上抛。
 */
describe('007_audit_query_indexes', () => {
  it('为三个过滤列补 (列, id) 索引', async () => {
    const queries: string[] = [];
    const db: MigrationDb = {
      query: async (sql: string) => {
        queries.push(sql);
        return [[], undefined];
      },
    };
    await auditQueryIndexesMigration.up(db);
    expect(queries.filter((q) => q.startsWith('ALTER TABLE audit_events ADD INDEX'))).toEqual([
      'ALTER TABLE audit_events ADD INDEX idx_audit_actor_id (actor_user_id, id)',
      'ALTER TABLE audit_events ADD INDEX idx_audit_type_id (event_type, id)',
      'ALTER TABLE audit_events ADD INDEX idx_audit_target_id (target_type, id)',
    ]);
    // 成功路径不触发回验查询。
    expect(queries.filter((q) => q.includes('information_schema'))).toHaveLength(0);
  });

  it('重复索引（ER_DUP_KEYNAME）仅在回验存在时吞错；不存在则上抛', async () => {
    const dup = Object.assign(new Error('duplicate key name'), { code: 'ER_DUP_KEYNAME' });

    let calls = 0;
    const exists: MigrationDb = {
      query: async (sql: string) => {
        calls += 1;
        if (sql.startsWith('ALTER')) throw dup;
        return [[{ present: 1 }], undefined];
      },
    };
    await expect(auditQueryIndexesMigration.up(exists)).resolves.toBeUndefined();
    expect(calls).toBe(6); // 3 × (ALTER + 回验)

    const missing: MigrationDb = {
      query: async (sql: string) => {
        if (sql.startsWith('ALTER')) throw dup;
        return [[], undefined];
      },
    };
    await expect(auditQueryIndexesMigration.up(missing)).rejects.toBe(dup);
  });

  it('非重复类错误直接上抛（不吞错）', async () => {
    const db: MigrationDb = {
      query: async (sql: string) => {
        if (sql.startsWith('ALTER')) throw new Error('lock wait timeout');
        return [[], undefined];
      },
    };
    await expect(auditQueryIndexesMigration.up(db)).rejects.toThrow('lock wait timeout');
  });
});