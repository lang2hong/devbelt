import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync } from 'crypto';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';
import { withTransaction } from '../../src/repository/mysql/db.js';
import { MysqlUserRepo } from '../../src/repository/mysql/userRepo.js';
import { MysqlEmailVerificationTokenRepo } from '../../src/repository/mysql/emailVerificationTokenRepo.js';
import { MysqlPersonalSubscriptionRepo } from '../../src/repository/mysql/personalSubscriptionRepo.js';
import { MysqlDeviceRepo } from '../../src/repository/mysql/deviceRepo.js';
import { MysqlRefreshTokenRepo } from '../../src/repository/mysql/refreshTokenRepo.js';
import { MysqlRateLimitRepo } from '../../src/repository/mysql/rateLimitRepo.js';
import { MysqlRegistrationRepo } from '../../src/repository/mysql/registrationRepo.js';
import { MysqlAuditRepo } from '../../src/repository/mysql/auditRepo.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { AuthService, type DeviceFields } from '../../src/service/authService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import { ConsoleAdminService, type ConsoleAdminDeps } from '../../src/service/consoleAdminService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { authScope } from '../../src/middleware/requireAuth.js';

const URL = process.env.MYSQL_TEST_URL;
const PASSWORD = 'correct-horse-battery';
// 不存在的操作者 id：setUserStatusInTx 只审计 actorUserId、不锁操作者，仅要求 != target。
const ADMIN_ACTOR = 9000001;

const device = (key = 'device-key-00000001'): DeviceFields => ({
  deviceKey: key,
  devicePlatform: 'linux',
  deviceName: 'test',
  clientVersion: '1.0.0',
});

function uniqueEmail(): string {
  return `kick-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

function makeSigningKeys(): SigningKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
}

describe.skipIf(!URL)('admin disable kick-out (real MySQL)', () => {
  it('disabling a user rejects their live access token and revokes refresh', async () => {
    const pool = createTestPool();
    const db = pool as unknown as MysqlDb;
    try {
      await runMigrations(db, [...migrations]);

      const userRepo = new MysqlUserRepo(() => db);
      const emailVerificationTokenRepo = new MysqlEmailVerificationTokenRepo(() => db);
      const personalSubscriptionRepo = new MysqlPersonalSubscriptionRepo(() => db);
      const deviceRepo = new MysqlDeviceRepo(() => db);
      const refreshTokenRepo = new MysqlRefreshTokenRepo(() => db);
      const rateLimitRepo = new MysqlRateLimitRepo(() => db);
      const registrationRepo = new MysqlRegistrationRepo(() => db);
      const tokenService = new TokenService(makeSigningKeys(), '15m', 30 * 24 * 3600 * 1000);
      const sender = new MemoryEmailSender();
      const auth = new AuthService(
        userRepo, emailVerificationTokenRepo, personalSubscriptionRepo, deviceRepo, refreshTokenRepo,
        registrationRepo, tokenService, sender, new RateLimitService(rateLimitRepo, false),
        (fn) => withTransaction(db, fn),
      );

      // 注册 → 验证 → 登录，取得真实 access + refresh。
      const email = uniqueEmail();
      await auth.register(email, PASSWORD);
      const verifyToken = sender.sent.find((m) => m.kind === 'verification')?.token;
      expect(verifyToken).toBeTruthy();
      await auth.confirmEmail(verifyToken!);
      const { accessToken, refreshToken } = await auth.login(email, PASSWORD, device());

      const user = await userRepo.findByEmail(email);
      expect(user).toBeTruthy();

      // 最小受保护路由：真实 authScope + 真实 token/用户/session。
      const app = Fastify({ logger: false });
      await app.register(authScope, {
        tokenService,
        getUser: async (id) => {
          const u = await userRepo.findById(id);
          return u ? { status: u.status, sessionVersion: u.sessionVersion, role: u.role } : undefined;
        },
        getSessionActive: (sessionId) => refreshTokenRepo.hasActiveToken(sessionId),
        aud: 'extension',
        scope: ['sync'],
        routes: (child) => {
          child.get('/api/sync/state', async () => ({ ok: true }));
        },
      });
      await app.ready();

      const headers = { authorization: `Bearer ${accessToken}` };
      expect((await app.inject({ method: 'GET', url: '/api/sync/state', headers })).statusCode).toBe(200);

      // admin 禁用：更新状态 + session_version+1 + 撤销全部 refresh。
      const adminSvc = new ConsoleAdminService({
        userRepo,
        refreshTokenRepo,
        auditWriter: new AuditWriter(new MysqlAuditRepo(() => db)),
      } as unknown as ConsoleAdminDeps);
      await withTransaction(db, (tx) => adminSvc.setUserStatusInTx(tx, ADMIN_ACTOR, user!.id, 'disabled', 'integration test'));

      // 旧 access token 签名仍有效，但用户已 disabled → 403 USER_DISABLED（而非 401 过期）。
      expect(await tokenService.verifyAccessToken(accessToken)).toBeTruthy();
      const res = await app.inject({ method: 'GET', url: '/api/sync/state', headers });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('USER_DISABLED');

      // 存量 refresh 已被撤销 → 刷新失败。
      await expect(auth.refresh(refreshToken, device())).rejects.toThrow();

      const after = await userRepo.findByEmail(email);
      expect(after!.status).toBe('disabled');
      expect(after!.sessionVersion).toBe((user!.sessionVersion) + 1);
      await app.close();
    } finally {
      await pool.end();
    }
  });
});