import { describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import { generateKeyPairSync } from 'crypto';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';
import { withTransaction } from '../../src/repository/mysql/db.js';
import { MysqlUserRepo } from '../../src/repository/mysql/userRepo.js';
import { MysqlPlanRepo } from '../../src/repository/mysql/planRepo.js';
import { MysqlOrganizationRepo } from '../../src/repository/mysql/organizationRepo.js';
import { MysqlOrganizationSubscriptionRepo } from '../../src/repository/mysql/organizationSubscriptionRepo.js';
import { MysqlMembershipRepo } from '../../src/repository/mysql/membershipRepo.js';
import { MysqlOrganizationInvitationRepo } from '../../src/repository/mysql/invitationRepo.js';
import { MysqlRateLimitRepo } from '../../src/repository/mysql/rateLimitRepo.js';
import { OrganizationService } from '../../src/service/organizationService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { TokenService } from '../../src/service/tokenService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import { OrganizationAdminRequiredError, EntityNotFoundError, RateLimitedError, OrganizationNotFoundError, ForbiddenError } from '../../src/domain/errors.js';

const URL = process.env.MYSQL_TEST_URL;

/**
 * @param rateLimit 是否启用限流。**默认关闭**。
 *
 * 每个 it 各自建库跑 migrations，但 rate_limit_entries 里的桶键是
 * `org:create:user:<id>` —— userId 在各测试间会重复，于是所有测试共享同一个
 * 「每用户每小时 10 次」的配额。本文件累计建组织 11 次，开着限流就会互相挤占：
 * 单跑时最后那个限流测试挂，与其它文件一起跑时第一个测试就挂。
 * 因此只有专门验证限流的那个测试开启它（并使用独立 userId）。
 */
async function makeService(db: MysqlDb, rateLimit = false) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const tokenService = new TokenService({ kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) }, '15m', 30 * 24 * 3600 * 1000);
  const rateLimiter = new RateLimitService(new MysqlRateLimitRepo(() => db), rateLimit);
  return new OrganizationService(
    new MysqlUserRepo(() => db),
    new MysqlOrganizationRepo(() => db),
    new MysqlPlanRepo(() => db),
    new MysqlOrganizationSubscriptionRepo(() => db),
    new MysqlMembershipRepo(() => db),
    new MysqlOrganizationInvitationRepo(() => db),
    rateLimiter,
    tokenService,
    new MemoryEmailSender(),
    (fn) => withTransaction(db, fn),
  );
}

function newPool(): mysql.Pool {
  return createTestPool();
}

async function countAdmins(db: MysqlDb, organizationId: number): Promise<number> {
  const [rows] = await db.query("SELECT COUNT(*) AS cnt FROM organization_memberships WHERE organization_id = ? AND role = 'admin' AND status = 'active'", [organizationId]);
  return Number((rows as any[])[0].cnt);
}

