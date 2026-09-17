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
import { InvitationInvalidError, OrganizationQuotaExceededError, EntityNotFoundError } from '../../src/domain/errors.js';

const URL = process.env.MYSQL_TEST_URL;

function uniqueEmail(prefix = 'inv'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

function newPool(): mysql.Pool {
  return createTestPool();
}

async function makeStack(db: MysqlDb) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const tokenService = new TokenService({ kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) }, '15m', 30 * 24 * 3600 * 1000);
  const emailSender = new MemoryEmailSender();
  const userRepo = new MysqlUserRepo(() => db);
  const membershipRepo = new MysqlMembershipRepo(() => db);
  const invitationRepo = new MysqlOrganizationInvitationRepo(() => db);
  const svc = new OrganizationService(
    userRepo,
    new MysqlOrganizationRepo(() => db),
    new MysqlPlanRepo(() => db),
    new MysqlOrganizationSubscriptionRepo(() => db),
    membershipRepo,
    invitationRepo,
    // 关限流：本文件验证邀请生命周期，不验证限流。它在同一 userId 上建 13 次组织，
    // 而 ORG_CREATE_MAX=10 —— 开着限流会在第 11 次抛 429，淹没真正要测的断言。
    // 组织创建限流本身由 organization.test.ts 专门覆盖。
    new RateLimitService(new MysqlRateLimitRepo(() => db), false),
    tokenService,
    emailSender,
    (fn) => withTransaction(db, fn),
  );
  return { svc, userRepo, membershipRepo, invitationRepo, emailSender };
}

async function makeVerifiedUser(userRepo: MysqlUserRepo, db: MysqlDb, email: string) {
  const user = await userRepo.create(email, 'hash');
  await db.query('UPDATE users SET email_verified_time = NOW() WHERE id = ?', [user.id]);
  return user;
}

async function inviteAndGetToken(stack: Awaited<ReturnType<typeof makeStack>>, orgId: number, adminUserId: number, email: string) {
  await stack.svc.inviteMember(orgId, adminUserId, email);
  return stack.emailSender.sent.filter((m) => m.kind === 'invitation').at(-1)!.token!;
}

