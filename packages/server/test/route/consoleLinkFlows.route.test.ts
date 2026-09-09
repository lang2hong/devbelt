import Fastify from 'fastify';
import { createHash, generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { consoleLinkFlowRoutes } from '../../src/route/consoleLinkFlows.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { LinkFlowService } from '../../src/service/linkFlowService.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import { csrfCookieName, linkFlowCookieName } from '../../src/middleware/cookies.js';
import { FakeMailFlowRepo, FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import {
  FakeUserRepo,
  FakeEmailVerificationTokenRepo,
  FakeRateLimitRepo,
  FakeOrganizationRepo,
  FakeOrganizationSubscriptionRepo,
  FakeMembershipRepo,
  FakeInvitationRepo,
} from '../helpers/fakeRepos.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const ORIGIN = 'http://localhost:5173';
const SESSION = 'test-session-accept';
const INVITE_TOKEN = 'I'.repeat(43);

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function build(serviceOverride?: unknown) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const userRepo = new FakeUserRepo();
  const mailFlowRepo = new FakeMailFlowRepo();
  const tokenRepo = new FakeEmailVerificationTokenRepo();
  const orgRepo = new FakeOrganizationRepo();
  const membershipRepo = new FakeMembershipRepo(userRepo, orgRepo);
  const invitationRepo = new FakeInvitationRepo(membershipRepo);
  const subscriptionRepo = new FakeOrganizationSubscriptionRepo();
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), false);
  const realService = new LinkFlowService(
    mailFlowRepo, tokenRepo, userRepo, invitationRepo, orgRepo, subscriptionRepo, membershipRepo,
    async (fn) => fn({} as Queryable), rateLimiter,
  );
  const linkFlowService = (serviceOverride ?? realService) as LinkFlowService;
  const auditRepo = new FakeAuditRepo();

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 7));

  await app.register(consoleLinkFlowRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    linkFlowService,
    csrfService,
    auditWriter: new AuditWriter(auditRepo),
    rateLimiter,
    consoleOrigin: ORIGIN,
  });
  await app.ready();
  return { app, tokenService, csrfService, userRepo, orgRepo, membershipRepo, invitationRepo, subscriptionRepo, linkFlowService, auditRepo, mailFlowRepo };
}

type Built = Awaited<ReturnType<typeof build>>;

async function setupInvited(b: Built, email = 'member@b.com') {
  const user = await b.userRepo.create(email, 'hash', 'M');
  await b.userRepo.markEmailVerified({} as Queryable, user.id, new Date());
  const org = await b.orgRepo.create({} as Queryable, { name: 'Acme' });
  await b.subscriptionRepo.create({} as Queryable, {
    organizationId: org.id, planId: 1, seatLimit: 3, status: 'active',
    entitlementSnapshot: {}, periodStartTime: new Date(), periodEndTime: null,
  });
  const membership = await b.membershipRepo.create({} as Queryable, {
    organizationId: org.id, userId: user.id, role: 'member', status: 'invited',
    invitedByUserId: null, joinedTime: null, removedTime: null,
  });
  const invitation = await b.invitationRepo.create({} as Queryable, {
    organizationId: org.id, membershipId: membership.id, email,
    tokenHash: sha256hex(INVITE_TOKEN), expiresTime: new Date(Date.now() + 60_000),
  });
  return { user, org, membership, invitation };
}

function consoleToken(tokenService: TokenService, userId: number): Promise<string> {
  return tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: SESSION, sessionVersion: 0 });
}

function setCookies(res: any): string[] {
  const sc = res.headers['set-cookie'];
  if (!sc) return [];
  return Array.isArray(sc) ? sc : [sc];
}

function headersFor(nonce: string | undefined, token: string, csrf: string): Record<string, string> {
  const cookie = `${csrfCookieName()}=${csrf}` + (nonce ? `; ${linkFlowCookieName()}=${nonce}` : '');
  return { origin: ORIGIN, authorization: `Bearer ${token}`, accept: 'application/json', 'x-csrf-token': csrf, cookie };
}

async function bindViaEndpoint(b: Built, nonce: string, token: string, csrf: string) {
  return b.app.inject({ method: 'POST', url: '/api/console/link-flows/bind', headers: headersFor(nonce, token, csrf) });
}

