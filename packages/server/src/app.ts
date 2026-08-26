import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import mysql from '@fastify/mysql';
import sensible from '@fastify/sensible';
import { createConnection } from 'mysql2/promise';
import { config } from './config.js';
import { buildMysqlPoolOptions } from './mysqlPool.js';
import { MysqlUserRepo } from './repository/mysql/userRepo.js';
import { MysqlPlanRepo } from './repository/mysql/planRepo.js';
import { MysqlSubscriptionRepo } from './repository/mysql/subscriptionRepo.js';
import { MysqlRefreshTokenRepo } from './repository/mysql/refreshTokenRepo.js';
import { MysqlDeviceRepo } from './repository/mysql/deviceRepo.js';
import { MysqlConnectionMetaRepo } from './repository/mysql/connectionMetaRepo.js';
import { MysqlSyncRepo } from './repository/mysql/syncRepo.js';
import { MysqlOrganizationRepo } from './repository/mysql/organizationRepo.js';
import { MysqlMembershipRepo } from './repository/mysql/membershipRepo.js';
import { MysqlSeatRepo } from './repository/mysql/seatRepo.js';
import { MysqlOrderRepo } from './repository/mysql/orderRepo.js';
import { MysqlOrganizationResourceRepo } from './repository/mysql/organizationResourceRepo.js';
import { MysqlOrganizationAuditRepo } from './repository/mysql/organizationAuditRepo.js';
import { MysqlRegistrationRepo } from './repository/mysql/registrationRepo.js';
import { TokenService, type JwtPort } from './service/tokenService.js';
import { AuthService } from './service/authService.js';
import { SubscriptionService } from './service/subscriptionService.js';
import { authRoutes } from './route/auth.js';
import { meRoutes } from './route/me.js';
import { syncRoutes } from './route/sync.js';
import { PlanPolicy, resolveEffectivePlans } from './policy/planPolicy.js';
import { SyncService } from './service/syncService.js';
import { PaymentService } from './service/paymentService.js';
import { AdminService } from './service/adminService.js';
import { ManualPaymentAdapter } from './adapter/manualPaymentAdapter.js';
import { adminRoutes } from './route/admin.js';
import { OrganizationService } from './service/organizationService.js';
import { organizationRoutes } from './route/organizations.js';
import { adminUiRoutes } from './route/adminUi.js';
import { webhookRoutes } from './route/webhook.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import type { GetAuthUser, GetAuthSession } from './middleware/requireAuth.js';
import { MysqlAdminAuditRepo } from './repository/mysql/adminAuditRepo.js';
import { MysqlWebhookEventRepo } from './repository/mysql/webhookEventRepo.js';
import { runMigrations } from './repository/mysql/migrate.js';
import { migrations } from './repository/mysql/migrations/index.js';
import { TrafficCollector } from './observability/trafficCollector.js';
import { registerTrafficPlugin } from './observability/trafficPlugin.js';
import { RateLimitConfig } from './ratelimit/rateLimitConfig.js';
import { registerRateLimit } from './ratelimit/rateLimitPlugin.js';

/**
 * 组合根（composition root）：组装 Fastify 实例 + 依赖注入。
 *
 * 依赖链：route → service → repository(interface) ← mysql 实现
 * - route 层不 new service，全部由 createApp 注入（options 模式）
 * - service 层不直接写 SQL，仅依赖 repository 接口
 * - repository 接口在 domain，实现在 mysql，通过惰性 getter 取连接
 *
 * 期三：接入套餐配额（PlanPolicy + SubscriptionService + /api/me）。
 */