describe.skipIf(!URL)('invitation (real MySQL)', () => {
  it('invite then accept persists active membership and single-use token', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const adminEmail = uniqueEmail('admin');
      const admin = await makeVerifiedUser(stack.userRepo, db, adminEmail);
      const org = await stack.svc.createOrganization(admin.id, 'Acme');

      const targetEmail = uniqueEmail('t');
      const target = await makeVerifiedUser(stack.userRepo, db, targetEmail);
      const token = await inviteAndGetToken(stack, org.organizationId, admin.id, targetEmail);

      const result = await stack.svc.acceptInvitation(token, target.id);
      expect(result.organization.organizationId).toBe(org.organizationId);

      const members = await stack.svc.listMembers(org.organizationId);
      const m = members.find((x) => x.userId === target.id);
      expect(m?.status).toBe('active');

      await expect(stack.svc.acceptInvitation(token, target.id)).rejects.toBeInstanceOf(InvitationInvalidError);
    } finally {
      await pool.end();
    }
  });

  it('concurrent invites do not exceed seat_limit', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
      const org = await stack.svc.createOrganization(admin.id, 'Acme'); // seat 3，admin 占 1

      const emails = [uniqueEmail('a'), uniqueEmail('b'), uniqueEmail('c')];
      for (const email of emails) await makeVerifiedUser(stack.userRepo, db, email);

      const results = await Promise.allSettled(emails.map((email) => stack.svc.inviteMember(org.organizationId, admin.id, email)));
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const quota = results.filter((r) => r.status === 'rejected' && (r as any).reason instanceof OrganizationQuotaExceededError);
      expect(fulfilled).toHaveLength(2);
      expect(quota).toHaveLength(1);

      const [rows] = (await db.query(
        "SELECT COUNT(*) AS cnt FROM organization_memberships WHERE organization_id = ? AND status IN ('active','invited')",
        [org.organizationId],
      )) as [Array<{ cnt: number }>, unknown];
      expect(Number(rows[0].cnt)).toBe(3);
    } finally {
      await pool.end();
    }
  });

  it('re-inviting the same target keeps exactly one pending invitation', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
      const org = await stack.svc.createOrganization(admin.id, 'Acme');
      const targetEmail = uniqueEmail('t');
      await makeVerifiedUser(stack.userRepo, db, targetEmail);

      await stack.svc.inviteMember(org.organizationId, admin.id, targetEmail);
      await stack.svc.inviteMember(org.organizationId, admin.id, targetEmail);

      const [rows] = (await db.query(
        "SELECT COUNT(*) AS cnt FROM organization_invitations WHERE organization_id = ? AND accepted_time IS NULL AND revoked_time IS NULL",
        [org.organizationId],
      )) as [Array<{ cnt: number }>, unknown];
      expect(Number(rows[0].cnt)).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('accept rejects email mismatch', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
      const org = await stack.svc.createOrganization(admin.id, 'Acme');
      const targetEmail = uniqueEmail('t');
      await makeVerifiedUser(stack.userRepo, db, targetEmail);
      const other = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('o'));

      const token = await inviteAndGetToken(stack, org.organizationId, admin.id, targetEmail);
      await expect(stack.svc.acceptInvitation(token, other.id)).rejects.toBeInstanceOf(InvitationInvalidError);
    } finally {
      await pool.end();
    }
  });

  it('expire cleanup releases capacity idempotently', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
      const org = await stack.svc.createOrganization(admin.id, 'Acme');
      const targetEmail = uniqueEmail('t');
      const target = await makeVerifiedUser(stack.userRepo, db, targetEmail);
      const r = await stack.svc.inviteMember(org.organizationId, admin.id, targetEmail);

      // 把 expires_time 改为过去，模拟自然过期
      const past = new Date(Date.now() - 1000);
      await db.query('UPDATE organization_invitations SET expires_time = ? WHERE id = ?', [past, r.invitationId]);

      await stack.svc.expireInvitations();
      await stack.svc.expireInvitations(); // 幂等

      const members = await stack.svc.listMembers(org.organizationId);
      expect(members.find((x) => x.userId === target.id)).toBeUndefined();
      const [rows] = (await db.query(
        "SELECT COUNT(*) AS cnt FROM organization_memberships WHERE organization_id = ? AND status = 'invited'",
        [org.organizationId],
      )) as [Array<{ cnt: number }>, unknown];
      expect(Number(rows[0].cnt)).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('accept rejects missing subscription', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
      const org = await stack.svc.createOrganization(admin.id, 'Acme');
      const targetEmail = uniqueEmail('t');
      const target = await makeVerifiedUser(stack.userRepo, db, targetEmail);
      const token = await inviteAndGetToken(stack, org.organizationId, admin.id, targetEmail);

      await db.query('DELETE FROM organization_subscriptions WHERE organization_id = ?', [org.organizationId]);
      await expect(stack.svc.acceptInvitation(token, target.id)).rejects.toBeInstanceOf(InvitationInvalidError);
    } finally {
      await pool.end();
    }
  });

  it('accept rejects expired/canceled subscription', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
      const org = await stack.svc.createOrganization(admin.id, 'Acme');
      const targetEmail = uniqueEmail('t');
      const target = await makeVerifiedUser(stack.userRepo, db, targetEmail);
      const token = await inviteAndGetToken(stack, org.organizationId, admin.id, targetEmail);

      await db.query("UPDATE organization_subscriptions SET status = 'expired' WHERE organization_id = ?", [org.organizationId]);
      await expect(stack.svc.acceptInvitation(token, target.id)).rejects.toBeInstanceOf(InvitationInvalidError);
    } finally {
      await pool.end();
    }
  });

  it('concurrent accept vs revoke: exactly one wins, terminal state consistent', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
      const org = await stack.svc.createOrganization(admin.id, 'Acme');
      const targetEmail = uniqueEmail('t');
      const target = await makeVerifiedUser(stack.userRepo, db, targetEmail);
      const token = await inviteAndGetToken(stack, org.organizationId, admin.id, targetEmail);
      const [invRows] = (await db.query('SELECT id FROM organization_invitations WHERE organization_id = ?', [org.organizationId])) as [Array<{ id: number }>, unknown];
      const invitationId = invRows[0].id;

      const results = await Promise.allSettled([
        stack.svc.acceptInvitation(token, target.id),
        stack.svc.revokeInvitation(org.organizationId, admin.id, invitationId),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      const [inv] = (await db.query('SELECT accepted_time, revoked_time FROM organization_invitations WHERE id = ?', [invitationId])) as [Array<{ accepted_time: Date | null; revoked_time: Date | null }>, unknown];
      expect((inv[0].accepted_time === null) !== (inv[0].revoked_time === null)).toBe(true);

      const [m] = (await db.query('SELECT status FROM organization_memberships WHERE organization_id = ? AND user_id = ?', [org.organizationId, target.id])) as [Array<{ status: string }>, unknown];
      if (inv[0].accepted_time !== null) expect(m[0].status).toBe('active');
      else expect(m[0].status).toBe('removed');
    } finally {
      await pool.end();
    }
  });

  it('concurrent re-invite vs expire: no deadlock, at most one pending token, capacity intact', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
      const org = await stack.svc.createOrganization(admin.id, 'Acme');
      const targetEmail = uniqueEmail('t');
      await makeVerifiedUser(stack.userRepo, db, targetEmail);
      await stack.svc.inviteMember(org.organizationId, admin.id, targetEmail);

      // 让既有邀请已过期，同时并发重邀（会复用 membership 并作废旧 token）
      await db.query("UPDATE organization_invitations SET expires_time = ? WHERE organization_id = ?", [new Date(Date.now() - 1000), org.organizationId]);

      const results = await Promise.allSettled([
        stack.svc.expireInvitations(),
        stack.svc.inviteMember(org.organizationId, admin.id, targetEmail),
      ]);
      // 冒烟：两侧都拿到 org 行锁后串行化，任何一方都不应因死锁被回滚成 500
      for (const r of results) {
        if (r.status === 'rejected') {
          expect((r.reason as { code?: string; errno?: number }).code).not.toBe('ER_LOCK_DEADLOCK');
          expect((r.reason as { code?: string; errno?: number }).errno).not.toBe(1213);
        }
      }

      const [pending] = (await db.query(
        "SELECT COUNT(*) AS cnt FROM organization_invitations WHERE organization_id = ? AND accepted_time IS NULL AND revoked_time IS NULL",
        [org.organizationId],
      )) as [Array<{ cnt: number }>, unknown];
      expect(Number(pending[0].cnt)).toBeLessThanOrEqual(1);
      const [occ] = (await db.query(
        "SELECT COUNT(*) AS cnt FROM organization_memberships WHERE organization_id = ? AND status IN ('active','invited')",
        [org.organizationId],
      )) as [Array<{ cnt: number }>, unknown];
      expect(Number(occ[0].cnt)).toBeLessThanOrEqual(3);
    } finally {
      await pool.end();
    }
  });

  it('concurrent accept vs expire: accept must fail, terminal state revoked + removed', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
      const org = await stack.svc.createOrganization(admin.id, 'Acme');
      const targetEmail = uniqueEmail('t');
      const target = await makeVerifiedUser(stack.userRepo, db, targetEmail);
      const token = await inviteAndGetToken(stack, org.organizationId, admin.id, targetEmail);
      await db.query("UPDATE organization_invitations SET expires_time = ? WHERE organization_id = ?", [new Date(Date.now() - 1000), org.organizationId]);

      const results = await Promise.allSettled([
        stack.svc.expireInvitations(),
        stack.svc.acceptInvitation(token, target.id),
      ]);
      // expires_time 已过期，accept 无论先于/后于 expire 都必须失败（自身校验 expiresTime<=now）
      expect(results[1].status).toBe('rejected');
      expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(InvitationInvalidError);

      // 确定性终态：expire 回收容量 —— invitation revoked、未被接受、membership removed
      const [inv] = (await db.query('SELECT accepted_time, revoked_time FROM organization_invitations WHERE organization_id = ?', [org.organizationId])) as [Array<{ accepted_time: Date | null; revoked_time: Date | null }>, unknown];
      expect(inv[0].accepted_time).toBeNull();
      expect(inv[0].revoked_time).not.toBeNull();
      const [m] = (await db.query('SELECT status FROM organization_memberships WHERE organization_id = ? AND user_id = ?', [org.organizationId, target.id])) as [Array<{ status: string }>, unknown];
      expect(m[0].status).toBe('removed');
    } finally {
      await pool.end();
    }
  });

  it('revokeInvitation cross-organization id returns NOT_FOUND', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
      const orgA = await stack.svc.createOrganization(admin.id, 'A');
      const orgB = await stack.svc.createOrganization(admin.id, 'B');
      const targetEmail = uniqueEmail('t');
      await makeVerifiedUser(stack.userRepo, db, targetEmail);
      const r = await stack.svc.inviteMember(orgA.organizationId, admin.id, targetEmail);

      await expect(stack.svc.revokeInvitation(orgB.organizationId, admin.id, r.invitationId)).rejects.toBeInstanceOf(EntityNotFoundError);
    } finally {
      await pool.end();
    }
  });

  it('closeOrganization revokes pending invitations', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
      const org = await stack.svc.createOrganization(admin.id, 'Acme');
      const targetEmail = uniqueEmail('t');
      const target = await makeVerifiedUser(stack.userRepo, db, targetEmail);
      const r = await stack.svc.inviteMember(org.organizationId, admin.id, targetEmail);

      await stack.svc.closeOrganization(org.organizationId, admin.id);
      const [rows] = (await db.query(
        "SELECT revoked_time FROM organization_invitations WHERE id = ?",
        [r.invitationId],
      )) as [Array<{ revoked_time: Date | null }>, unknown];
      expect(rows[0].revoked_time).not.toBeNull();

      const members = await stack.svc.listMembers(org.organizationId);
      expect(members.find((x) => x.userId === target.id)).toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});