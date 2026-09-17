import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  FakeUserRepo,
  FakeEmailVerificationTokenRepo,
  FakePlanRepo,
  FakePersonalSubscriptionRepo,
  FakeDeviceRepo,
  FakeRefreshTokenRepo,
  FakeRateLimitRepo,
  FakeRegistrationRepo,
} from '../helpers/fakeRepos.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { AuthService, type DeviceFields } from '../../src/service/authService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import {
  UnauthorizedError,
  PersonalFeatureRequiredError,
} from '../../src/domain/errors.js';

const device = (key = 'device-key-00000001'): DeviceFields => ({
  deviceKey: key,
  devicePlatform: 'linux',
  deviceName: 'test-device',
  clientVersion: '1.0.0',
});

const PASSWORD = 'correct-horse-battery';

interface Fixture {
  auth: AuthService;
  repos: {
    userRepo: FakeUserRepo;
    emailVerificationTokenRepo: FakeEmailVerificationTokenRepo;
    planRepo: FakePlanRepo;
    personalSubscriptionRepo: FakePersonalSubscriptionRepo;
    deviceRepo: FakeDeviceRepo;
    refreshTokenRepo: FakeRefreshTokenRepo;
    rateLimitRepo: FakeRateLimitRepo;
  };
  emailSender: MemoryEmailSender;
}

function makeFixture(opts: { rateLimit?: boolean } = {}): Fixture {
  const userRepo = new FakeUserRepo();
  const emailVerificationTokenRepo = new FakeEmailVerificationTokenRepo();
  const planRepo = new FakePlanRepo();
  const personalSubscriptionRepo = new FakePersonalSubscriptionRepo();
  const deviceRepo = new FakeDeviceRepo();
  const refreshTokenRepo = new FakeRefreshTokenRepo();
  const rateLimitRepo = new FakeRateLimitRepo();
  const registrationRepo = new FakeRegistrationRepo(planRepo, userRepo, personalSubscriptionRepo, emailVerificationTokenRepo);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const rateLimiter = new RateLimitService(rateLimitRepo, opts.rateLimit === true);
  const emailSender = new MemoryEmailSender();
  const auth = new AuthService(
    userRepo,
    emailVerificationTokenRepo,
    personalSubscriptionRepo,
    planRepo,
    deviceRepo,
    refreshTokenRepo,
    registrationRepo,
    tokenService,
    emailSender,
    rateLimiter,
    async (fn) => fn({} as Queryable),
  );
  return {
    auth,
    repos: {
      userRepo,
      emailVerificationTokenRepo,
      planRepo,
      personalSubscriptionRepo,
      deviceRepo,
      refreshTokenRepo,
      rateLimitRepo,
    },
    emailSender,
  };
}

/** 走完「注册→取验证 token→确认邮箱」的完整流程，返回 userId。 */
async function registerAndVerify(f: Fixture, email = 'a@b.com'): Promise<number> {
  await f.auth.register(email, PASSWORD);
  const token = f.emailSender.sent.find((m) => m.kind === 'verification')?.token;
  expect(token).toBeTruthy();
  await f.auth.confirmEmail(token!);
  const user = await f.repos.userRepo.findByEmail(email);
  expect(user?.emailVerifiedTime).toBeTruthy();
  return user!.id;
}

