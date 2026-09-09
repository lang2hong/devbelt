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
import { csrfCookieName } from '../../src/middleware/cookies.js';
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
import type { Queryable, TxRunner } from '../../src/repository/mysql/db.js';

const ORIGIN = 'http://localhost:5173';
const UUID_V4 = '123e4567-e89b-42d3-8456-426614174000';
const DAY = 86_400_000;

async function build(rateLimitEnabled = false) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const userRepo = new FakeUserRepo();
  const organizationRepo = new FakeOrganizationRepo();
  const organizationPlanRepo = new FakeOrganizationPlanRepo();
  const organizationSubscriptionRepo = new FakeOrganizationSubscriptionRepo();
  const membershipRepo = new FakeMembershipRepo(userRepo, organizationRepo);
  const invitationRepo = new FakeInvitationRepo(membershipRepo);
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), rateLimitEnabled);
  const idemRepo = new FakeIdempotencyReceiptRepo();
  const auditRepo = new FakeAuditRepo();
  const sentEmails: Array<{ to: string; token: string }> = [];

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 11));

  const runner: TxRunner = async (fn) => fn({} as Queryable);
  const organizationService = new OrganizationService(
    userRepo, organizationRepo, organizationPlanRepo, organizationSubscriptionRepo, membershipRepo, invitationRepo,
    rateLimiter, tokenService,
    { sendInvitationEmail: async (o: any) => { sentEmails.push(o); } } as any,
    runner,
  );

  await app.register(organizationRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    csrfService,
    consoleOrigin: ORIGIN,
    organizationService,
    resourceService: {} as any,
    organizationRepo,
    membershipRepo,
    auditWriter: new AuditWriter(auditRepo),
    idempotencyService: new IdempotencyService(idemRepo, runner),
    sendInvitation: async (o) => { sentEmails.push({ to: o.email, token: o.token }); },
  });
  await app.ready();

  const extToken = (userId: number) => tokenService.signAccessToken({ userId, aud: 'extension', scope: ['organization'], sessionId: 's1', sessionVersion: 0 });
  const consoleToken = (userId: number) => tokenService.signAccessToken({ userId, aud: 'console', scope: ['organization'], sessionId: 'ws', sessionVersion: 0 });

  return { app, tokenService, csrfService, userRepo, organizationRepo, organizationSubscriptionRepo, membershipRepo, invitationRepo, idemRepo, auditRepo, sentEmails, rateLimiter, extToken, consoleToken };
}

type Built = Awaited<ReturnType<typeof build>>;

async function makeAdmin(b: Built, email = 'admin@b.com') {
  const user = await b.userRepo.create(email, 'hash', undefined);
  const org = await b.organizationRepo.create({} as Queryable, { name: 'Acme' });
  await b.membershipRepo.create({} as Queryable, {
    organizationId: org.id, userId: user.id, role: 'admin', status: 'active',
    invitedByUserId: null, joinedTime: new Date(), removedTime: null,
  });
  await b.organizationSubscriptionRepo.create({} as Queryable, {
    organizationId: org.id, planId: 1, seatLimit: 3, status: 'active',
    entitlementSnapshot: {}, periodStartTime: new Date(), periodEndTime: null,
  });
  return { user, org };
}