describe('console link-flow accept-invitation route', () => {
  it('bind endpoint binds the flow, then accept accepts it and clears the cookie', async () => {
    const b = await build();
    const { user, org } = await setupInvited(b);
    const nonce = (await b.linkFlowService.claim({ type: 'accept-invitation', token: INVITE_TOKEN })).nonce;
    const token = await consoleToken(b.tokenService, user.id);
    const csrf = b.csrfService.issue(SESSION);

    const bindRes = await bindViaEndpoint(b, nonce, token, csrf);
    expect(bindRes.statusCode).toBe(200);
    expect(bindRes.json()).toEqual({ ok: true });

    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/link-flows/accept-invitation',
      headers: headersFor(nonce, token, csrf),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().organization).toMatchObject({ organizationId: String(org.id), name: 'Acme', role: 'member' });

    const cleared = setCookies(res).some((c) => c.startsWith(`${linkFlowCookieName()}=`) && c.includes('Max-Age=0'));
    expect(cleared).toBe(true);

    await new Promise((r) => setTimeout(r, 0));
    const ev = b.auditRepo.events.filter((e) => e.eventType === 'invitation.accept');
    expect(ev).toHaveLength(1);
    expect(ev[0].result).toBe('success');
    expect(JSON.stringify(ev[0])).not.toContain(INVITE_TOKEN);
    expect(JSON.stringify(ev[0])).not.toContain(nonce);
    await b.app.close();
  });

  it('rejects consuming an unbound flow with 400 before any side effects', async () => {
    const b = await build();
    const { user, membership } = await setupInvited(b);
    const nonce = (await b.linkFlowService.claim({ type: 'accept-invitation', token: INVITE_TOKEN })).nonce;
    const token = await consoleToken(b.tokenService, user.id);
    const csrf = b.csrfService.issue(SESSION);

    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/link-flows/accept-invitation',
      headers: headersFor(nonce, token, csrf),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVITATION_INVALID');
    expect(b.membershipRepo.store.get(membership.id)!.status).toBe('invited');
    await b.app.close();
  });

  it('rejects a request without a link-flow cookie with 400 INVITATION_INVALID', async () => {
    const b = await build();
    const { user } = await setupInvited(b);
    const token = await consoleToken(b.tokenService, user.id);
    const csrf = b.csrfService.issue(SESSION);

    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/link-flows/accept-invitation',
      headers: headersFor(undefined, token, csrf),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVITATION_INVALID');
    await b.app.close();
  });

  it('rejects a request without CSRF/origin with 403 FORBIDDEN', async () => {
    const b = await build();
    const { user } = await setupInvited(b);
    const token = await consoleToken(b.tokenService, user.id);

    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/link-flows/accept-invitation',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    await b.app.close();
  });

  it('returns 409 INVITATION_ALREADY_ACCEPTED when the invitation was already accepted', async () => {
    const b = await build();
    const { user, membership, invitation, org } = await setupInvited(b);
    await b.invitationRepo.markAccepted({} as Queryable, invitation.id, new Date());
    await b.membershipRepo.activate({} as Queryable, membership.id, new Date());

    const nonce = (await b.linkFlowService.claim({ type: 'accept-invitation', token: INVITE_TOKEN })).nonce;
    const token = await consoleToken(b.tokenService, user.id);
    const csrf = b.csrfService.issue(SESSION);

    await bindViaEndpoint(b, nonce, token, csrf);

    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/link-flows/accept-invitation',
      headers: headersFor(nonce, token, csrf),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVITATION_ALREADY_ACCEPTED');
    expect(res.json().organization).toMatchObject({ organizationId: String(org.id) });
    await b.app.close();
  });

  it('returns 400 INVITATION_INVALID for a cross-account login and audits failure', async () => {
    const b = await build();
    const { user: member } = await setupInvited(b);
    const intruder = await b.userRepo.create('intruder@b.com', 'hash', 'X');
    await b.userRepo.markEmailVerified({} as Queryable, intruder.id, new Date());

    const nonce = (await b.linkFlowService.claim({ type: 'accept-invitation', token: INVITE_TOKEN })).nonce;
    const token = await consoleToken(b.tokenService, intruder.id);
    const csrf = b.csrfService.issue(SESSION);

    await bindViaEndpoint(b, nonce, token, csrf);

    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/link-flows/accept-invitation',
      headers: headersFor(nonce, token, csrf),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVITATION_INVALID');
    // 不泄露：member 不被激活。
    expect(await b.membershipRepo.listActiveByUser(member.id)).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 0));
    const ev = b.auditRepo.events.filter((e) => e.eventType === 'invitation.accept');
    expect(ev).toHaveLength(1);
    expect(ev[0].result).toBe('failure');
    expect(JSON.stringify(ev[0])).not.toContain(INVITE_TOKEN);
    expect(JSON.stringify(ev[0])).not.toContain(nonce);
    await b.app.close();
  });

  it('keeps the cookie on a 5xx service failure so the client can retry', async () => {
    const b = await build({
      acceptInvitation: async () => {
        throw new Error('db unavailable');
      },
      bindFlowToUser: async () => {},
    });
    const user = await b.userRepo.create('retry@b.com', 'hash', 'R');
    await b.userRepo.markEmailVerified({} as Queryable, user.id, new Date());
    const token = await consoleToken(b.tokenService, user.id);
    const csrf = b.csrfService.issue(SESSION);
    const nonce = 'N'.repeat(43);

    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/link-flows/accept-invitation',
      headers: headersFor(nonce, token, csrf),
    });
    expect(res.statusCode).toBe(500);
    const cleared = setCookies(res).some((c) => c.startsWith(`${linkFlowCookieName()}=`) && c.includes('Max-Age=0'));
    expect(cleared).toBe(false);
    await b.app.close();
  });
});