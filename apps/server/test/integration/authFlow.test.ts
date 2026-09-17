import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';
import { withTransaction } from '../../src/repository/mysql/db.js';
import { MysqlUserRepo } from '../../src/repository/mysql/userRepo.js';
import { MysqlEmailVerificationTokenRepo } from '../../src/repository/mysql/emailVerificationTokenRepo.js';
import { MysqlPersonalSubscriptionRepo } from '../../src/repository/mysql/personalSubscriptionRepo.js';
import { MysqlPlanRepo } from '../../src/repository/mysql/planRepo.js';
import { MysqlDeviceRepo } from '../../src/repository/mysql/deviceRepo.js';
import { MysqlRefreshTokenRepo } from '../../src/repository/mysql/refreshTokenRepo.js';
import { MysqlRateLimitRepo } from '../../src/repository/mysql/rateLimitRepo.js';
import { MysqlRegistrationRepo } from '../../src/repository/mysql/registrationRepo.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { AuthService, type DeviceFields } from '../../src/service/authService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import { UnauthorizedError } from '../../src/domain/errors.js';

const URL = process.env.MYSQL_TEST_URL;
const PASSWORD = 'correct-horse-battery';

const device = (key = 'device-key-00000001'): DeviceFields => ({
  deviceKey: key,
  devicePlatform: 'linux',
  deviceName: 'test',
  clientVersion: '1.0.0',
});

function uniqueEmail(): string {
  return `it-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

function makeSigningKeys(): SigningKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
}

async function makeAuth(db: MysqlDb, emailSender: MemoryEmailSender) {
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
    new RateLimitService(rateLimitRepo, false),
    (fn) => withTransaction(db, fn),
  );
  return { auth, userRepo, refreshTokenRepo };
}

async function registerAndLogin(emailSender: MemoryEmailSender, auth: AuthService, email: string) {
  await auth.register(email, PASSWORD);
  const token = emailSender.sent.find((m) => m.kind === 'verification')?.token;
  expect(token).toBeTruthy();
  await auth.confirmEmail(token!);
  return auth.login(email, PASSWORD, device());
}

describe.skipIf(!URL)('auth flow (real MySQL)', () => {
  it('refresh reuse revokes the family and change-password revokes sessions', async () => {
    const pool = createTestPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);
      const emailSender = new MemoryEmailSender();
      const { auth, userRepo } = await makeAuth(db, emailSender);

      const email = uniqueEmail();
      const { refreshToken } = await registerAndLogin(emailSender, auth, email);
      const rotated = await auth.refresh(refreshToken, device());
      expect(rotated.refreshToken).not.toBe(refreshToken);

      // 旧 token 复用 → 撤销 family → 两个 token 都失效
      await expect(auth.refresh(refreshToken, device())).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(auth.refresh(rotated.refreshToken, device())).rejects.toBeInstanceOf(UnauthorizedError);

      // 改密撤销全部会话
      const user = await userRepo.findByEmail(email);
      const { refreshToken: rt2 } = await auth.login(email, PASSWORD, device());
      await auth.changePassword(user!.id, PASSWORD, 'new-password-1234');
      await expect(auth.refresh(rt2, device())).rejects.toBeInstanceOf(UnauthorizedError);
    } finally {
      await pool.end();
    }
  });
});