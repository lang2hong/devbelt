import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { consoleDataRoutes } from '../../src/route/consoleData.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import {
  FakeUserRepo,
  FakePersonalSubscriptionRepo,
  FakeMembershipRepo,
  FakeOrganizationRepo,
  FakeRateLimitRepo,
  FakeSyncStateRepo,
  FakeSyncRecordRepo,
} from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

async function build(): Promise<{ app: FastifyInstance; tokenService: TokenService; userRepo: FakeUserRepo; orgRepo: FakeOrganizationRepo; memberships: FakeMembershipRepo; auditRepo: FakeAuditRepo }> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);
  const userRepo = new FakeUserRepo();
  const orgRepo = new FakeOrganizationRepo();
  const memberships = new FakeMembershipRepo(userRepo, orgRepo);
  const auditRepo = new FakeAuditRepo();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);

  await app.register(consoleDataRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    auditWriter: new AuditWriter(auditRepo),
    rateLimiter: new RateLimitService(new FakeRateLimitRepo(), false),
    userRepo,
    personalSubscriptionRepo: new FakePersonalSubscriptionRepo(),
    membershipRepo: memberships,
    organizationRepo: orgRepo,
    syncStateRepo: new FakeSyncStateRepo(),
    syncRecordRepo: new FakeSyncRecordRepo(),
    db: {} as Queryable,
  });
  await app.ready();
  return { app, tokenService, userRepo, orgRepo, memberships, auditRepo };
}

async function consoleToken(tokenService: TokenService, userId: number): Promise<string> {
  return tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 's', sessionVersion: 0 });
}

describe('console data routes', () => {
  it('sync overview returns initialized:false without state', async () => {
    const { app, tokenService, userRepo } = await build();
    const u = await userRepo.create('sync@b.com', 'hash', 'S');
    const token = await consoleToken(tokenService, u.id);
    const res = await app.inject({ method: 'GET', url: '/api/console/sync/overview', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().initialized).toBe(false);
    expect(res.json().activeRecordCount).toBe(0);
    await app.close();
  });

  it('members: admin sees email, member does not', async () => {
    const { app, tokenService, userRepo, orgRepo, memberships } = await build();
    const admin = await userRepo.create('admin@b.com', 'hash', 'A');
    const member = await userRepo.create('member@b.com', 'hash', 'M');
    const org = await orgRepo.create({} as Queryable, { name: 'Acme' });
    await memberships.create({} as Queryable, { organizationId: org.id, userId: admin.id, role: 'admin', status: 'active', invitedByUserId: null, joinedTime: new Date(), removedTime: null });
    await memberships.create({} as Queryable, { organizationId: org.id, userId: member.id, role: 'member', status: 'active', invitedByUserId: null, joinedTime: new Date(), removedTime: null });

    const adminRes = await app.inject({
      method: 'GET',
      url: `/api/console/organizations/${org.id}/members`,
      headers: { authorization: `Bearer ${await consoleToken(tokenService, admin.id)}`, accept: 'application/json' },
    });
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.json().members.find((m: any) => m.userId === String(member.id)).email).toBe('member@b.com');

    const memberRes = await app.inject({
      method: 'GET',
      url: `/api/console/organizations/${org.id}/members`,
      headers: { authorization: `Bearer ${await consoleToken(tokenService, member.id)}`, accept: 'application/json' },
    });
    expect(memberRes.statusCode).toBe(200);
    expect(memberRes.json().members.find((m: any) => m.userId === String(member.id)).email).toBeUndefined();
    await app.close();
  });

  it('members: closed organization returns 404', async () => {
    const { app, tokenService, userRepo, orgRepo, memberships } = await build();
    const admin = await userRepo.create('admin2@b.com', 'hash', 'A');
    const org = await orgRepo.create({} as Queryable, { name: 'Closed' });
    await memberships.create({} as Queryable, { organizationId: org.id, userId: admin.id, role: 'admin', status: 'active', invitedByUserId: null, joinedTime: new Date(), removedTime: null });
    await orgRepo.close({} as Queryable, org.id, new Date());

    const res = await app.inject({
      method: 'GET',
      url: `/api/console/organizations/${org.id}/members`,
      headers: { authorization: `Bearer ${await consoleToken(tokenService, admin.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('sync overview: missing Accept returns 406 NOT_ACCEPTABLE', async () => {
    const { app, tokenService, userRepo } = await build();
    const u = await userRepo.create('noaccept@b.com', 'hash', 'N');
    const token = await consoleToken(tokenService, u.id);
    const res = await app.inject({ method: 'GET', url: '/api/console/sync/overview', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(406);
    expect(res.json().error.code).toBe('NOT_ACCEPTABLE');
    await app.close();
  });

  it('sync overview: Accept text/html returns 406 NOT_ACCEPTABLE', async () => {
    const { app, tokenService, userRepo } = await build();
    const u = await userRepo.create('html@b.com', 'hash', 'H');
    const token = await consoleToken(tokenService, u.id);
    const res = await app.inject({
      method: 'GET',
      url: '/api/console/sync/overview',
      headers: { authorization: `Bearer ${token}`, accept: 'text/html' },
    });
    expect(res.statusCode).toBe(406);
    expect(res.json().error.code).toBe('NOT_ACCEPTABLE');
    await app.close();
  });

  it('sync overview: Accept application/json passes', async () => {
    const { app, tokenService, userRepo } = await build();
    const u = await userRepo.create('json@b.com', 'hash', 'J');
    const token = await consoleToken(tokenService, u.id);
    const res = await app.inject({
      method: 'GET',
      url: '/api/console/sync/overview',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('members: admin read writes restricted-read audit with redacted sourceIp', async () => {
    const { app, tokenService, userRepo, orgRepo, memberships, auditRepo } = await build();
    const admin = await userRepo.create('admin3@b.com', 'hash', 'A');
    const org = await orgRepo.create({} as Queryable, { name: 'AuditOrg' });
    await memberships.create({} as Queryable, { organizationId: org.id, userId: admin.id, role: 'admin', status: 'active', invitedByUserId: null, joinedTime: new Date(), removedTime: null });

    await app.inject({
      method: 'GET',
      url: `/api/console/organizations/${org.id}/members`,
      remoteAddress: '198.51.100.23',
      headers: { authorization: `Bearer ${await consoleToken(tokenService, admin.id)}`, accept: 'application/json' },
    });
    await new Promise((r) => setTimeout(r, 0));

    const events = auditRepo.events.filter((e) => e.eventType === 'organization.member_email.read');
    expect(events).toHaveLength(1);
    expect(events[0].sourceIp).toBe('198.51.100.0');
    expect(events[0].targetId).toBe(String(org.id));
    await app.close();
  });

  it('members: non-admin read does not write restricted-read audit', async () => {
    const { app, tokenService, userRepo, orgRepo, memberships, auditRepo } = await build();
    const member = await userRepo.create('member2@b.com', 'hash', 'M');
    const org = await orgRepo.create({} as Queryable, { name: 'PlainOrg' });
    await memberships.create({} as Queryable, { organizationId: org.id, userId: member.id, role: 'member', status: 'active', invitedByUserId: null, joinedTime: new Date(), removedTime: null });

    const res = await app.inject({
      method: 'GET',
      url: `/api/console/organizations/${org.id}/members`,
      headers: { authorization: `Bearer ${await consoleToken(tokenService, member.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(auditRepo.events.filter((e) => e.eventType === 'organization.member_email.read')).toHaveLength(0);
    await app.close();
  });
});