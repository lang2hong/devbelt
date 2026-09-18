import { describe, it, expect } from 'vitest';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import { MysqlUserRepo } from '../../src/modules/auth/repository/userRepo.js';
import { MysqlOrganizationRepo } from '../../src/modules/organization/repository/organizationRepo.js';
import { MysqlMembershipRepo } from '../../src/modules/organization/repository/membershipRepo.js';
import { MysqlOrganizationSubscriptionRepo } from '../../src/modules/billing/repository/organizationSubscriptionRepo.js';
import { MysqlAuditRepo } from '../../src/modules/auth/repository/auditRepo.js';
import type { MysqlDb, Queryable } from '../../src/repository/mysql/db.js';

const URL = process.env.MYSQL_TEST_URL;

/**
 * schema 对齐守卫（真库）：squash 后 organization.delete_time / personal_plans /
 * audit_events.create_time 等已不存在，但仓储 SQL 可能仍引用它们（生产曾在
 * /api/console/me 上 500）。这里跑一遍受影响查询，任何旧列/旧表引用都会即刻失败。
 */
describe.skipIf(!URL)('schema alignment (real MySQL)', () => {
  it('affected repositories run against the post-squash schema', async () => {
    const pool = createTestPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);

      const userRepo = new MysqlUserRepo(() => db);
      const orgRepo = new MysqlOrganizationRepo(() => db);
      const membershipRepo = new MysqlMembershipRepo(() => db);
      const orgSubRepo = new MysqlOrganizationSubscriptionRepo(() => db);
      const auditRepo = new MysqlAuditRepo(() => db);

      const user = await userRepo.create(`align-${Date.now()}@example.com`, 'hash', 'Align');
      const org = await orgRepo.create(db as unknown as Queryable, { name: 'Align Org' });

      // 组织订阅（plan_id FK → plans）取组织兜底档
      const [planRows] = (await db.query("SELECT id FROM plans WHERE code = 'organization_free' LIMIT 1")) as [Array<{ id: number }>, unknown];
      await orgSubRepo.create(db as unknown as Queryable, {
        organizationId: org.id, planId: Number(planRows[0].id), seatLimit: 3, status: 'active',
        periodStartTime: new Date(), periodEndTime: null,
      });
      await membershipRepo.create(db as unknown as Queryable, {
        organizationId: org.id, userId: user.id, role: 'admin', status: 'active',
        invitedByUserId: null, joinedTime: new Date(), removedTime: null,
      });

      // 曾断裂 1：membershipRepo 查 organizations.delete_time
      const summaries = await membershipRepo.listActiveByUserWithOrg(user.id);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].status).toBe('active');

      // 曾断裂 2：userRepo 管理端 JOIN personal_plans
      const adminUsers = await userRepo.listUsers({ limit: 10 });
      expect(adminUsers.some((u) => u.userId === user.id)).toBe(true);
      await userRepo.countUsers({});

      // 曾断裂 3：organizationRepo 管理端 JOIN organization_plans + delete_time
      const adminOrgs = await orgRepo.listForAdmin({ limit: 10 });
      expect(adminOrgs.some((o) => o.name === 'Align Org')).toBe(true);
      await orgRepo.countForAdmin({});

      // 曾断裂 4：auditRepo 读 audit_events.create_time
      await auditRepo.insert({
        eventTime: new Date(), actorUserId: user.id, actorRole: 'user', eventType: 'align.check',
        targetType: null, targetId: null, organizationId: null, sourceIp: null, requestId: null,
        result: 'success', failureCode: null, reason: null,
      });
      const events = await auditRepo.search({ limit: 10 } as never);
      expect(events.some((e) => e.eventType === 'align.check')).toBe(true);
      expect(events[0].createTime instanceof Date).toBe(true);

      // 关闭组织走 status='closed'
      await orgRepo.close(db as unknown as Queryable, org.id, new Date());
      const after = await membershipRepo.listActiveByUserWithOrg(user.id);
      expect(after).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });
});