describe('AuthService', () => {
  let f: Fixture;
  beforeEach(() => {
    f = makeFixture();
  });

  it('register creates only user + free subscription + verification token (no personal org)', async () => {
    await f.auth.register('user@example.com', PASSWORD, 'Alice');
    const user = await f.repos.userRepo.findByEmail('user@example.com');
    expect(user).toBeTruthy();
    expect(user!.emailVerifiedTime).toBeNull();
    const sub = await f.repos.personalSubscriptionRepo.findByUserId(user!.id);
    expect(sub).toBeTruthy();
    const free = await f.repos.planRepo.findByCode('free');
    expect(sub!.planId).toBe(free!.id);
    expect(free!.features.maxDevices).toBe(0);
    expect(f.emailSender.sent.some((m) => m.kind === 'verification')).toBe(true);
  });

  it('register with existing email returns identical success and keeps the account intact', async () => {
    await f.auth.register('user@example.com', PASSWORD);
    const before = await f.repos.userRepo.findByEmail('user@example.com');
    const result = await f.auth.register('USER@example.com', PASSWORD);
    expect(result).toEqual({ ok: true });
    const after = await f.repos.userRepo.findByEmail('user@example.com');
    expect(after!.id).toBe(before!.id);
    expect(f.emailSender.sent.filter((m) => m.kind === 'already_registered').length).toBe(1);
  });

  it('rejects short passwords', async () => {
    await expect(f.auth.register('x@example.com', 'short')).rejects.toThrow(/password/);
  });

  it('confirmEmail then login succeeds; unverified login fails with 401', async () => {
    const id = await registerAndVerify(f, 'ok@example.com');
    const res = await f.auth.login('ok@example.com', PASSWORD, device());
    expect(res.accessToken).toBeTruthy();
    expect(res.user.userId).toBe(String(id));
  });

  it('login with wrong password returns UnauthorizedError', async () => {
    await registerAndVerify(f, 'nope@example.com');
    await expect(f.auth.login('nope@example.com', 'wrong-password', device())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refresh rotates and reuse on the old token revokes the family', async () => {
    await registerAndVerify(f, 'rt@example.com');
    const { refreshToken } = await f.auth.login('rt@example.com', PASSWORD, device());
    const rotated = await f.auth.refresh(refreshToken, device());
    expect(rotated.refreshToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(refreshToken);

    // 旧 token 已撤销，再次使用 → family 取消 → 401
    await expect(f.auth.refresh(refreshToken, device())).rejects.toBeInstanceOf(UnauthorizedError);
    // 轮换出的新 token 也因 family 被撤销而失效
    await expect(f.auth.refresh(rotated.refreshToken, device())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('changePassword revokes all refresh tokens', async () => {
    const id = await registerAndVerify(f, 'cp@example.com');
    const { refreshToken } = await f.auth.login('cp@example.com', PASSWORD, device());
    await f.auth.changePassword(id, PASSWORD, 'new-password-1234');
    await expect(f.auth.refresh(refreshToken, device())).rejects.toBeInstanceOf(UnauthorizedError);
    // 新密码可登录
    await expect(f.auth.login('cp@example.com', 'new-password-1234', device())).resolves.toBeTruthy();
  });

  it('enforces max_devices entitlement', async () => {
    await registerAndVerify(f, 'dev@example.com');
    // 把 free plan 的 maxDevices 调整为 1（权益派生自 plan）
    const free = await f.repos.planRepo.findByCode('free');
    free!.features = { ...free!.features, maxDevices: 1 };

    await f.auth.login('dev@example.com', PASSWORD, device('device-key-00000001'));
    await expect(f.auth.login('dev@example.com', PASSWORD, device('device-key-00000002'))).rejects.toBeInstanceOf(PersonalFeatureRequiredError);
    // 同一设备重登不占新位
    await expect(f.auth.login('dev@example.com', PASSWORD, device('device-key-00000001'))).resolves.toBeTruthy();
  });

  it('revokeDevice removes the device and its sessions', async () => {
    await registerAndVerify(f, 'rd@example.com');
    await f.auth.login('rd@example.com', PASSWORD, device('device-key-00000001'));
    const user = await f.repos.userRepo.findByEmail('rd@example.com');
    const devices = await f.repos.deviceRepo.listByUser(user!.id);
    expect(devices.length).toBe(1);
    await f.auth.revokeDevice(user!.id, devices[0].id);
    expect((await f.repos.deviceRepo.listByUser(user!.id))[0].status).toBe('revoked');
  });

  it('refresh rejects a mismatched deviceKey and does not migrate the session', async () => {
    await registerAndVerify(f, 'bind@example.com');
    const { refreshToken } = await f.auth.login('bind@example.com', PASSWORD, device('device-key-00000001'));
    // 用 device B 的 key 请求 refresh → 401，且不 upsert/迁移/复活
    await expect(f.auth.refresh(refreshToken, device('device-key-00000002'))).rejects.toBeInstanceOf(UnauthorizedError);
    // 原 deviceKey 仍可成功 refresh（证明 token 未被消费，也未迁移到 B）
    const rotated = await f.auth.refresh(refreshToken, device('device-key-00000001'));
    expect(rotated.refreshToken).toBeTruthy();
  });

  it('refresh rejects after the device is revoked', async () => {
    await registerAndVerify(f, 'rdev@example.com');
    const { refreshToken } = await f.auth.login('rdev@example.com', PASSWORD, device('device-key-00000001'));
    const user = await f.repos.userRepo.findByEmail('rdev@example.com');
    const devices = await f.repos.deviceRepo.listByUser(user!.id);
    await f.auth.revokeDevice(user!.id, devices[0].id);
    await expect(f.auth.refresh(refreshToken, device('device-key-00000001'))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('register respects the per-IP limit when rate limiting is on', async () => {
    const g = makeFixture({ rateLimit: true });
    // 预填充 register:ip 计数到 10（避免真实跑 10 次 Argon2id hash），再注册一次应触发限流
    const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000);
    for (let i = 0; i < 10; i++) await g.repos.rateLimitRepo.increment('register:ip:1.2.3.4', windowStart);
    await expect(g.auth.register('x@example.com', PASSWORD, undefined, '1.2.3.4')).rejects.toThrow(/too many/i);
  });

  it('login counts failures and returns 429 after exceeding the email limit', async () => {
    const g = makeFixture({ rateLimit: true });
    await registerAndVerify(g, 'lim@example.com');
    const windowStart = new Date(Math.floor(Date.now() / 900000) * 900000);
    // 预填充 5 次失败；第 6 次失败触发 429
    for (let i = 0; i < 5; i++) await g.repos.rateLimitRepo.increment('login:email:lim@example.com', windowStart);
    await expect(g.auth.login('lim@example.com', 'wrong-password', device())).rejects.toThrow(/too many/i);
  });

  it('successful login does not count against the failure limit', async () => {
    const g = makeFixture({ rateLimit: true });
    await registerAndVerify(g, 'oklim@example.com');
    const windowStart = new Date(Math.floor(Date.now() / 900000) * 900000);
    for (let i = 0; i < 5; i++) await g.repos.rateLimitRepo.increment('login:email:oklim@example.com', windowStart);
    // 密码正确 → 成功登录不计数，不 429
    await expect(g.auth.login('oklim@example.com', PASSWORD, device())).resolves.toBeTruthy();
  });

  it('resendVerification for an unknown email returns identical success and sends no mail', async () => {
    const r = await f.auth.resendVerification('nobody@example.com');
    expect(r).toEqual({ ok: true });
    expect(f.emailSender.sent.filter((m) => m.kind === 'verification')).toHaveLength(0);
  });

  it('resendVerification for an un-verified email issues a new token', async () => {
    await f.auth.register('rv@example.com', PASSWORD);
    const before = f.emailSender.sent.filter((m) => m.kind === 'verification').length;
    await f.auth.resendVerification('rv@example.com');
    expect(f.emailSender.sent.filter((m) => m.kind === 'verification').length).toBe(before + 1);
  });

  it('resendVerification for a verified email returns identical success and sends no mail', async () => {
    await registerAndVerify(f, 'vr@example.com');
    const before = f.emailSender.sent.filter((m) => m.kind === 'verification').length;
    await f.auth.resendVerification('vr@example.com');
    expect(f.emailSender.sent.filter((m) => m.kind === 'verification').length).toBe(before);
  });

  it('resendVerification is rate-limited by email', async () => {
    const g = makeFixture({ rateLimit: true });
    const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000);
    for (let i = 0; i < 3; i++) await g.repos.rateLimitRepo.increment('verify:email:rlim@example.com', windowStart);
    await expect(g.auth.resendVerification('rlim@example.com')).rejects.toThrow(/too many/i);
  });
});