describe.skipIf(!URL)('organization (real MySQL)', () => {
  it('createOrganization persists org + free subscription + first admin', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const userRepo = new MysqlUserRepo(() => db);
      await userRepo.create('o@example.com', 'hash', 'Owner');

      const svc = await makeService(db);
      const user = await userRepo.findByEmail('o@example.com');
      const org = await svc.createOrganization(user!.id, 'Acme');

      const [subs] = (await db.query('SELECT * FROM organization_subscriptions WHERE organization_id = ?', [org.organizationId])) as [any[], unknown];
      expect(subs[0].seat_limit).toBe(3);

      const [members] = (await db.query('SELECT * FROM organization_memberships WHERE organization_id = ?', [org.organizationId])) as [any[], unknown];
      expect(members).toHaveLength(1);
      expect(members[0].role).toBe('admin');
      expect(members[0].status).toBe('active');
    } finally {
      await pool.end();
    }
  });

  it('rejects a non-member actor on member removal (authorization re-checked in tx)', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const userRepo = new MysqlUserRepo(() => db);
      await userRepo.create('admin@example.com', 'hash', 'A');
      const svc = await makeService(db);
      const user = await userRepo.findByEmail('admin@example.com');
      const org = await svc.createOrganization(user!.id, 'Acme');
      const members = await svc.listMembers(org.organizationId);
      await expect(svc.removeMember(org.organizationId, members[0].membershipId, 999999)).rejects.toBeInstanceOf(OrganizationNotFoundError);
    } finally {
      await pool.end();
    }
  });

  it('rejects an actor demoted after middleware authorization', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const userRepo = new MysqlUserRepo(() => db);
      const email = `demoted-${Date.now()}@example.com`;
      await userRepo.create(email, 'hash', 'D');
      const svc = await makeService(db);
      const owner = await userRepo.findByEmail(email);
      const org = await svc.createOrganization(owner!.id, 'Acme');

      const membershipRepo = new MysqlMembershipRepo(() => db);
      const secondEmail = `second-${Date.now()}@example.com`;
      await userRepo.create(secondEmail, 'hash', 'S');
      const second = await userRepo.findByEmail(secondEmail);
      const secondMembership = await membershipRepo.create(db, {
        organizationId: org.organizationId, userId: second!.id, role: 'admin', status: 'active',
        invitedByUserId: null, joinedTime: new Date(), removedTime: null,
      });
      await membershipRepo.updateRole(db, secondMembership.id, 'member');

      const members = await svc.listMembers(org.organizationId);
      const ownerMembershipId = members.find((m) => m.userId === owner!.id)!.membershipId;
      await expect(svc.assignRole(org.organizationId, ownerMembershipId, 'member', second!.id)).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await pool.end();
    }
  });

  it('rejects cross-organization membership id (composite-key isolation)', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const userRepo = new MysqlUserRepo(() => db);
      await userRepo.create('x@example.com', 'hash', 'X');
      const svc = await makeService(db);
      const user = await userRepo.findByEmail('x@example.com');
      const a = await svc.createOrganization(user!.id, 'A');
      const b = await svc.createOrganization(user!.id, 'B');
      const aMembers = await svc.listMembers(a.organizationId);
      // 用 A 组织的 membership id 在 B 组织里做角色分配 → 404（跨组织不可访问）
      await expect(svc.assignRole(b.organizationId, aMembers[0].membershipId, 'member', user!.id)).rejects.toBeInstanceOf(EntityNotFoundError);
    } finally {
      await pool.end();
    }
  });

  it('concurrent demote of two admins: one wins, loser rejected (actor demoted), one admin remains', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const userRepo = new MysqlUserRepo(() => db);
      await userRepo.create('a@example.com', 'hash', 'A');
      await userRepo.create('b@example.com', 'hash', 'B');
      const svc = await makeService(db);
      const a = await userRepo.findByEmail('a@example.com');
      const b = await userRepo.findByEmail('b@example.com');
      const org = await svc.createOrganization(a!.id, 'Acme');
      const orgId = org.organizationId;

      const membershipRepo = new MysqlMembershipRepo(() => db);
      const bMembership = await membershipRepo.create(db, {
        organizationId: orgId, userId: b!.id, role: 'admin', status: 'active',
        invitedByUserId: null, joinedTime: new Date(), removedTime: null,
      });
      const aMembers = await svc.listMembers(orgId);
      const aMembershipId = aMembers.find((m) => m.userId === a!.id)!.membershipId;

      const results = await Promise.allSettled([
        svc.assignRole(orgId, bMembership.id, 'member', a!.id),
        svc.assignRole(orgId, aMembershipId, 'member', b!.id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected' && (r as any).reason instanceof ForbiddenError)).toHaveLength(1);
      expect(await countAdmins(db, orgId)).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.end();
    }
  });

  it('concurrent remove of two admins: one wins, loser rejected (actor removed), one admin remains', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const userRepo = new MysqlUserRepo(() => db);
      await userRepo.create('c@example.com', 'hash', 'C');
      await userRepo.create('d@example.com', 'hash', 'D');
      const svc = await makeService(db);
      const c = await userRepo.findByEmail('c@example.com');
      const d = await userRepo.findByEmail('d@example.com');
      const org = await svc.createOrganization(c!.id, 'Acme');
      const orgId = org.organizationId;

      const membershipRepo = new MysqlMembershipRepo(() => db);
      const dMembership = await membershipRepo.create(db, {
        organizationId: orgId, userId: d!.id, role: 'admin', status: 'active',
        invitedByUserId: null, joinedTime: new Date(), removedTime: null,
      });
      const cMembers = await svc.listMembers(orgId);
      const cMembershipId = cMembers.find((m) => m.userId === c!.id)!.membershipId;

      const results = await Promise.allSettled([
        svc.removeMember(orgId, dMembership.id, c!.id),
        svc.removeMember(orgId, cMembershipId, d!.id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected' && (r as any).reason instanceof OrganizationNotFoundError)).toHaveLength(1);
      expect(await countAdmins(db, orgId)).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.end();
    }
  });

  it('concurrent leave of last two admins: one leaves, one gets 409, one admin remains', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const userRepo = new MysqlUserRepo(() => db);
      await userRepo.create('e@example.com', 'hash', 'E');
      await userRepo.create('f@example.com', 'hash', 'F');
      const svc = await makeService(db);
      const e = await userRepo.findByEmail('e@example.com');
      const f = await userRepo.findByEmail('f@example.com');
      const org = await svc.createOrganization(e!.id, 'Acme');
      const orgId = org.organizationId;

      const membershipRepo = new MysqlMembershipRepo(() => db);
      await membershipRepo.create(db, {
        organizationId: orgId, userId: f!.id, role: 'admin', status: 'active',
        invitedByUserId: null, joinedTime: new Date(), removedTime: null,
      });

      const results = await Promise.allSettled([
        svc.leaveOrganization(orgId, e!.id),
        svc.leaveOrganization(orgId, f!.id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected' && (r as any).reason instanceof OrganizationAdminRequiredError)).toHaveLength(1);
      expect(await countAdmins(db, orgId)).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.end();
    }
  });

  it('org-creation rate limit persists in shared storage (11th request 429)', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      // 唯一一处显式开启限流的地方（makeService 默认关闭，见其文档）。
      const svc = await makeService(db, true);

      // rate_limit_entries 由所有集成测试文件共享（各文件连同一个测试库，
      // userId 都从 1 开始），故取一个业务不会产生的 id 做专属桶并清零，
      // 使本测试不依赖执行顺序。限流只按桶键计数，不要求 user 行存在。
      const rlUserId = 990_001;
      const storedKey = MysqlRateLimitRepo.storageKey(`org:create:user:${rlUserId}`);
      await db.query('DELETE FROM rate_limit_entries WHERE bucket_key = ?', [storedKey]);

      // 前 10 次必须全部放行（阈值 ORG_CREATE_MAX=10）。
      // 这一段同时守住一个真实缺陷：若 rate_limit_entries 带 AUTO_INCREMENT 主键，
      // 首次命中返回的会是自增 id 而非计数 1，表里行数一多就在 i=0 即误判 429。
      for (let i = 0; i < 10; i++) {
        await svc.createOrganization(rlUserId, `Org ${i}`);
      }

      let threw = false;
      try {
        await svc.createOrganization(rlUserId, 'Org 10');
      } catch (e) {
        threw = e instanceof RateLimitedError;
      }
      expect(threw).toBe(true);

      // bucket_key 在库里是定长摘要（逻辑键含用户可控内容，超 255 会撑爆
      // VARCHAR(255) 并让限流失效），故必须经同一映射查，不能按逻辑键查。
      const [rows] = (await db.query('SELECT count FROM rate_limit_entries WHERE bucket_key = ?', [storedKey])) as [any[], unknown];
      expect(rows[0].count).toBe(11);
    } finally {
      await pool.end();
    }
  });
});