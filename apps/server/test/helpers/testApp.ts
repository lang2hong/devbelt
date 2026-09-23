import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { generateKeyPairSync } from 'crypto';
import {
  FakeUserRepo,
  FakeEmailVerificationTokenRepo,
  FakePlanRepo,
  FakePlanFeatureDefRepo,
  FakePersonalSubscriptionRepo,
  FakeDeviceRepo,
  FakeRefreshTokenRepo,
  FakeRateLimitRepo,
  FakeRegistrationRepo,
  FakeSyncStateRepo,
  FakeSyncRecordRepo,
  FakeSyncMutationRepo,
  FakeSyncNonceRepo,
  FakeSyncResetTokenRepo,
  FakeSyncResetHandoffRepo,
  FakeIdempotencyReceiptRepo,
} from './fakeRepos.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { securityHeaders } from '../../src/middleware/securityHeaders.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { EXTENSION_SCOPES } from '../../src/domain/enums.js';
import { AuthService } from '../../src/modules/auth/service/authService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { MemoryEmailSender } from '../../src/modules/auth/service/emailSender.js';
import { authRoutes } from '../../src/modules/auth/route/auth.js';
import { meRoutes } from '../../src/modules/db/route/me.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import { personalRoutes } from '../../src/modules/db/route/personal.js';
import { syncRoutes } from '../../src/modules/db/route/sync.js';
import { SyncStateService } from '../../src/modules/db/service/syncStateService.js';
import { SyncRecordService } from '../../src/modules/db/service/syncRecordService.js';
import { SyncResetService } from '../../src/modules/db/service/syncResetService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { IdempotencyService } from '../../src/service/idempotencyService.js';
import { FakeAuditRepo, FakeMailFlowRepo } from './linkFlowFakes.js';

export interface TestAppOptions {
  rateLimit?: boolean;
}

export interface TestApp {
  app: ReturnType<typeof Fastify>;
  repos: {
    userRepo: FakeUserRepo;
    emailVerificationTokenRepo: FakeEmailVerificationTokenRepo;
    planRepo: FakePlanRepo;
    featureDefRepo: FakePlanFeatureDefRepo;
    personalSubscriptionRepo: FakePersonalSubscriptionRepo;
    deviceRepo: FakeDeviceRepo;
    refreshTokenRepo: FakeRefreshTokenRepo;
    rateLimitRepo: FakeRateLimitRepo;
    registrationRepo: FakeRegistrationRepo;
    syncResetTokenRepo: FakeSyncResetTokenRepo;
    syncResetHandoffRepo: FakeSyncResetHandoffRepo;
    mailFlowRepo: FakeMailFlowRepo;
  };
  services: {
    authService: AuthService;
    emailSender: MemoryEmailSender;
    tokenService: TokenService;
  };
  tokenService: TokenService;
  csrfService: CsrfService;
  /** 为指定 userId 签一个真实 Ed25519 access token。 */
  tokenFor(userId: number): Promise<string>;
  auth(token: string): Record<string, string>;
  close(): Promise<void>;
}

function makeSigningKeys(): SigningKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
}

/**
 * 路由级测试装配：真实 route + middleware + errorHandler + Ed25519 token，
 * 仓储换成内存假实现，不连 MySQL。
 */
