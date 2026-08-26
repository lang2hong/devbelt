import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import {
  FakeAdminAuditRepo,
  FakeConnectionMetaRepo,
  FakeWebhookEventRepo,
  FakeDeviceRepo,
  FakePlanRepo,
  
  FakeRefreshTokenRepo,
  FakeSubscriptionRepo,
  
  FakeSyncRepo,
  
  
  FakeUserRepo,
  FakeOrganizationRepo,
  FakeMembershipRepo,
  FakeSeatRepo,
  FakeOrderRepo,
  FakeOrganizationResourceRepo,
  FakeOrganizationAuditRepo,
  FakeRegistrationRepo,
  makePlan,
} from './fakeRepos.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { securityHeaders } from '../../src/middleware/securityHeaders.js';
import type { GetAuthUser, GetAuthSession } from '../../src/middleware/requireAuth.js';
import { TokenService, type JwtPort } from '../../src/service/tokenService.js';
import { AuthService } from '../../src/service/authService.js';
import { SubscriptionService } from '../../src/service/subscriptionService.js';
import { SyncService } from '../../src/service/syncService.js';
import { AdminService } from '../../src/service/adminService.js';
import { PaymentService } from '../../src/service/paymentService.js';
import { OrganizationService } from '../../src/service/organizationService.js';
import { ManualPaymentAdapter } from '../../src/adapter/manualPaymentAdapter.js';
import { PlanPolicy, resolveEffectivePlans } from '../../src/policy/planPolicy.js';
import { authRoutes } from '../../src/route/auth.js';
import { meRoutes } from '../../src/route/me.js';
import { syncRoutes } from '../../src/route/sync.js';
import { adminRoutes } from '../../src/route/admin.js';
import { organizationRoutes } from '../../src/route/organizations.js';
import { webhookRoutes } from '../../src/route/webhook.js';
import type { Role, UserStatus, PlanCode } from '../../src/domain/enums.js';
import { TrafficCollector } from '../../src/observability/trafficCollector.js';
import { registerTrafficPlugin } from '../../src/observability/trafficPlugin.js';
import { RateLimitConfig } from '../../src/ratelimit/rateLimitConfig.js';
import { registerRateLimit } from '../../src/ratelimit/rateLimitPlugin.js';


/**
 * 路由级测试装配：真实的 route + middleware + errorHandler + JWT，
 * 仓储换成内存假实现，**不连 MySQL**。
 *
 * 为什么需要它：route 层此前零测试，于是这几类缺陷只能靠人工审阅发现 ——
 * 解构写在 try 之外导致空 body 变 500、缺 try/catch 让内部错误回显、
 * `?limit=abc` 变成 `LIMIT NaN`、中间件的 401/403 分支从未被执行过。
 * `app.inject()` 是 Fastify 自带的，不用起 HTTP 服务器。
 *
 * 用 createApp() 不可行：它会 ensureDatabase + 注册 mysql 池，必须有真库。
 * 这里刻意复刻 createApp 的装配顺序（errorHandler → jwt → 路由 + getUser），
 * 装配一旦漂移，这些测试会连带失效 —— 属于已知取舍，好在两边都很短。
 */

const TEST_SECRET = 'test-secret-not-a-real-key';

/**
 * 测试装配选项。
 *
 * 限流默认**关闭**：绝大多数路由测试会在一个用例里连打几十个请求，
 * 开着限流会让它们互相干扰（而且失败方式很隐蔽 —— 第 21 个请求突然 429）。
 * 需要测限流的用例显式传 `rateLimit: true` 并自带阈值。
 */
