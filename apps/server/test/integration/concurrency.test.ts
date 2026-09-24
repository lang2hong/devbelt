import { describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import { generateKeyPairSync } from 'crypto';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';
import { withTransaction } from '../../src/repository/mysql/db.js';
import { MysqlUserRepo } from '../../src/modules/auth/repository/userRepo.js';
import { MysqlEmailVerificationTokenRepo } from '../../src/modules/auth/repository/emailVerificationTokenRepo.js';
import { MysqlPersonalSubscriptionRepo } from '../../src/modules/billing/repository/personalSubscriptionRepo.js';
import { MysqlPlanRepo } from '../../src/modules/billing/repository/planRepo.js';
import { MysqlDeviceRepo } from '../../src/modules/db/repository/deviceRepo.js';
import { MysqlRefreshTokenRepo } from '../../src/modules/auth/repository/refreshTokenRepo.js';
import { MysqlRateLimitRepo } from '../../src/repository/mysql/rateLimitRepo.js';
import { MysqlRegistrationRepo } from '../../src/modules/auth/repository/registrationRepo.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { AuthService, type DeviceFields } from '../../src/modules/auth/service/authService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { MemoryEmailSender } from '../../src/modules/auth/service/emailSender.js';

const URL = process.env.DEVBELT_DB_TEST_MYSQL_URL;
const PASSWORD = 'correct-horse-battery';

const device = (key = 'device-key-00000001'): DeviceFields => ({
  deviceKey: key,
  devicePlatform: 'linux',
  deviceName: 'test',
  clientVersion: '1.0.0',
});

function uniqueEmail(): string {
  return `cc-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

function makeSigningKeys(): SigningKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
}

async function makeAuth(db: MysqlDb, emailSender: MemoryEmailSender, opts: { rateLimit?: boolean } = {}) {
  const userRepo = new MysqlUserRepo(() => db);
  const emailVerificationTokenRepo = new MysqlEmailVerificationTokenRepo(() => db);
  const personalSubscriptionRepo = new MysqlPersonalSubscriptionRepo(() => db);
  const planRepo = new MysqlPlanRepo(() => db);
  const deviceRepo = new MysqlDeviceRepo(() => db);
  const refreshTokenRepo = new MysqlRefreshTokenRepo(() => db);
  const rateLimitRepo = new MysqlRateLimitRepo(() => db);
  const registrationRepo = new MysqlRegistrationRepo(() => db);
  const tokenService = new TokenService(makeSigningKeys(), '15m', 30 * 24 * 3600 * 1000);
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
    new RateLimitService(rateLimitRepo, opts.rateLimit === true),
    (fn) => withTransaction(db, fn),
  );
  return { auth, userRepo, deviceRepo, refreshTokenRepo, emailVerificationTokenRepo };
}

async function registerAndVerify(emailSender: MemoryEmailSender, auth: AuthService, email: string) {
  await auth.register(email, PASSWORD);
  const token = emailSender.sent.find((m) => m.kind === 'verification')?.token;
  expect(token).toBeTruthy();
  await auth.confirmEmail(token!);
}

function newPool(): mysql.Pool {
  return createTestPool();
}

describe.skipIf(!URL)('concurrency (real MySQL)', () => {
  it('concurrent refresh of the same token yields a single valid chain', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const emailSender = new MemoryEmailSender();
      const { auth } = await makeAuth(db, emailSender);
      const email = uniqueEmail();
      await registerAndVerify(emailSender, auth, email);
      const { refreshToken } = await auth.login(email, PASSWORD, device());

      const results = await Promise.allSettled([
        auth.refresh(refreshToken, device()),
        auth.refresh(refreshToken, device()),
        auth.refresh(refreshToken, device()),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      // 宽限内：失败者仅被拒绝，不再吊销整族 → 成功者轮换出的新 token 仍可继续刷新
      // （否则并发竞态会把该设备整族登出；见 REFRESH_REUSE_GRACE_MS）
      const newToken = (fulfilled[0] as PromiseFulfilledResult<{ refreshToken: string }>).value.refreshToken;
      const again = await auth.refresh(newToken, device());
      expect(again.refreshToken).toBeTruthy();
    } finally {
      await pool.end();
    }
  });

  it('concurrent logins do not exceed max_devices', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const emailSender = new MemoryEmailSender();
      const { auth, userRepo } = await makeAuth(db, emailSender);
      const email = uniqueEmail();
      await registerAndVerify(emailSender, auth, email);
      const user = await userRepo.findByEmail(email);
      // Free 的 max_devices=0（无限）；此处把该用户**所用 plan 的 maxDevices 特性**收紧为 1，
      // 验证并发不超额。权益由 plan 派生（baseline 已删除 entitlement_snapshot 列）。
      await db.query(
        `UPDATE plan_feature_values pfv
         JOIN plan_feature_defs d ON d.id = pfv.feature_def_id
         JOIN personal_subscriptions s ON s.plan_id = pfv.plan_id
         SET pfv.value_json = '1'
         WHERE s.user_id = ? AND d.feature_key = 'maxDevices'`,
        [user!.id],
      );

      const attempts = await Promise.allSettled([
        auth.login(email, PASSWORD, device('device-key-00000001')),
        auth.login(email, PASSWORD, device('device-key-00000002')),
        auth.login(email, PASSWORD, device('device-key-00000003')),
        auth.login(email, PASSWORD, device('device-key-00000004')),
        auth.login(email, PASSWORD, device('device-key-00000005')),
      ]);
      const fulfilled = attempts.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it('revoke racing with refresh leaves no valid session on the device', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const emailSender = new MemoryEmailSender();
      const { auth, userRepo, deviceRepo } = await makeAuth(db, emailSender);
      const email = uniqueEmail();
      await registerAndVerify(emailSender, auth, email);
      const { refreshToken } = await auth.login(email, PASSWORD, device());
      const user = await userRepo.findByEmail(email);
      const devs = await deviceRepo.listByUser(user!.id);
      const deviceId = devs[0].id;

      await Promise.allSettled([
        auth.revokeDevice(user!.id, deviceId),
        auth.refresh(refreshToken, device()),
      ]);

      // 撤销完成后：设备 revoked，且该设备的会话不可再续期
      expect((await deviceRepo.listByUser(user!.id))[0].status).toBe('revoked');
      await expect(auth.refresh(refreshToken, device())).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });

  it('concurrent resends leave exactly one unconsumed verification token', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const emailSender = new MemoryEmailSender();
      const { auth, userRepo } = await makeAuth(db, emailSender);
      const email = uniqueEmail();
      await auth.register(email, PASSWORD);
      const user = await userRepo.findByEmail(email);

      await Promise.allSettled([
        auth.resendVerification(email),
        auth.resendVerification(email),
        auth.resendVerification(email),
        auth.resendVerification(email),
        auth.resendVerification(email),
      ]);

      const [rows] = (await db.query(
        "SELECT COUNT(*) AS cnt FROM email_verification_tokens WHERE user_id = ? AND purpose = 'initial' AND consumed_time IS NULL",
        [user!.id],
      )) as [Array<{ cnt: number }>, unknown];
      expect(Number(rows[0].cnt)).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('old password cannot mint a session after change-password commits', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const emailSender = new MemoryEmailSender();
      const { auth, userRepo } = await makeAuth(db, emailSender);
      const email = uniqueEmail();
      await registerAndVerify(emailSender, auth, email);
      const user = await userRepo.findByEmail(email);

      await Promise.allSettled([
        auth.changePassword(user!.id, PASSWORD, 'new-password-1234'),
        auth.login(email, PASSWORD, device()),
      ]);

      // 改密提交后：旧密码登录必失败，新密码可登录
      await expect(auth.login(email, PASSWORD, device())).rejects.toThrow();
      await expect(auth.login(email, 'new-password-1234', device())).resolves.toBeTruthy();
    } finally {
      await pool.end();
    }
  });

  it('concurrent failed logins are capped at 5 (401) then 429', async () => {
    const pool = newPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const emailSender = new MemoryEmailSender();
      const { auth } = await makeAuth(db, emailSender, { rateLimit: true });
      const email = uniqueEmail(); // 未注册邮箱 = 失败路径

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => auth.login(email, 'wrong-password', device(), '9.9.9.9')),
      );
      const unauthorized = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected' && (r.reason as { code?: string }).code === 'UNAUTHORIZED',
      );
      const limited = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected' && (r.reason as { code?: string }).code === 'TOO_MANY_REQUESTS',
      );
      expect(unauthorized.length).toBeLessThanOrEqual(5);
      expect(unauthorized.length + limited.length).toBe(20);
    } finally {
      await pool.end();
    }
  });
});
