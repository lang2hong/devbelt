import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync } from 'crypto';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { personalRoutes } from '../../src/route/personal.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { IdempotencyService } from '../../src/service/idempotencyService.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import {
  FakeUserRepo,
  FakeDeviceRepo,
  FakeRefreshTokenRepo,
  FakeIdempotencyReceiptRepo,
} from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const ORIGIN = 'http://localhost:5173';

async function makeUser(t: TestApp, email: string) {
  const user = await t.repos.userRepo.create(email, 'hash', undefined);
  const token = await t.tokenFor(user.id);
  return { id: user.id, token };
}

describe('personal routes smoke', () => {
  it('GET /api/me requires auth and returns the user', async () => {
    const t = await buildTestApp();
    const anon = await t.app.inject({ method: 'GET', url: '/api/me' });
    expect(anon.statusCode).toBe(401);

    const { token } = await makeUser(t, 'me@b.com');
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.user.userId).toBe('string');
    expect(body.user.email).toBe('me@b.com');
    expect(body.subscription).toBeNull();
    await t.close();
  });

  it('GET /api/personal/subscription requires auth and returns nulls without a subscription', async () => {
    const t = await buildTestApp();
    const anon = await t.app.inject({ method: 'GET', url: '/api/personal/subscription' });
    expect(anon.statusCode).toBe(401);

    const { token } = await makeUser(t, 'sub@b.com');
    const res = await t.app.inject({ method: 'GET', url: '/api/personal/subscription', headers: t.auth(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ planCode: null, status: null, entitlement: null });
    await t.close();
  });

  it('reports the entitlement shape when a Free subscription exists', async () => {
    const t = await buildTestApp();
    const { id, token } = await makeUser(t, 'ent@b.com');
    const plan = await t.repos.personalPlanRepo.findByCode('free');
    await t.repos.personalSubscriptionRepo.create({
      userId: id,
      planId: plan!.id,
      status: 'active',
      entitlementSnapshot: { allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 0 },
      periodStartTime: new Date(),
      periodEndTime: null,
    });

    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().subscription.planCode).toBe('free');
    expect(me.json().subscription.entitlement).toEqual({ allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 0 });
    expect(me.json().subscription.entitlement.maxDevices).toBe(0);
    expect(Object.keys(me.json().subscription).sort()).toEqual([
      'entitlement', 'periodEndTime', 'periodStartTime', 'planCode', 'status',
    ]);

    const sub = await t.app.inject({ method: 'GET', url: '/api/personal/subscription', headers: t.auth(token) });
    expect(sub.statusCode).toBe(200);
    expect(sub.json()).toEqual({
      planCode: 'free',
      status: 'active',
      entitlement: { allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 0 },
    });
    await t.close();
  });

  it('GET/DELETE /api/personal/devices lists and revokes a device', async () => {
    const t = await buildTestApp();
    const anon = await t.app.inject({ method: 'GET', url: '/api/personal/devices' });
    expect(anon.statusCode).toBe(401);

    const anonDel = await t.app.inject({ method: 'DELETE', url: '/api/personal/devices/1' });
    expect(anonDel.statusCode).toBe(401);

    const { id, token } = await makeUser(t, 'dev@b.com');
    const empty = await t.app.inject({ method: 'GET', url: '/api/personal/devices', headers: t.auth(token) });
    expect(empty.json().devices).toEqual([]);

    const device = await t.repos.deviceRepo.upsert({} as Queryable, {
      userId: id,
      deviceKey: 'device-key-00000001',
      devicePlatform: 'linux',
      deviceName: 'laptop',
      clientVersion: '1.0.0',
      status: 'active',
      lastUsedTime: null,
    });

    const list = await t.app.inject({ method: 'GET', url: '/api/personal/devices', headers: t.auth(token) });
    expect(list.json().devices).toHaveLength(1);
    const dto = list.json().devices[0];
    expect(String(dto.deviceId)).toBe(String(device.id));
    expect(Object.keys(dto).sort()).toEqual([
      'clientVersion', 'createTime', 'deviceId', 'deviceName', 'devicePlatform', 'lastUsedTime', 'status',
    ]);

    const del = await t.app.inject({ method: 'DELETE', url: `/api/personal/devices/${device.id}`, headers: { ...t.auth(token), 'idempotency-key': '123e4567-e89b-42d3-8456-426614174000' } });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const after = await t.app.inject({ method: 'GET', url: '/api/personal/devices', headers: t.auth(token) });
    expect(after.json().devices[0].status).toBe('revoked');
    await t.close();
  });

  it('filters the device list to the caller and rejects cross-user revoke', async () => {
    const t = await buildTestApp();
    const first = await makeUser(t, 'first@b.com');
    const second = await makeUser(t, 'second@b.com');

    const firstDevice = await t.repos.deviceRepo.upsert({} as Queryable, {
      userId: first.id,
      deviceKey: 'dk-first',
      devicePlatform: 'linux',
      deviceName: 'first',
      clientVersion: '1.0.0',
      status: 'active',
      lastUsedTime: null,
    });
    const secondDevice = await t.repos.deviceRepo.upsert({} as Queryable, {
      userId: second.id,
      deviceKey: 'dk-second',
      devicePlatform: 'mac',
      deviceName: 'second',
      clientVersion: '1.0.0',
      status: 'active',
      lastUsedTime: null,
    });

    const list = await t.app.inject({ method: 'GET', url: '/api/personal/devices', headers: t.auth(first.token) });
    expect(list.statusCode).toBe(200);
    const ids = list.json().devices.map((d: any) => String(d.deviceId));
    expect(ids).toEqual([String(firstDevice.id)]);

    const crossDel = await t.app.inject({ method: 'DELETE', url: `/api/personal/devices/${secondDevice.id}`, headers: { ...t.auth(first.token), 'idempotency-key': '123e4567-e89b-42d3-8456-426614174000' } });
    expect(crossDel.statusCode).toBe(404);
    expect(crossDel.json().code).toBe('NOT_FOUND');

    const secondList = await t.app.inject({ method: 'GET', url: '/api/personal/devices', headers: t.auth(second.token) });
    expect(secondList.statusCode).toBe(200);
    expect(secondList.json().devices).toHaveLength(1);
    expect(secondList.json().devices[0].status).toBe('active');
    await t.close();
  });

  it('requires an Idempotency-Key for console audience but not for extension', async () => {
    const t = await buildTestApp();
    const user = await t.repos.userRepo.create('aud@b.com', 'hash', undefined);
    const device = await t.repos.deviceRepo.upsert({} as Queryable, {
      userId: user.id, deviceKey: 'dk-aud', devicePlatform: 'linux', deviceName: 'x', clientVersion: '1', status: 'active', lastUsedTime: null,
    });

    // 扩展无 key → 沿用原撤销行为，200。
    const extToken = await t.tokenFor(user.id);
    const ext = await t.app.inject({ method: 'DELETE', url: `/api/personal/devices/${device.id}`, headers: t.auth(extToken) });
    expect(ext.statusCode).toBe(200);
    expect(ext.json()).toEqual({ ok: true });

    // 扩展带 key → 亦成功（回执路径）。
    const device2 = await t.repos.deviceRepo.upsert({} as Queryable, {
      userId: user.id, deviceKey: 'dk-aud2', devicePlatform: 'linux', deviceName: 'x', clientVersion: '1', status: 'active', lastUsedTime: null,
    });
    const extKeyed = await t.app.inject({
      method: 'DELETE', url: `/api/personal/devices/${device2.id}`,
      headers: { ...t.auth(extToken), 'idempotency-key': '123e4567-e89b-42d3-8456-426614174000' },
    });
    expect(extKeyed.statusCode).toBe(200);
    expect(extKeyed.json()).toEqual({ ok: true });

    // Console 无 key → 400 平铺 VALIDATION_FAILED。
    const consoleToken = await t.tokenService.signAccessToken({ userId: user.id, aud: 'console', scope: ['device'], sessionId: 'ws', sessionVersion: 0 });
    const csrf = t.csrfService.issue('ws');
    const con = await t.app.inject({
      method: 'DELETE', url: `/api/personal/devices/${device2.id}`,
      headers: { origin: ORIGIN, authorization: `Bearer ${consoleToken}`, 'x-csrf-token': csrf, cookie: `${csrfCookieName()}=${csrf}` },
    });
    expect(con.statusCode).toBe(400);
    expect(con.json().code).toBe('VALIDATION_FAILED');
    await t.close();
  });

  it('current-device revoke invalidates the session so a retry is rejected (idempotency exception)', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(requestId);

    const userRepo = new FakeUserRepo();
    const deviceRepo = new FakeDeviceRepo();
    const refreshTokenRepo = new FakeRefreshTokenRepo();
    const csrfService = new CsrfService(Buffer.alloc(32, 9));
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
    const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);

    async function revokeInTx(tx: Queryable, userId: number, deviceId: number): Promise<{ ok: true }> {
      await userRepo.lockById(tx, userId);
      const device = await deviceRepo.findByIdForUpdate(tx, deviceId);
      if (!device || device.userId !== userId) throw new Error('device not found');
      const now = new Date();
      await deviceRepo.revoke(tx, device.id, now);
      await refreshTokenRepo.revokeByDevice(tx, device.id, now);
      return { ok: true };
    }

    await app.register(personalRoutes, {
      tokenService,
      getUser: async (id) => userRepo.findById(id),
      getSessionActive: (sid) => refreshTokenRepo.hasActiveToken(sid),
      auditWriter: new AuditWriter(new FakeAuditRepo()),
      csrfService,
      consoleOrigin: ORIGIN,
      deviceRepo,
      idempotencyService: new IdempotencyService(new FakeIdempotencyReceiptRepo(), async (fn) => fn({} as Queryable)),
      revokeDevice: async (userId, deviceId) => revokeInTx({} as Queryable, userId, deviceId),
      revokeDeviceInTx: revokeInTx,
    });
    await app.ready();

    const user = await userRepo.create('session@b.com', 'hash', undefined);
    const device = await deviceRepo.upsert({} as Queryable, {
      userId: user.id, deviceKey: 'dk-session', devicePlatform: 'linux', deviceName: 'x', clientVersion: '1', status: 'active', lastUsedTime: null,
    });
    await refreshTokenRepo.create({} as Queryable, {
      userId: user.id, deviceId: device.id, tokenHash: 'hash', familyId: 'fam', replacedByTokenId: null, expiresTime: new Date(Date.now() + 3600_000),
    });
    const token = await tokenService.signAccessToken({ userId: user.id, aud: 'extension', scope: ['device'], sessionId: 'fam', deviceId: device.id, sessionVersion: 0 });

    const first = await app.inject({ method: 'DELETE', url: `/api/personal/devices/${device.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(first.statusCode).toBe(200);
    expect(first.json().code).toBe('CURRENT_SESSION_REVOKED');
    expect(deviceRepo.store.get(device.id)!.status).toBe('revoked');

    // 相同 access token 重试：refresh family 已撤销 → session-active 校验拒绝为 401，到不了回执重放。
    const retry = await app.inject({ method: 'DELETE', url: `/api/personal/devices/${device.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(retry.statusCode).toBe(401);
    await app.close();
  });
});
