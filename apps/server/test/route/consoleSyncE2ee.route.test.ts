import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { consoleDataRoutes } from '../../src/modules/db/route/consoleData.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import { FakeUserRepo, FakePersonalSubscriptionRepo, FakePlanRepo, FakeRateLimitRepo } from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const ENVELOPE = { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: 'n', ct: 'c', tag: 't' };

async function build(opts: { state?: unknown; pull?: unknown }): Promise<{ app: FastifyInstance; tokenService: TokenService; userRepo: FakeUserRepo; stateRepoRef: { findByUserId: (id: number) => Promise<unknown> } }> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);
  const userRepo = new FakeUserRepo();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const stateRepoRef = { findByUserId: async () => opts.state };
  await app.register(consoleDataRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    auditWriter: new AuditWriter(new FakeAuditRepo()),
    rateLimiter: new RateLimitService(new FakeRateLimitRepo(), false),
    userRepo,
    personalSubscriptionRepo: new FakePersonalSubscriptionRepo(),
    planRepo: new FakePlanRepo(),
    syncStateRepo: stateRepoRef as never,
    syncRecordRepo: {} as never,
    syncState: { getState: async () => ({ protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, keyEpoch: '1', stateVersion: '1', changeSequence: '5', signPub: 'SIGNPUB', smpKdf: { alg: 'argon2id', salt: 'SALT' }, envelopeSmp: ENVELOPE }) } as never,
    syncRecordService: { pull: async (_u: number, after: string) => opts.pull ?? ({ snapshotSequence: '5', nextAfter: after === '0' ? '2' : undefined, records: [{ recordId: 'R1', version: '1', changeSequence: '1', deleteTime: null, cipherSuite: 'AES-256-GCM', formatVersion: 1, nonce: 'NONCE', ciphertext: 'CIPHER', tag: 'TAG' }] }) } as never,
    db: {} as Queryable,
  });
  await app.ready();
  return { app, tokenService, userRepo, stateRepoRef };
}
async function consoleToken(tokenService: TokenService, userId: number): Promise<string> {
  return tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 's', sessionVersion: 0 });
}
const H = (token: string) => ({ authorization: `Bearer ${token}`, accept: 'application/json' });

describe('P6-S5a console E2EE routes', () => {
  it('e2ee-params without state → initialized:false', async () => {
    const { app, tokenService, userRepo } = await build({ state: undefined });
    const u = await userRepo.create('e1@b.com', 'h', 'E');
    const res = await app.inject({ method: 'GET', url: '/api/db/console/sync/e2ee-params', headers: H(await consoleToken(tokenService, u.id)) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ initialized: false });
    await app.close();
  });

  it('e2ee-params with state → returns KDF/envelope, never secret', async () => {
    const { app, tokenService, userRepo } = await build({ state: { keyEpoch: '1' } });
    const u = await userRepo.create('e2@b.com', 'h', 'E');
    const res = await app.inject({ method: 'GET', url: '/api/db/console/sync/e2ee-params', headers: H(await consoleToken(tokenService, u.id)) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.initialized).toBe(true);
    expect(body.smpKdf).toMatchObject({ alg: 'argon2id' });
    expect(body.envelopeSmp).toMatchObject({ cipherSuite: 'AES-256-GCM' });
    expect(body.signPub).toBe('SIGNPUB');
    expect(res.body.toLowerCase()).not.toContain('secret');
  });

  it('records without state → initialized:false, empty feed', async () => {
    const { app, tokenService, userRepo } = await build({ state: undefined });
    const u = await userRepo.create('r1@b.com', 'h', 'R');
    const res = await app.inject({ method: 'GET', url: '/api/db/console/sync/records', headers: H(await consoleToken(tokenService, u.id)) });
    expect(res.json()).toEqual({ initialized: false, snapshotSequence: '0', records: [] });
    await app.close();
  });

  it('records with state → ciphertext feed with pagination, no plaintext', async () => {
    const { app, tokenService, userRepo } = await build({ state: { keyEpoch: '1' } });
    const u = await userRepo.create('r2@b.com', 'h', 'R');
    const res = await app.inject({ method: 'GET', url: '/api/db/console/sync/records?after=0&limit=50', headers: H(await consoleToken(tokenService, u.id)) });
    const body = res.json();
    expect(body.initialized).toBe(true);
    expect(body.snapshotSequence).toBe('5');
    expect(body.nextAfter).toBe('2');
    expect(body.records[0]).toMatchObject({ recordId: 'R1', ciphertext: 'CIPHER', version: '1' });
    expect(res.body.toLowerCase()).not.toContain('secret');
    await app.close();
  });
});
