import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync } from 'crypto';
import { organizationRoutes } from '../../src/route/organizations.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { IdempotencyService } from '../../src/service/idempotencyService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { OrganizationService } from '../../src/service/organizationService.js';
import {
  FakeUserRepo,
  FakeOrganizationRepo,
  FakePlanRepo,
  FakeOrganizationSubscriptionRepo,
  FakeMembershipRepo,
  FakeInvitationRepo,
  FakeRateLimitRepo,
  FakeIdempotencyReceiptRepo,
} from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

/**
 * 回归：`GET …/folders`、`GET …/resources`、`DELETE …/resources/:resourceId`
 * 此前无 HTTP 级测试（评审发现的预存缺口）。此处经真实鉴权中间件 + stub 资源服务断言。
 */
describe('organization resource/folder routes', () => {
  async function build() {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(requestId);

    const userRepo = new FakeUserRepo();
    const organizationRepo = new FakeOrganizationRepo();
    const membershipRepo = new FakeMembershipRepo(userRepo, organizationRepo);
    const resourceCalls: Array<{ op: string; organizationId: number; resourceId?: number; actorUserId?: number }> = [];
    const resourceService = {
      listFolders: async (organizationId: number) => {
        resourceCalls.push({ op: 'listFolders', organizationId });
        return [{ folderId: 7, name: 'Reports', parentId: null }, { folderId: 8, name: 'Nested', parentId: 7 }];
      },
      listResources: async (organizationId: number) => {
        resourceCalls.push({ op: 'listResources', organizationId });
        return [{ resourceId: 9, resourceType: 'sql', name: 'Query A', folderId: null, version: 1, createdByMembershipId: 1, updatedByMembershipId: null }];
      },
      deleteResource: async (organizationId: number, actorUserId: number, resourceId: number) => {
        resourceCalls.push({ op: 'deleteResource', organizationId, resourceId, actorUserId });
        return { deleted: String(resourceId) };
      },
    } as any;

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
    const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
    const runner = async (fn: any) => fn({} as Queryable);
    const organizationService = new OrganizationService(
      userRepo, organizationRepo, new FakePlanRepo(), new FakeOrganizationSubscriptionRepo(), membershipRepo, new FakeInvitationRepo(membershipRepo),
      new RateLimitService(new FakeRateLimitRepo(), false), tokenService,
      { sendInvitationEmail: async () => {} } as any, runner,
    );

    await app.register(organizationRoutes, {
      tokenService,
      getUser: async (id) => userRepo.findById(id),
      getSessionActive: async () => true,
      csrfService: new CsrfService(Buffer.alloc(32, 11)),
      consoleOrigin: 'http://localhost:5173',
      organizationService,
      resourceService,
      organizationRepo,
      membershipRepo,
      auditWriter: new AuditWriter(new FakeAuditRepo()),
      idempotencyService: new IdempotencyService(new FakeIdempotencyReceiptRepo(), runner),
      sendInvitation: async () => {},
    });
    await app.ready();

    const extToken = (userId: number) => tokenService.signAccessToken({ userId, aud: 'extension', scope: ['organization'], sessionId: 's1', sessionVersion: 0 });

    async function seedOrg(): Promise<number> {
      const org = await organizationRepo.create({} as Queryable, { name: 'Acme' });
      return org.id;
    }

    async function addMember(orgId: number, role: 'admin' | 'member', email: string): Promise<number> {
      const user = await userRepo.create(email, 'hash', undefined);
      await membershipRepo.create({} as Queryable, {
        organizationId: orgId, userId: user.id, role, status: 'active',
        invitedByUserId: null, joinedTime: new Date(), removedTime: null,
      });
      return user.id;
    }

    async function seedAdmin(): Promise<{ userId: number; orgId: number }> {
      const orgId = await seedOrg();
      const userId = await addMember(orgId, 'admin', 'res-admin@b.com');
      return { userId, orgId };
    }

    return { app, extToken, seedAdmin, seedOrg, addMember, resourceCalls, userRepo };
  }

  it('GET /folders 返回 DTO 化目录列表', async () => {
    const b = await build();
    const { userId, orgId } = await b.seedAdmin();
    const res = await b.app.inject({
      method: 'GET', url: `/api/organizations/${orgId}/folders`,
      headers: { authorization: `Bearer ${await b.extToken(userId)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().folders).toEqual([
      { folderId: '7', name: 'Reports', parentId: null },
      { folderId: '8', name: 'Nested', parentId: '7' },
    ]);
    expect(b.resourceCalls).toContainEqual({ op: 'listFolders', organizationId: orgId });
    await b.app.close();
  });

  it('GET /resources 返回 DTO 化资源摘要', async () => {
    const b = await build();
    const { userId, orgId } = await b.seedAdmin();
    const res = await b.app.inject({
      method: 'GET', url: `/api/organizations/${orgId}/resources`,
      headers: { authorization: `Bearer ${await b.extToken(userId)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resources).toEqual([
      { resourceId: '9', resourceType: 'sql', name: 'Query A', folderId: null, version: 1, createdByMembershipId: '1', updatedByMembershipId: null },
    ]);
    await b.app.close();
  });

  it('DELETE /resources/:id 透传裁决结果并带 actorUserId', async () => {
    const b = await build();
    const { userId, orgId } = await b.seedAdmin();
    const res = await b.app.inject({
      method: 'DELETE', url: `/api/organizations/${orgId}/resources/9`,
      headers: { authorization: `Bearer ${await b.extToken(userId)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: '9' });
    expect(b.resourceCalls).toContainEqual({ op: 'deleteResource', organizationId: orgId, resourceId: 9, actorUserId: userId });
    await b.app.close();
  });

  it('有效用户但非该组织成员 → 404 ORGANIZATION_NOT_FOUND（防枚举）', async () => {
    const b = await build();
    const orgId = await b.seedOrg();
    await b.addMember(orgId, 'admin', 'admin-a@b.com');
    // 另一组织的成员访问本组织：有效用户、无本组织 membership → 404（不泄露组织是否存在）。
    const otherOrgUser = await b.addMember(await b.seedOrg(), 'admin', 'outsider@b.com');
    const res = await b.app.inject({
      method: 'GET', url: `/api/organizations/${orgId}/folders`,
      headers: { authorization: `Bearer ${await b.extToken(otherOrgUser)}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ORGANIZATION_NOT_FOUND');
    await b.app.close();
  });

  it('成员但权限不足 → 403 FORBIDDEN', async () => {
    const b = await build();
    const orgId = await b.seedOrg();
    await b.addMember(orgId, 'admin', 'admin-b@b.com');
    const memberUserId = await b.addMember(orgId, 'member', 'member-b@b.com');
    // member 角色无 resource.delete 权限 → 403（区别于非成员的 404）。
    const res = await b.app.inject({
      method: 'DELETE', url: `/api/organizations/${orgId}/resources/9`,
      headers: { authorization: `Bearer ${await b.extToken(memberUserId)}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
    await b.app.close();
  });
});