describe('organization write idempotency', () => {
  it('extension create without a key keeps direct behavior (no receipt)', async () => {
    const b = await build();
    const user = await b.userRepo.create('ext@b.com', 'hash', undefined);
    const res = await b.app.inject({
      method: 'POST', url: '/api/organizations',
      headers: { authorization: `Bearer ${await b.extToken(user.id)}` },
      payload: { name: 'Acme' },
    });
    expect(res.statusCode).toBe(201);
    expect(b.idemRepo.store.size).toBe(0);
    await b.app.close();
  });

  it('console create without a key returns 400 flat VALIDATION_FAILED', async () => {
    const b = await build();
    const user = await b.userRepo.create('con@b.com', 'hash', undefined);
    const token = await b.consoleToken(user.id);
    const csrf = b.csrfService.issue('ws');
    const res = await b.app.inject({
      method: 'POST', url: '/api/organizations',
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, 'x-csrf-token': csrf, cookie: `${csrfCookieName()}=${csrf}` },
      payload: { name: 'Acme' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
    await b.app.close();
  });

  it('create with a key replays on the same key and does not create a second organization', async () => {
    const b = await build();
    const user = await b.userRepo.create('idem@b.com', 'hash', undefined);
    const token = await b.extToken(user.id);
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': UUID_V4 };

    const first = await b.app.inject({ method: 'POST', url: '/api/organizations', headers, payload: { name: 'Acme' } });
    expect(first.statusCode).toBe(201);
    const orgId = first.json().organization.organizationId;

    const second = await b.app.inject({ method: 'POST', url: '/api/organizations', headers, payload: { name: 'Acme' } });
    expect(second.statusCode).toBe(201);
    expect(second.json().organization.organizationId).toBe(orgId);
    expect(b.organizationRepo.store.size).toBe(1);

    await new Promise((r) => setTimeout(r, 0));
    expect(b.auditRepo.events.filter((e) => e.eventType === 'organization.created')).toHaveLength(1);
    await b.app.close();
  });

  it('same key with a different body returns 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const b = await build();
    const user = await b.userRepo.create('conflict@b.com', 'hash', undefined);
    const token = await b.extToken(user.id);
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': UUID_V4 };

    await b.app.inject({ method: 'POST', url: '/api/organizations', headers, payload: { name: 'Acme' } });
    const res = await b.app.inject({ method: 'POST', url: '/api/organizations', headers, payload: { name: 'Other' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    await b.app.close();
  });

  it('close organization uses a 30-day receipt retention', async () => {
    const b = await build();
    const { user, org } = await makeAdmin(b);
    const token = await b.extToken(user.id);
    const res = await b.app.inject({
      method: 'POST', url: `/api/organizations/${org.id}/close`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': UUID_V4 },
    });
    expect(res.statusCode).toBe(200);

    const receipt = await b.idemRepo.findByKey(user.id, 's1', 'POST', `/api/organizations/${org.id}/close`, UUID_V4);
    expect(receipt).toBeDefined();
    expect(receipt!.expiresTime.getTime() - Date.now()).toBeGreaterThan(29 * DAY);
    await b.app.close();
  });

  it('invite with a key does not resend the invitation email on replay', async () => {
    const b = await build();
    const { user: admin, org } = await makeAdmin(b, 'admin@b.com');
    const target = await b.userRepo.create('target@b.com', 'hash', undefined);
    await b.userRepo.markEmailVerified({} as Queryable, target.id, new Date());
    const token = await b.extToken(admin.id);
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': UUID_V4 };

    const first = await b.app.inject({
      method: 'POST', url: `/api/organizations/${org.id}/invitations`,
      headers, payload: { email: 'target@b.com', role: 'member' },
    });
    expect(first.statusCode).toBe(201);
    expect(b.sentEmails).toHaveLength(1);

    const second = await b.app.inject({
      method: 'POST', url: `/api/organizations/${org.id}/invitations`,
      headers, payload: { email: 'target@b.com', role: 'member' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().invitation.invitationId).toBe(first.json().invitation.invitationId);
    expect(b.sentEmails).toHaveLength(1);

    // 审计只写一次（重放不重复审计）。
    await new Promise((r) => setTimeout(r, 0));
    expect(b.auditRepo.events.filter((e) => e.eventType === 'invitation.create')).toHaveLength(1);
    await b.app.close();
  });

  it('close replays even after the organization is already closed', async () => {
    const b = await build();
    const { user, org } = await makeAdmin(b);
    const token = await b.extToken(user.id);
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': UUID_V4 };

    const first = await b.app.inject({ method: 'POST', url: `/api/organizations/${org.id}/close`, headers });
    expect(first.statusCode).toBe(200);

    // 组织已关闭：同 key 重试仍须重放首个 200，而非组织状态 404。
    const retry = await b.app.inject({ method: 'POST', url: `/api/organizations/${org.id}/close`, headers });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    await b.app.close();
  });

  it('leave replays even after the actor is no longer a member', async () => {
    const b = await build();
    const { org } = await makeAdmin(b, 'admin@b.com');
    const member = await b.userRepo.create('leaver@b.com', 'hash', undefined);
    await b.membershipRepo.create({} as Queryable, {
      organizationId: org.id, userId: member.id, role: 'member', status: 'active',
      invitedByUserId: null, joinedTime: new Date(), removedTime: null,
    });
    const token = await b.extToken(member.id);
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': UUID_V4 };

    const first = await b.app.inject({ method: 'POST', url: `/api/organizations/${org.id}/leave`, headers });
    expect(first.statusCode).toBe(200);

    // 成员已退出：同 key 重试仍须重放 200，而非 membership 404。
    const retry = await b.app.inject({ method: 'POST', url: `/api/organizations/${org.id}/leave`, headers });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    await b.app.close();
  });

  it('replays after the actor was removed/demoted (completed receipt wins over live auth)', async () => {
    const b = await build();
    const { user: owner, org } = await makeAdmin(b, 'owner@b.com');
    const target = await b.userRepo.create('member@b.com', 'hash', undefined);
    const targetM = await b.membershipRepo.create({} as Queryable, {
      organizationId: org.id, userId: target.id, role: 'member', status: 'active',
      invitedByUserId: null, joinedTime: new Date(), removedTime: null,
    });
    const ownerM = await b.membershipRepo.findByOrgAndUser(org.id, owner.id)!;
    const token = await b.extToken(owner.id);
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': UUID_V4 };

    const first = await b.app.inject({
      method: 'PATCH', url: `/api/organizations/${org.id}/members/${targetM.id}`,
      headers, payload: { role: 'admin' },
    });
    expect(first.statusCode).toBe(200);

    // 操作者随后被移除：同 key 重放仍须返回首个 200，而非 404/403。
    await b.membershipRepo.remove({} as Queryable, ownerM!.id, new Date());
    const retry = await b.app.inject({
      method: 'PATCH', url: `/api/organizations/${org.id}/members/${targetM.id}`,
      headers, payload: { role: 'admin' },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    await b.app.close();
  });

  it('after hitting the create throttle, a completed key still replays while a new key returns 429', async () => {
    const b = await build(true);
    const user = await b.userRepo.create('throttle@b.com', 'hash', undefined);
    const token = await b.extToken(user.id);

    // 首次创建（占 1 次配额）+ 收到回执。
    const first = await b.app.inject({
      method: 'POST', url: '/api/organizations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': UUID_V4 }, payload: { name: 'A' },
    });
    expect(first.statusCode).toBe(201);

    // 填满配额桶（10/10）。
    for (let i = 0; i < 9; i++) {
      await b.rateLimiter.hit(`org:create:user:${user.id}`, 3600, 10);
    }

    // 同 key 重放 → 201（回执优先，不消耗新增配额）。
    const replay = await b.app.inject({
      method: 'POST', url: '/api/organizations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': UUID_V4 }, payload: { name: 'A' },
    });
    expect(replay.statusCode).toBe(201);

    // 新 key → 429。
    const fresh = await b.app.inject({
      method: 'POST', url: '/api/organizations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': '223e4567-e89b-42d3-8456-426614174000' }, payload: { name: 'B' },
    });
    expect(fresh.statusCode).toBe(429);
    await b.app.close();
  });
});