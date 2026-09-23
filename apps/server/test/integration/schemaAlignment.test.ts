import { describe, it, expect } from 'vitest';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import { MysqlUserRepo } from '../../src/modules/auth/repository/userRepo.js';
import { MysqlAuditRepo } from '../../src/modules/auth/repository/auditRepo.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';

const URL = process.env.DEVBELT_DB_TEST_MYSQL_URL;

/**
 * schema 对齐守卫（真库）：squash 后 personal_plans / audit_events.create_time 等已不存在，
 * 但仓储 SQL 可能仍引用它们（生产曾在 /api/console/me 上 500）。这里跑一遍受影响查询，
 * 任何旧列/旧表引用都会即刻失败。
 */
describe.skipIf(!URL)('schema alignment (real MySQL)', () => {
  it('affected repositories run against the post-squash schema', async () => {
    const pool = createTestPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);

      // 组织功能下线：相关表不应存在。
      const [tableRows] = (await db.query('SHOW TABLES')) as [Array<Record<string, unknown>>, unknown];
      const names = tableRows.map((r) => Object.values(r)[0] as string);
      expect(names).not.toContain('organizations');
      expect(names).not.toContain('organization_plans');

      const userRepo = new MysqlUserRepo(() => db);
      const auditRepo = new MysqlAuditRepo(() => db);

      const user = await userRepo.create(`align-${Date.now()}@example.com`, 'hash', 'Align');

      // 曾断裂：userRepo 管理端 JOIN personal_plans
      const adminUsers = await userRepo.listUsers({ limit: 10 });
      expect(adminUsers.some((u) => u.userId === user.id)).toBe(true);
      await userRepo.countUsers({});

      // 曾断裂：auditRepo 读 audit_events.create_time
      await auditRepo.insert({
        eventTime: new Date(), actorUserId: user.id, actorRole: 'user', eventType: 'align.check',
        targetType: null, targetId: null, sourceIp: null, requestId: null,
        result: 'success', failureCode: null, reason: null,
      });
      const events = await auditRepo.search({ limit: 10 } as never);
      expect(events.some((e) => e.eventType === 'align.check')).toBe(true);
      expect(events[0].createTime instanceof Date).toBe(true);
    } finally {
      await pool.end();
    }
  });
});