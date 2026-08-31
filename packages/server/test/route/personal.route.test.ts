import { describe, it, expect } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

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

  it('reports the V3 entitlement shape when a Free subscription exists', async () => {
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

    const del = await t.app.inject({ method: 'DELETE', url: `/api/personal/devices/${device.id}`, headers: t.auth(token) });
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

    const crossDel = await t.app.inject({ method: 'DELETE', url: `/api/personal/devices/${secondDevice.id}`, headers: t.auth(first.token) });
    expect(crossDel.statusCode).toBe(404);
    expect(crossDel.json().code).toBe('NOT_FOUND');

    const secondList = await t.app.inject({ method: 'GET', url: '/api/personal/devices', headers: t.auth(second.token) });
    expect(secondList.statusCode).toBe(200);
    expect(secondList.json().devices).toHaveLength(1);
    expect(secondList.json().devices[0].status).toBe('active');
    await t.close();
  });
});