export async function createApp() {
  // trustProxy 决定 req.ip：既是限流的分桶键，也是 devices.ip 的来源。
  // 默认信任 1 跳（nginx 反代）。取值语义见 config.parseTrustProxy。
  //
  // bodyLimit 显式收在 1 MiB（与 Fastify 默认值相同，写出来是为了表明这是决策
  // 而非默认）。放宽只针对真正需要的那一个端点：`PUT /api/sync` 在
  // route/sync.ts 里单独设 SYNC_BODY_LIMIT。
  //
  // 不要把全局值抬高：`/api/auth/login`、`/api/auth/register` 这类未认证端点
  // 只需要几百字节，让它们接受 8~17MB 请求体纯粹是白送攻击面 —— 限流挂在
  // onRequest（早于 body 解析）能兜一部分，但没有理由先把门开大再去堵。
  const app = Fastify({
    logger: true,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  // 全局错误处理器必须早于路由注册：漏写 try/catch 的 handler 靠它兜住，
  // 否则 Fastify 默认处理器会把 err.message（含 mysql2 的原始 SQL）回显给客户端
  registerErrorHandler(app);

  app.register(cors, { origin: process.env.NODE_ENV === 'production' ? (process.env.CORS_ORIGIN || false) : true });
  /**
   * 安全响应头。必须早于路由注册（helmet 挂 onRequest 钩子，Fastify 的封装
   * 规则让钩子只对之后注册的路由生效）。策略与理由见 securityHeaders()。
   */
  app.register(helmet, securityHeaders());
  app.register(sensible);
  app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: config.accessTokenExpiresIn } });
  // 建库必须早于池注册：池里每条连接都要带默认库，否则并发时非首条连接会 ER_NO_DB_ERROR
  await ensureDatabase(app);
  // 字段形式而非 connectionString：@fastify/mysql 的实现是
  // `createPool(options.connectionString || options)` —— 传 URL 就只用这个 URL，
  // 其余选项全被丢弃，池会退回 mysql2 的默认值（10 连接、队列无上限、
  // 无获取超时、timezone:'local'）。实测确认过这四项。见 mysqlPool.ts。
  await app.register(mysql, {
    ...buildMysqlPoolOptions(config.mysql, process.env),
    promise: true,
  });
  app.decorate('jwtSecret', config.jwtSecret);

  // 惰性连接 getter：repo 在路由注册阶段构造，运行时（ready 后）才取 app.mysql
  const getMysql = () => app.mysql;

  // repository 层（实现，可换驱动）
  const userRepo = new MysqlUserRepo(getMysql);
  const planRepo = new MysqlPlanRepo(getMysql);
  const subRepo = new MysqlSubscriptionRepo(getMysql);
  const refreshTokenRepo = new MysqlRefreshTokenRepo(getMysql);
  const deviceRepo = new MysqlDeviceRepo(getMysql);
  const connectionMetaRepo = new MysqlConnectionMetaRepo(getMysql);
  const syncRepo = new MysqlSyncRepo(getMysql);
  const adminAuditRepo = new MysqlAdminAuditRepo(getMysql);
  const webhookEventRepo = new MysqlWebhookEventRepo(getMysql);
  const organizationRepo = new MysqlOrganizationRepo(getMysql);
  const membershipRepo = new MysqlMembershipRepo(getMysql);
  const seatRepo = new MysqlSeatRepo(getMysql);
  const orderRepo = new MysqlOrderRepo(getMysql);
  const organizationResourceRepo = new MysqlOrganizationResourceRepo(getMysql);
  const organizationAuditRepo = new MysqlOrganizationAuditRepo(getMysql);
  const registrationRepo = new MysqlRegistrationRepo(getMysql);

  /**
   * 限流与观测。
   *
   * 注册顺序要紧：两者都用 `onRequest`/`onResponse` 全局钩子，必须早于路由
   * 注册，否则 Fastify 的封装规则会让钩子只对后注册的路由生效。
   *
   * 规则的实际值是代码默认值（`src/ratelimit/rules.ts` 的 DEFAULT_RULES），
   * v2 已无 DB 覆盖。不存在「启动初期不限流」的窗口。
   */
  const trafficCollector = new TrafficCollector();
  const rateLimitConfig = new RateLimitConfig();
  await registerRateLimit(app, {
    config: rateLimitConfig,
    collector: trafficCollector,
    enabled: config.rateLimitEnabled,
  });
  await registerTrafficPlugin(app, { collector: trafficCollector });

  // policy / service 层
  const planPolicy = new PlanPolicy((userId) => resolveEffectivePlans(userId, { membershipRepo, subRepo, planRepo }));
  // 传毫秒而非字符串：解析与上限校验已在 config 完成，避免二次解析与静默回落
  const tokenService = new TokenService(app.jwt as unknown as JwtPort, config.accessTokenExpiresIn, config.refreshTokenExpiresMs);
  const authService = new AuthService(userRepo, subRepo, refreshTokenRepo, deviceRepo, registrationRepo, tokenService, planPolicy, membershipRepo);
  const subscriptionService = new SubscriptionService(userRepo, planRepo, subRepo, membershipRepo, organizationRepo, deviceRepo, syncRepo, connectionMetaRepo, planPolicy);
  const syncService = new SyncService(syncRepo, userRepo, planPolicy, connectionMetaRepo, deviceRepo);
  const adminService = new AdminService(userRepo, planRepo, subRepo, membershipRepo, organizationRepo, refreshTokenRepo, syncRepo, deviceRepo, connectionMetaRepo, adminAuditRepo, planPolicy);
  const paymentService = new PaymentService(subRepo, organizationRepo, planRepo, orderRepo, seatRepo, webhookEventRepo, membershipRepo);
  const organizationService = new OrganizationService(organizationRepo, membershipRepo, seatRepo, organizationResourceRepo, organizationAuditRepo, subRepo, planRepo);
  paymentService.registerProvider(new ManualPaymentAdapter());

  /**
   * 认证中间件的用户状态查询。
   *
   * 每个已认证请求多一次 users 主键查询，换来「禁用/降级即时生效」：
   * token 里的 status/role 是签发时的快照，只读 token 的话封禁要等到
   * access token 过期（默认 15 分钟）才生效，而 refresh 还能无限续期。
   * 刻意不加缓存 —— TTL 缓存只是把 15 分钟窗口缩短，不是消除。
   */
  const getUser: GetAuthUser = async (id) => userRepo.findById(id);

  /**
   * access token 的吊销校验。
   *
   * token 里的 `sid` 是签发它的 refresh token 行 id，那一行的 revoked_time
   * 已被登出 / 改密 / 踢设备 / 重用检测维护着，所以不需要另建 jti 黑名单。
   * 少了这一步，所有「立即下线」实际都是延迟到 access token 过期才下线。
   */
  const getSession: GetAuthSession = async (id) => refreshTokenRepo.findById(id);

  // route 层
  app.get('/health', async () => ({ status: 'ok' }));
  app.register(adminUiRoutes);
  app.register(authRoutes, { authService, getUser, getSession });
  app.register(meRoutes, { subscriptionService, getUser, getSession });
  app.register(organizationRoutes, { organizationService, getUser, getSession });
  app.register(syncRoutes, { syncService, getUser, getSession });
  app.register(adminRoutes, {
    adminService,
    paymentService,
    getUser,
    getSession,
    trafficCollector,
  });
  app.register(webhookRoutes, { paymentService });

  await app.ready();
  await runMigrations(app.mysql as any, [...migrations]);

  // 启动时批量降级到期订阅
  void subscriptionService.downgradeExpired().catch((e) => app.log.warn({ err: e }, 'downgradeExpired failed'));

  return app;
}

/**
 * 用一条临时连接确保目标库存在，随后立即关闭。
 *
 * 不能复用 `app.mysql`：那是带 `database` 的池，库不存在时连接本身就建不起来。
 * 账号无建库权限时不视为失败（库通常已由 DBA 预建），但库确实不存在时
 * 后续池注册会立刻报错——把原先「启动静默通过、首次查询才炸」改成启动即失败。
 */
async function ensureDatabase(app: ReturnType<typeof Fastify>): Promise<void> {
  const { mysql: m } = config;
  let conn: Awaited<ReturnType<typeof createConnection>> | undefined;
  try {
    conn = await createConnection({ host: m.host, port: m.port, user: m.user, password: m.password });
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${m.database.replace(/`/g, '``')}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  } catch (err: any) {
    if (err?.code !== 'ER_DBACCESS_DENIED_ERROR' && err?.code !== 'ER_CANT_CREATE_DB') throw err;
    app.log.warn({ err }, `no privilege to create database "${m.database}"; assuming it already exists`);
  } finally {
    await conn?.end().catch(() => {});
  }
}
