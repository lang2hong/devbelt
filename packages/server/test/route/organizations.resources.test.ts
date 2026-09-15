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
  FakeOrganizationPlanRepo,
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
      userRepo, organizationRepo, new FakeOrganizationPlanRepo(), new FakeOrganizationSubscriptionRepo(), membershipRepo, new FakeInvitationRepo(membershipRepo),
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

    async function seedAdmin(): Promise<{ userId: number; orgId: number }> {
      const user = await userRepo.create('res-admin@b.com', 'hash', undefined);
      const org = await organizationRepo.create({} as Queryable, { name: 'Acme' });
      await membershipRepo.create({} as Queryable, {
        organizationId: org.id, userId: user.id, role: 'admin', status: 'active',
        invitedByUserId: null, joinedTime: new Date(), removedTime: null,
      });
      return { userId: user.id, orgId: org.id };
    }

    return { app, extToken, seedAdmin, resourceCalls };
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

  it('非成员访问被拒（授权门禁）', async () => {
    const b = await build();
    const { orgId } = await b.seedAdmin();
    const outsider = await b.app.inject({
      method: 'GET', url: `/api/organizations/${orgId}/folders`,
      headers: { authorization: `Bearer ${await b.extToken(999)}` },
    });
    expect(outsider.statusCode).toBeGreaterThanOrEqual(400);
    await b.app.close();
  });
});