export interface TestAppOptions {
  rateLimit?: boolean;
  /** 覆盖某些桶的阈值，便于用很小的 max 快速打穿 */
  rateLimitOverrides?: Partial<Record<string, { maxRequests: number; windowSeconds: number }>>;
  /** trafficPlugin 的 flush 周期。测试里给个很大的值，改用手动 flush */
  flushIntervalMs?: number;
  /**
   * 每注册一个路由回调一次，用来抓真实路由表。
   *
   * routeCoverage.test.ts 用它比对限流分桶表 —— 手写的路由模板字符串没有
   * 任何编译期约束，只能靠运行时从 app 实例里取真值来校验。
   */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

export interface TestApp {
  app: FastifyInstance;
  repos: {
    userRepo: FakeUserRepo;
    planRepo: FakePlanRepo;
    subRepo: FakeSubscriptionRepo;
    refreshTokenRepo: FakeRefreshTokenRepo;
    deviceRepo: FakeDeviceRepo;
    connectionMetaRepo: FakeConnectionMetaRepo;
            syncRepo: FakeSyncRepo;
            adminAuditRepo: FakeAdminAuditRepo;
    webhookEventRepo: FakeWebhookEventRepo;
    organizationRepo: FakeOrganizationRepo;
    membershipRepo: FakeMembershipRepo;
    seatRepo: FakeSeatRepo;
    orderRepo: FakeOrderRepo;
    registrationRepo: FakeRegistrationRepo;
  };
  services: {
    authService: AuthService;
    adminService: AdminService;
    /** 暴露出来供 webhook 测试注册真做验签的假 provider */
    paymentService: PaymentService;
  };
  collector: TrafficCollector;
  rateLimitConfig: RateLimitConfig;
  /** 按用户签一个 access token（走真实 JWT 签名，因此能通过 jwtVerify） */
  tokenFor(userId: number, opts?: { role?: string; sid?: number; expiresIn?: string }): string;
  /** 造一个用户并返回 { id, token } */
  makeUser(over?: { role?: Role; status?: UserStatus; email?: string }): Promise<{ id: number; token: string; sid: number }>;
  /** 把某用户 personal org 的订阅切到指定套餐（v2 的「升级套餐」等价操作） */
  grantPlan(userId: number, code: PlanCode): Promise<void>;
  auth(token: string): Record<string, string>;
  close(): Promise<void>;
}

export async function buildTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  // trustProxy: 1 与 createApp 的默认值一致，让 req.ip 的行为在测试里也真实。
  //
  // bodyLimit 必须与 createApp 一致地收在 1 MiB：放宽只发生在 `PUT /api/sync`
  // 的路由级配置里（route/sync.ts 的 SYNC_BODY_LIMIT）。如果这里把全局抬高，
  // 「未认证端点不接受大请求体」那条用例就会在测试里假绿。
  const app = Fastify({
    logger: false,
    trustProxy: 1,
    bodyLimit: 1024 * 1024,
  });

  // 必须在任何路由注册之前挂：onRoute 只对之后注册的路由触发
  if (opts.onRoute) {
    const cb = opts.onRoute;
    app.addHook('onRoute', (r) => cb({ method: r.method, url: r.url }));
  }

  registerErrorHandler(app);
  // 与 createApp 同一份策略、同一个注册位置（早于路由）：
  // 头部策略只在 app.ts 里注册的话，securityHeaders.test.ts 测不到任何东西
  await app.register(helmet, securityHeaders());
  await app.register(jwt, { secret: TEST_SECRET, sign: { expiresIn: '15m' } });

  const userRepo = new FakeUserRepo();
  // 配额取真实种子值（schema.ts 的 PLAN_SEED）而非全 0：
  // makePlan 默认把配额都设为 0，而 0 在 PlanPolicy 里表示「无限」——
  // 用默认值搭出来的 app 会让所有配额校验静默通过，配额相关缺陷在测试里不可见。
  const planRepo = new FakePlanRepo([
    makePlan('free', { perSeatMaxDevices: 1, perUserMaxPrivateConnections: 5, perUserPrivateSyncQuotaBytes: 1024 * 1024, perUserSyncVersionRetention: 3 }),
    makePlan('pro', { perSeatMaxDevices: 5, perUserMaxPrivateConnections: 50, perUserPrivateSyncQuotaBytes: 100 * 1024 * 1024, perUserSyncVersionRetention: 30 }),
    makePlan('team', { perSeatMaxDevices: 20, perUserMaxPrivateConnections: 500, perUserPrivateSyncQuotaBytes: 1024 * 1024 * 1024, perUserSyncVersionRetention: 90, includedSeats: 5 }),
  ]);
  const subRepo = new FakeSubscriptionRepo();
  const refreshTokenRepo = new FakeRefreshTokenRepo();
  const deviceRepo = new FakeDeviceRepo();
  const connectionMetaRepo = new FakeConnectionMetaRepo();
      const syncRepo = new FakeSyncRepo();
      const adminAuditRepo = new FakeAdminAuditRepo();
  const webhookEventRepo = new FakeWebhookEventRepo();
  const organizationRepo = new FakeOrganizationRepo();
  const membershipRepo = new FakeMembershipRepo();
  const seatRepo = new FakeSeatRepo();
  const orderRepo = new FakeOrderRepo();
  const organizationResourceRepo = new FakeOrganizationResourceRepo();
  const organizationAuditRepo = new FakeOrganizationAuditRepo();
  const registrationRepo = new FakeRegistrationRepo({
    users: userRepo, orgs: organizationRepo, memberships: membershipRepo,
    subs: subRepo, seats: seatRepo, plans: planRepo,
  });

