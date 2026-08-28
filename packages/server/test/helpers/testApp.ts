import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { generateKeyPairSync } from 'crypto';
import {
  FakeUserRepo,
  FakeEmailVerificationTokenRepo,
  FakePersonalPlanRepo,
  FakePersonalSubscriptionRepo,
  FakeDeviceRepo,
  FakeRefreshTokenRepo,
  FakeRateLimitRepo,
  FakeRegistrationRepo,
  FakeOrganizationPlanRepo,
  FakeOrganizationRepo,
  FakeOrganizationSubscriptionRepo,
  FakeMembershipRepo,
  FakeInvitationRepo,
  FakeFolderRepo,
  FakeResourceRepo,
} from './fakeRepos.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { securityHeaders } from '../../src/middleware/securityHeaders.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { AuthService } from '../../src/service/authService.js';
import { OrganizationService } from '../../src/service/organizationService.js';
import { OrganizationResourceService } from '../../src/service/organizationResourceService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import { authRoutes } from '../../src/route/auth.js';
import { meRoutes } from '../../src/route/me.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import { personalRoutes } from '../../src/route/personal.js';
import { organizationRoutes } from '../../src/route/organizations.js';
import { invitationRoutes } from '../../src/route/invitations.js';

export interface TestAppOptions {
  rateLimit?: boolean;
}

export interface TestApp {
  app: FastifyInstance;
  repos: {
    userRepo: FakeUserRepo;
    emailVerificationTokenRepo: FakeEmailVerificationTokenRepo;
    personalPlanRepo: FakePersonalPlanRepo;
    personalSubscriptionRepo: FakePersonalSubscriptionRepo;
    deviceRepo: FakeDeviceRepo;
    refreshTokenRepo: FakeRefreshTokenRepo;
    rateLimitRepo: FakeRateLimitRepo;
    registrationRepo: FakeRegistrationRepo;
    organizationPlanRepo: FakeOrganizationPlanRepo;
    organizationRepo: FakeOrganizationRepo;
    organizationSubscriptionRepo: FakeOrganizationSubscriptionRepo;
    membershipRepo: FakeMembershipRepo;
    invitationRepo: FakeInvitationRepo;
    folderRepo: FakeFolderRepo;
    resourceRepo: FakeResourceRepo;
  };
  services: {
    authService: AuthService;
    emailSender: MemoryEmailSender;
    tokenService: TokenService;
    organizationService: OrganizationService;
    resourceService: OrganizationResourceService;
  };
  tokenService: TokenService;
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
    trustProxy: 1,
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
  });

  registerErrorHandler(app);
  await app.register(helmet, securityHeaders());

  const userRepo = new FakeUserRepo();
  const emailVerificationTokenRepo = new FakeEmailVerificationTokenRepo();
  const personalPlanRepo = new FakePersonalPlanRepo();
  const personalSubscriptionRepo = new FakePersonalSubscriptionRepo();
  const deviceRepo = new FakeDeviceRepo();
  const refreshTokenRepo = new FakeRefreshTokenRepo();
  const rateLimitRepo = new FakeRateLimitRepo();
  const registrationRepo = new FakeRegistrationRepo(personalPlanRepo, userRepo, personalSubscriptionRepo, emailVerificationTokenRepo);
  const organizationPlanRepo = new FakeOrganizationPlanRepo();
  const organizationRepo = new FakeOrganizationRepo();
  const organizationSubscriptionRepo = new FakeOrganizationSubscriptionRepo();
  const membershipRepo = new FakeMembershipRepo(userRepo, organizationRepo);
  const invitationRepo = new FakeInvitationRepo(membershipRepo);
  const resourceRepo = new FakeResourceRepo();
  const folderRepo = new FakeFolderRepo(resourceRepo);

  const tokenService = new TokenService(makeSigningKeys(), '15m', 30 * 24 * 3600 * 1000);
  const rateLimiter = new RateLimitService(rateLimitRepo, opts.rateLimit === true);
  const emailSender = new MemoryEmailSender();
  const authService = new AuthService(
    userRepo,
    emailVerificationTokenRepo,
    personalSubscriptionRepo,
    deviceRepo,
    refreshTokenRepo,
    registrationRepo,
    tokenService,
    emailSender,
    rateLimiter,
    async (fn) => fn({} as Queryable),
  );
  const organizationService = new OrganizationService(
    userRepo,
    organizationRepo,
    organizationPlanRepo,
    organizationSubscriptionRepo,
    membershipRepo,
    invitationRepo,
    rateLimiter,
    tokenService,
    emailSender,
    async (fn) => fn({} as Queryable),
  );
  const resourceService = new OrganizationResourceService(
    organizationRepo,
    organizationSubscriptionRepo,
    folderRepo,
    resourceRepo,
    async (fn) => fn({} as Queryable),
  );

  const getUser = async (id: number) => userRepo.findById(id);

  app.get('/health', async () => ({ status: 'ok' }));
  await app.register(authRoutes, { authService, tokenService, getUser });
  await app.register(meRoutes, { tokenService, getUser, userRepo, personalSubscriptionRepo, personalPlanRepo });
  await app.register(personalRoutes, { tokenService, getUser, deviceRepo, revokeDevice: (userId, deviceId) => authService.revokeDevice(userId, deviceId) });
  await app.register(organizationRoutes, { tokenService, getUser, organizationService, resourceService, organizationRepo, membershipRepo });
  await app.register(invitationRoutes, { tokenService, getUser, organizationService });

  await app.ready();

  return {
    app,
    repos: {
      userRepo,
      emailVerificationTokenRepo,
      personalPlanRepo,
      personalSubscriptionRepo,
      deviceRepo,
      refreshTokenRepo,
      rateLimitRepo,
      registrationRepo,
      organizationPlanRepo,
      organizationRepo,
      organizationSubscriptionRepo,
      membershipRepo,
      invitationRepo,
      folderRepo,
      resourceRepo,
    },
    services: { authService, emailSender, tokenService, organizationService, resourceService },
    tokenService,
    tokenFor: (userId) => tokenService.signAccessToken(userId),
    auth: (token) => ({ authorization: `Bearer ${token}` }),
    close: () => app.close(),
  };
}