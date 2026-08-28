import { describe, it, expect } from 'vitest';
import { buildTestApp } from '../helpers/testApp.js';

const PASSWORD = 'password123456';
const deviceBody = {
  deviceKey: 'device-key-00000001',
  devicePlatform: 'linux',
  deviceName: 'test',
  clientVersion: '1.0.0',
};

describe('auth routes', () => {
  it('registers with 201 and identical success on duplicate email', async () => {
    const t = await buildTestApp();
    const res1 = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@b.com', password: PASSWORD },
    });
    expect(res1.statusCode).toBe(201);
    expect(res1.json()).toEqual({ ok: true });

    const res2 = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'A@B.com', password: PASSWORD },
    });
    expect(res2.statusCode).toBe(201);
    expect(res2.json()).toEqual({ ok: true });
    await t.close();
  });

  it('rejects unknown fields in the register body (strict schema)', async () => {
    const t = await buildTestApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@b.com', password: PASSWORD, bogus: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
    await t.close();
  });

  it('full flow: register -> confirm -> login -> refresh', async () => {
    const t = await buildTestApp();
    await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'flow@b.com', password: PASSWORD } });
    const token = t.services.emailSender.sent.find((m) => m.kind === 'verification')?.token!;

    const confirm = await t.app.inject({ method: 'POST', url: `/api/auth/email-verifications/${token}/confirm` });
    expect(confirm.statusCode).toBe(200);

    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'flow@b.com', password: PASSWORD, ...deviceBody },
    });
    expect(login.statusCode).toBe(200);
    const { accessToken, refreshToken, user } = login.json();
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
    expect(user.email).toBe('flow@b.com');
    expect(typeof user.userId).toBe('string');

    const refresh = await t.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken, ...deviceBody },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().accessToken).toBeTruthy();
    await t.close();
  });

  it('login rejects an unverified email with 401', async () => {
    const t = await buildTestApp();
    await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'unverified@b.com', password: PASSWORD } });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unverified@b.com', password: PASSWORD, ...deviceBody },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
    await t.close();
  });

  it('change-password requires a valid access token', async () => {
    const t = await buildTestApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: 'a', newPassword: 'b' },
    });
    expect(res.statusCode).toBe(401);
    await t.close();
  });

  it('devices endpoint requires authentication', async () => {
    const t = await buildTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/personal/devices' });
    expect(res.statusCode).toBe(401);
    await t.close();
  });
});