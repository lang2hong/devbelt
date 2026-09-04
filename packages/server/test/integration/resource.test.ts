import { describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import { generateKeyPairSync } from 'crypto';
import { createTestPool } from './testDb.js';
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
import { MysqlFolderRepo } from '../../src/repository/mysql/folderRepo.js';
import { MysqlResourceRepo } from '../../src/repository/mysql/resourceRepo.js';
import { OrganizationService } from '../../src/service/organizationService.js';
import { OrganizationResourceService } from '../../src/service/organizationResourceService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { TokenService } from '../../src/service/tokenService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import { canonicalJsonBytes } from '../../src/service/resourceContent.js';
import {
  ResourceNotFoundError,
  ResourceVersionConflictError,
  OrganizationQuotaExceededError,
  FolderMoveCycleError,
  FolderNotEmptyError,
} from '../../src/domain/errors.js';

const URL = process.env.MYSQL_TEST_URL;

function uniqueEmail(prefix = 'res'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

function newPool(): mysql.Pool {
  return createTestPool();
}

async function makeStack(db: MysqlDb) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const tokenService = new TokenService({ kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) }, '15m', 30 * 24 * 3600 * 1000);
  const runner = (fn: (tx: any) => Promise<any>) => withTransaction(db, fn);
  const organizationRepo = new MysqlOrganizationRepo(() => db);
  const organizationSubscriptionRepo = new MysqlOrganizationSubscriptionRepo(() => db);
  const membershipRepo = new MysqlMembershipRepo(() => db);

  const orgSvc = new OrganizationService(
    new MysqlUserRepo(() => db),
    organizationRepo,
    new MysqlOrganizationPlanRepo(() => db),
    organizationSubscriptionRepo,
    membershipRepo,
    new MysqlOrganizationInvitationRepo(() => db),
    // 关限流：本文件验证资源/目录逻辑，不验证限流（同 invitation.test.ts）。
    new RateLimitService(new MysqlRateLimitRepo(() => db), false),
    tokenService,
    new MemoryEmailSender(),
    runner,
  );
  const resourceSvc = new OrganizationResourceService(
    organizationRepo,
    organizationSubscriptionRepo,
    membershipRepo,
    new MysqlFolderRepo(() => db),
    new MysqlResourceRepo(() => db),
    runner,
  );
  return { orgSvc, resourceSvc, userRepo: new MysqlUserRepo(() => db), membershipRepo };
}

async function makeVerifiedUser(userRepo: MysqlUserRepo, db: MysqlDb, email: string) {
  const user = await userRepo.create(email, 'hash');
  await db.query('UPDATE users SET email_verified_time = NOW() WHERE id = ?', [user.id]);
  return user;
}

async function makeOrg(stack: Awaited<ReturnType<typeof makeStack>>, db: MysqlDb) {
  const admin = await makeVerifiedUser(stack.userRepo, db, uniqueEmail('admin'));
  const org = await stack.orgSvc.createOrganization(admin.id, 'Acme');
  return { org, adminUserId: admin.id };
}

async function setSnapshot(db: MysqlDb, orgId: number, snapshot: Record<string, unknown>) {
  await db.query('UPDATE organization_subscriptions SET entitlement_snapshot = ? WHERE organization_id = ?', [JSON.stringify(snapshot), orgId]);
}

describe.skipIf(!URL)('organization resources (real MySQL)', () => {
  const QUERY: Record<string, unknown> = { sql: 'select 1' };

  it('concurrent update with same baseVersion: exactly one wins', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const { org, adminUserId } = await makeOrg(stack, db);
      const created = await stack.resourceSvc.createResource(org.organizationId, adminUserId, { resourceType: 'query', name: 'q', content: QUERY });

      const results = await Promise.allSettled([
        stack.resourceSvc.updateResource(org.organizationId, adminUserId, created.resourceId, { baseVersion: 1, name: 'a' }),
        stack.resourceSvc.updateResource(org.organizationId, adminUserId, created.resourceId, { baseVersion: 1, name: 'b' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected' && (r as any).reason instanceof ResourceVersionConflictError)).toHaveLength(1);

      const got = await stack.resourceSvc.getResource(org.organizationId, created.resourceId);
      expect(got.version).toBe(2);
    } finally {
      await pool.end();
    }
  });

  it('cross-organization resource id returns RESOURCE_NOT_FOUND', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const a = await makeOrg(stack, db);
      const b = await makeOrg(stack, db);
      const created = await stack.resourceSvc.createResource(a.org.organizationId, a.adminUserId, { resourceType: 'query', name: 'q', content: QUERY });
      await expect(stack.resourceSvc.getResource(b.org.organizationId, created.resourceId)).rejects.toBeInstanceOf(ResourceNotFoundError);
    } finally {
      await pool.end();
    }
  });

  it('enforces count quota and byte quota by canonical JSON bytes', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const { org, adminUserId } = await makeOrg(stack, db);

      const bytes = canonicalJsonBytes(QUERY);
      await setSnapshot(db, org.organizationId, { includedSeats: 3, maxSharedResources: 1, sharedStorageQuotaBytes: bytes, allowedTemplateDatabaseTypes: ['mysql'] });
      const q1 = await stack.resourceSvc.createResource(org.organizationId, adminUserId, { resourceType: 'query', name: 'q1', content: QUERY });
      // 数量维度：第二个即超限
      await expect(stack.resourceSvc.createResource(org.organizationId, adminUserId, { resourceType: 'query', name: 'q2', content: QUERY }))
        .rejects.toBeInstanceOf(OrganizationQuotaExceededError);

      // 软删释放后，字节维度：放开数量，字节配额恰好等于一条的 canonical 大小
      await stack.resourceSvc.deleteResource(org.organizationId, adminUserId, q1.resourceId);
      await setSnapshot(db, org.organizationId, { includedSeats: 3, maxSharedResources: 0, sharedStorageQuotaBytes: bytes, allowedTemplateDatabaseTypes: ['mysql'] });
      const first = await stack.resourceSvc.createResource(org.organizationId, adminUserId, { resourceType: 'query', name: 'q3', content: QUERY });
      expect(first.resourceId).toBeTruthy();
      await expect(stack.resourceSvc.createResource(org.organizationId, adminUserId, { resourceType: 'query', name: 'q4', content: QUERY }))
        .rejects.toBeInstanceOf(OrganizationQuotaExceededError);
    } finally {
      await pool.end();
    }
  });

  it('folder cycle and non-empty deletion in a real tree', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const stack = await makeStack(db);
      const { org, adminUserId } = await makeOrg(stack, db);

      const a = await stack.resourceSvc.createFolder(org.organizationId, adminUserId, 'A');
      const b = await stack.resourceSvc.createFolder(org.organizationId, adminUserId, 'B', a.folderId);
      await expect(stack.resourceSvc.updateFolder(org.organizationId, adminUserId, a.folderId, { parentId: b.folderId })).rejects.toBeInstanceOf(FolderMoveCycleError);

      await stack.resourceSvc.createResource(org.organizationId, adminUserId, { resourceType: 'query', name: 'q', folderId: b.folderId, content: QUERY });
      await expect(stack.resourceSvc.deleteFolder(org.organizationId, adminUserId, b.folderId)).rejects.toBeInstanceOf(FolderNotEmptyError);
    } finally {
      await pool.end();
    }
  });
});