  // 与 createApp 同序：限流/采集的全局钩子必须早于路由注册
  const collector = new TrafficCollector();
  const rateLimitConfig = new RateLimitConfig();
  await registerRateLimit(app, {
    config: rateLimitConfig,
    collector,
    enabled: opts.rateLimit === true,
  });
  await registerTrafficPlugin(app, { collector });

  const planPolicy = new PlanPolicy((userId) => resolveEffectivePlans(userId, { membershipRepo, subRepo, planRepo }));
  const tokenService = new TokenService(app.jwt as unknown as JwtPort, '15m', '30d');
  const authService = new AuthService(userRepo, subRepo, refreshTokenRepo, deviceRepo, registrationRepo, tokenService, planPolicy);
  const subscriptionService = new SubscriptionService(
    userRepo, planRepo, subRepo, membershipRepo, organizationRepo,
    deviceRepo, syncRepo, connectionMetaRepo, planPolicy,
  );
  const syncService = new SyncService(syncRepo, userRepo, planPolicy, connectionMetaRepo, deviceRepo);
  const adminService = new AdminService(
    userRepo, planRepo, subRepo, membershipRepo, organizationRepo,
    refreshTokenRepo, syncRepo, deviceRepo, connectionMetaRepo,
    adminAuditRepo, planPolicy,
  );
  const paymentService = new PaymentService(subRepo, organizationRepo, planRepo, orderRepo, seatRepo, webhookEventRepo, membershipRepo);
  const organizationService = new OrganizationService(organizationRepo, membershipRepo, seatRepo, organizationResourceRepo, organizationAuditRepo, subRepo, planRepo);
  paymentService.registerProvider(new ManualPaymentAdapter());

  const getUser: GetAuthUser = async (id) => userRepo.findById(id);
  // access token 吊销校验：sid 是签发它的 refresh token 行 id
  const getSession: GetAuthSession = async (id) => refreshTokenRepo.findById(id);

  app.get('/health', async () => ({ status: 'ok' }));
  await app.register(authRoutes, { authService, getUser, getSession });
  await app.register(meRoutes, { subscriptionService, getUser, getSession });
  await app.register(organizationRoutes, { organizationService, getUser, getSession });
  await app.register(syncRoutes, { syncService, getUser, getSession });
  await app.register(adminRoutes, {
    adminService, paymentService, getUser, getSession, trafficCollector: collector,
  });
  await app.register(webhookRoutes, { paymentService });

  await app.ready();

  const tokenFor: TestApp['tokenFor'] = (userId, o = {}) => app.jwt.sign(
    { sub: userId, role: o.role ?? 'user', plan: 'free', sid: o.sid ?? 1 },
    { expiresIn: o.expiresIn ?? '15m' },
  );

  let emailSeq = 0;
  /**
   * 造用户 + 一条**真实的 refresh token 行**，用它的 id 作为 access token 的 sid。
   *
   * 必须真建会话行：authScope/requireRole 现在会校验 sid 指向的会话存在且未撤销
   * （access token 的吊销能力就靠这个）。若沿用固定的 sid=1，所有已认证请求都会
   * 401 —— 那不是测试装配的瑕疵，而是生产行为，token 必须对应一条真实会话。
   */
  const makeUser: TestApp['makeUser'] = async (over = {}) => {
    const email = over.email ?? `u${++emailSeq}@example.com`;
    const { userId } = await registrationRepo.createAccount({
      email,
      passwordHash: 'scrypt$00$00',
      role: over.role ?? 'user',
    });
    if (over.status) await userRepo.updateStatus(userId, over.status);
    const session = await refreshTokenRepo.create({
      userId,
      tokenHash: `hash-${userId}-${Date.now()}`,
      expiresTime: new Date(Date.now() + 30 * 86400_000),
    } as any);
    return {
      id: userId,
      token: tokenFor(userId, { role: over.role ?? 'user', sid: session.id }),
      sid: session.id,
    };
  };

  return {
    app,
    repos: {
      userRepo, planRepo, subRepo, refreshTokenRepo, deviceRepo,
      connectionMetaRepo,  syncRepo,
      adminAuditRepo, webhookEventRepo,
      organizationRepo, membershipRepo, seatRepo, orderRepo, registrationRepo,
    },
    services: { authService, adminService, paymentService },
    collector,
    rateLimitConfig,
    tokenFor,
    makeUser,
    grantPlan: async (userId, code) => {
      const memberships = (await membershipRepo.listByUser(userId)).filter((m) => m.status === 'active');
      const org = await organizationRepo.findById(memberships[0].organizationId);
      const plan = await planRepo.findByCode(code);
      await subRepo.upsert({ organizationId: org!.id, planId: plan!.id, status: 'active', provider: 'manual' });
    },
    auth: (token) => ({ authorization: `Bearer ${token}` }),
    close: () => app.close(),
  };
}
