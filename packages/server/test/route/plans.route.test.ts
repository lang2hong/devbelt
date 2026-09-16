import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { plansRoutes, consolePlansRoutes } from '../../src/route/plans.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import type { PersonalPlan } from '../../src/domain/entities.js';
import {
  FakePersonalPlanRepo,
  FakeOrganizationPlanRepo,
  FakeUserRepo,
  makeFreePlan,
  makeOrganizationFreePlan,
} from '../helpers/fakeRepos.js';

const SESSION = 'test-session-plans';

const PRO: PersonalPlan = {
  id: 9001,
  code: 'pro',
  name: 'Pro',
  allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'],
  maxDevices: 0,
  maxConnectionMetas: 5000,
  syncStorageBytes: 268435456,
  maxSavedConnections: 100,
  allowConnectionImport: true,
  status: 'active',
  createTime: new Date(),
  updateTime: new Date(),
};

async function buildApp(): Promise<{ app: FastifyInstance; tokenService: TokenService; userId: number }> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);

  const userRepo = new FakeUserRepo();
  const user = await userRepo.create('plans@b.com', 'hash', 'Plans');

  const common = {
    tokenService,
    getUser: async (id: number) => userRepo.findById(id),
    getSessionActive: async () => true,
    personalPlanRepo: new FakePersonalPlanRepo([makeFreePlan(), PRO]),
    organizationPlanRepo: new FakeOrganizationPlanRepo([makeOrganizationFreePlan()]),
  };
  await app.register(plansRoutes, common);
  await app.register(consolePlansRoutes, common);

  await app.ready();
  return { app, tokenService, userId: user.id };
}

function extToken(tokenService: TokenService, userId: number): Promise<string> {
  return tokenService.signAccessToken({ userId, aud: 'extension', scope: ['account'], sessionId: SESSION, sessionVersion: 0 });
}

function consoleToken(tokenService: TokenService, userId: number): Promise<string> {
  return tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: SESSION, sessionVersion: 0 });
}

describe('plans routes', () => {
  it('GET /api/plans returns personal + organization catalog with feature descriptors and prices', async () => {
    const { app, tokenService, userId } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/plans', headers: { authorization: `Bearer ${await extToken(tokenService, userId)}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.personal.map((p: any) => p.code)).toEqual(['free', 'pro']);
    expect(body.organization.map((p: any) => p.code)).toEqual(['organization_free']);

    const free = body.personal[0];
    const pro = body.personal[1];
    expect(free.billing).toEqual({ unit: 'month', priceCents: 0 });
    expect(pro.billing).toEqual({ unit: 'month', priceCents: 9900 });

    const engines = pro.features.find((f: any) => f.key === 'allowedDatabaseTypes');
    expect(engines).toEqual({ key: 'allowedDatabaseTypes', type: 'stringList', value: ['mysql', 'postgresql', 'sqlite'] });
    expect(pro.features.find((f: any) => f.key === 'allowConnectionImport')).toEqual({ key: 'allowConnectionImport', type: 'bool', value: true });
    expect(pro.features.find((f: any) => f.key === 'syncStorageBytes')).toEqual({ key: 'syncStorageBytes', type: 'bytes', value: 268435456 });

    const org = body.organization[0];
    expect(org.billing).toEqual({ unit: 'seat-month', priceCents: 0 });
    expect(org.features.find((f: any) => f.key === 'includedSeats')).toEqual({ key: 'includedSeats', type: 'number', value: 3 });

    await app.close();
  });

  it('GET /api/plans requires authentication', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/plans' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/console/plans accepts the console audience', async () => {
    const { app, tokenService, userId } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/console/plans', headers: { authorization: `Bearer ${await consoleToken(tokenService, userId)}`, accept: 'application/json' } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().personal)).toBe(true);
    await app.close();
  });

  it('rejects an extension token on /api/console/plans', async () => {
    const { app, tokenService, userId } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/console/plans', headers: { authorization: `Bearer ${await extToken(tokenService, userId)}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TOKEN_AUDIENCE_FORBIDDEN');
    await app.close();
  });
});