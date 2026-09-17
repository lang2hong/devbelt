import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { plansRoutes, consolePlansRoutes } from '../../src/modules/billing/route/plans.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import type { PlanFeatureDef } from '../../src/domain/entities.js';
import {
  FakePlanRepo,
  FakePlanFeatureDefRepo,
  FakeUserRepo,
  makeFreePlan,
  makeProPlan,
  makeOrganizationFreePlan,
} from '../helpers/fakeRepos.js';

const SESSION = 'test-session-plans';

const DEF = (id: number, key: string, kind: PlanFeatureDef['kind'], valueType: PlanFeatureDef['valueType'], sortOrder: number): PlanFeatureDef => ({
  id, key, kind, valueType, unit: null, sortOrder, label: { en: key, zh: key },
});

const FEATURE_DEFS: PlanFeatureDef[] = [
  DEF(1, 'allowedDatabaseTypes', 'both', 'stringList', 10),
  DEF(2, 'maxSavedConnections', 'personal', 'number', 20),
  DEF(3, 'maxConnectionMetas', 'personal', 'number', 30),
  DEF(4, 'syncStorageBytes', 'personal', 'bytes', 40),
  DEF(5, 'allowConnectionImport', 'personal', 'bool', 50),
  DEF(6, 'maxDevices', 'personal', 'number', 60),
  DEF(7, 'allowedTemplateDatabaseTypes', 'organization', 'stringList', 10),
  DEF(8, 'includedSeats', 'organization', 'number', 20),
  DEF(9, 'maxSharedResources', 'organization', 'number', 30),
  DEF(10, 'sharedStorageQuotaBytes', 'organization', 'bytes', 40),
];

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
    planRepo: new FakePlanRepo([makeFreePlan(), makeProPlan(), makeOrganizationFreePlan()]),
    featureDefRepo: new FakePlanFeatureDefRepo(FEATURE_DEFS),
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
  it('GET /api/db/plans returns personal + organization catalog with feature descriptors and prices', async () => {
    const { app, tokenService, userId } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/db/plans', headers: { authorization: `Bearer ${await extToken(tokenService, userId)}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.personal.map((p: any) => p.code)).toEqual(['free', 'pro']);
    expect(body.organization.map((p: any) => p.code)).toEqual(['organization_free']);

    const free = body.personal[0];
    const pro = body.personal[1];
    expect(free.billing).toEqual({ unit: 'month', priceCents: 0 });
    expect(pro.billing).toEqual({ unit: 'month', priceCents: 9900 });

    expect(pro.features.find((f: any) => f.key === 'allowedDatabaseTypes')).toMatchObject({ type: 'stringList', value: ['mysql', 'postgresql', 'sqlite'] });
    expect(pro.features.find((f: any) => f.key === 'allowConnectionImport')).toMatchObject({ type: 'bool', value: true });
    expect(pro.features.find((f: any) => f.key === 'syncStorageBytes')).toMatchObject({ type: 'bytes', value: 268435456 });

    const org = body.organization[0];
    expect(org.billing).toEqual({ unit: 'seat-month', priceCents: 0 });
    expect(org.features.find((f: any) => f.key === 'includedSeats')).toMatchObject({ type: 'number', value: 3 });

    await app.close();
  });

  it('GET /api/db/plans requires authentication', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/db/plans' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/db/console/plans accepts the console audience', async () => {
    const { app, tokenService, userId } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/db/console/plans', headers: { authorization: `Bearer ${await consoleToken(tokenService, userId)}`, accept: 'application/json' } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().personal)).toBe(true);
    await app.close();
  });

  it('rejects an extension token on /api/db/console/plans', async () => {
    const { app, tokenService, userId } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/db/console/plans', headers: { authorization: `Bearer ${await extToken(tokenService, userId)}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TOKEN_AUDIENCE_FORBIDDEN');
    await app.close();
  });
});