export async function buildTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const app = Fastify({
    logger: false,
    trustProxy: '1',
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
  });

  registerErrorHandler(app);
  await app.register(helmet, securityHeaders());

  const userRepo = new FakeUserRepo();
  const emailVerificationTokenRepo = new FakeEmailVerificationTokenRepo();
  const planRepo = new FakePlanRepo();
  const featureDefRepo = new FakePlanFeatureDefRepo();
  const personalSubscriptionRepo = new FakePersonalSubscriptionRepo();
  const deviceRepo = new FakeDeviceRepo();
  const refreshTokenRepo = new FakeRefreshTokenRepo();
  const rateLimitRepo = new FakeRateLimitRepo();
  const registrationRepo = new FakeRegistrationRepo(planRepo, userRepo, personalSubscriptionRepo, emailVerificationTokenRepo);
  const syncStateRepo = new FakeSyncStateRepo();
  const syncRecordRepo = new FakeSyncRecordRepo();
  const syncMutationRepo = new FakeSyncMutationRepo();
  const syncNonceRepo = new FakeSyncNonceRepo();
  const syncResetTokenRepo = new FakeSyncResetTokenRepo();
  const syncResetHandoffRepo = new FakeSyncResetHandoffRepo();
  const mailFlowRepo = new FakeMailFlowRepo();

  const tokenService = new TokenService(makeSigningKeys(), '15m', 30 * 24 * 3600 * 1000);
  const rateLimiter = new RateLimitService(rateLimitRepo, opts.rateLimit === true);
  const emailSender = new MemoryEmailSender();
  const authService = new AuthService(
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
  const syncStateService = new SyncStateService(
    syncStateRepo,
    syncRecordRepo,
    syncMutationRepo,
    async (fn) => fn({} as Queryable),
  );
  const syncRecordService = new SyncRecordService(
    syncStateRepo,
    syncRecordRepo,
    syncNonceRepo,
    syncMutationRepo,
    personalSubscriptionRepo,
    planRepo,
    async (fn) => fn({} as Queryable),
  );
  const auditWriter = new AuditWriter(new FakeAuditRepo());
  const syncResetService = new SyncResetService(
    syncStateRepo,
    syncRecordRepo,
    syncResetTokenRepo,
    userRepo,
    async (fn) => fn({} as Queryable),
    emailSender,
    rateLimiter,
    mailFlowRepo,
    syncResetHandoffRepo,
    auditWriter,
    'lang2hong.devbelt-db-client',
  );

  const getUser = async (id: number) => userRepo.findById(id);
  // 测试装配：会话存活默认通过（真库行为由 dedicated 用例验证）。
  const getSessionActive = async (_sessionId: string) => true;
  const csrfService = new CsrfService(Buffer.alloc(32, 3));
  const consoleOrigin = 'http://localhost:5173';

  app.get('/health', async () => ({ status: 'ok' }));
  await app.register(authRoutes, { authService, tokenService, getUser, getSessionActive, auditWriter, csrfService, consoleOrigin });
  await app.register(meRoutes, { tokenService, getUser, getSessionActive, userRepo, personalSubscriptionRepo, planRepo });
  await app.register(personalRoutes, { tokenService, getUser, getSessionActive, auditWriter, csrfService, consoleOrigin, deviceRepo, idempotencyService: new IdempotencyService(new FakeIdempotencyReceiptRepo(), async (fn) => fn({} as Queryable)), revokeDevice: (userId, deviceId) => authService.revokeDevice(userId, deviceId), revokeDeviceInTx: (tx, userId, deviceId) => authService.revokeDeviceInTx(tx, userId, deviceId) });
  await app.register(syncRoutes, { tokenService, getUser, getSessionActive, syncState: syncStateService, syncRecord: syncRecordService, syncReset: syncResetService, rateLimiter, verifyAccountRecoveryPassword: (userId, password) => authService.verifyPasswordStepUp(userId, password), auditWriter, emailSender, userRepo });

  await app.ready();

  return {
    app,
    repos: {
      userRepo,
      emailVerificationTokenRepo,
      planRepo,
      featureDefRepo,
      personalSubscriptionRepo,
      deviceRepo,
      refreshTokenRepo,
      rateLimitRepo,
      registrationRepo,
      syncResetTokenRepo,
      syncResetHandoffRepo,
      mailFlowRepo,
    },
    services: { authService, emailSender, tokenService },
    tokenService,
    csrfService,
    tokenFor: (userId) => tokenService.signAccessToken({
      userId,
      aud: 'extension',
      scope: [...EXTENSION_SCOPES],
      sessionId: 'test-session',
      sessionVersion: 0,
    }),
    auth: (token) => ({ authorization: `Bearer ${token}` }),
    close: () => app.close(),
  };
}