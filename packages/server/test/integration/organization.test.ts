import { describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import { generateKeyPairSync } from 'crypto';
import { parseMysqlUrl, resolveTestDb } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';
import { withTransaction } from '../../src/repository/mysql/db.js';
import { MysqlUserRepo } from '../../src/repository/mysql/userRepo.js';
import { MysqlOrganizationPlanRepo } from '../../src/repository/mysql/organizationPlanRepo.js';
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

async function makeService(db: MysqlDb) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const tokenService = new TokenService({ kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) }, '15m', 30 * 24 * 3600 * 1000);
  const rateLimiter = new RateLimitService(new MysqlRateLimitRepo(() => db), true);
  return new OrganizationService(
    new MysqlUserRepo(() => db),
    new MysqlOrganizationRepo(() => db),
    new MysqlOrganizationPlanRepo(() => db),
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
  const { host, port, user, password } = parseMysqlUrl(URL!);
  return mysql.createPool({ host, port, user, password, database: resolveTestDb(), timezone: 'Z' });
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

  it('concurrent demote of two admins: one wins, one gets 409, one admin remains', async () => {
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
      expect(results.filter((r) => r.status === 'rejected' && (r as any).reason instanceof OrganizationAdminRequiredError)).toHaveLength(1);
      expect(await countAdmins(db, orgId)).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.end();
    }
  });

  it('concurrent remove of two admins: one wins, one gets 409, one admin remains', async () => {
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
      expect(results.filter((r) => r.status === 'rejected' && (r as any).reason instanceof OrganizationAdminRequiredError)).toHaveLength(1);
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
      const userRepo = new MysqlUserRepo(() => db);
      await userRepo.create('rl@example.com', 'hash', 'RL');
      const svc = await makeService(db);
      const user = await userRepo.findByEmail('rl@example.com');

      for (let i = 0; i < 10; i++) await svc.createOrganization(user!.id, `Org ${i}`);

      let threw = false;
      try {
        await svc.createOrganization(user!.id, 'Org 10');
      } catch (e) {
        threw = e instanceof RateLimitedError;
      }
      expect(threw).toBe(true);

      const [rows] = (await db.query('SELECT count FROM rate_limit_entries WHERE bucket_key = ?', [`org:create:user:${user!.id}`])) as [any[], unknown];
      expect(rows[0].count).toBe(11);
    } finally {
      await pool.end();
    }
  });
});