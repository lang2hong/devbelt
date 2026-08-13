import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import mysql from '@fastify/mysql';
import sensible from '@fastify/sensible';
import { config } from './config.js';
import { initSchema } from './repository/mysql/schema.js';
import { MysqlUserRepo } from './repository/mysql/userRepo.js';
import { MysqlPlanRepo } from './repository/mysql/planRepo.js';
import { MysqlSubscriptionRepo } from './repository/mysql/subscriptionRepo.js';
import { MysqlRefreshTokenRepo } from './repository/mysql/refreshTokenRepo.js';
import { MysqlPatRepo } from './repository/mysql/patRepo.js';
import { MysqlSyncRepo } from './repository/mysql/syncRepo.js';
import { TokenService, type JwtPort } from './service/tokenService.js';
import { AuthService } from './service/authService.js';
import { SubscriptionService } from './service/subscriptionService.js';
import { authRoutes } from './route/auth.js';
import { meRoutes } from './route/me.js';
import { syncRoutes } from './route/sync.js';
import { PlanPolicy } from './policy/planPolicy.js';
import { SyncService } from './service/syncService.js';
import { PatService } from './service/patService.js';
import { PaymentService } from './service/paymentService.js';
import { AdminService } from './service/adminService.js';
import { ManualPaymentAdapter } from './adapter/manualPaymentAdapter.js';
import { adminRoutes } from './route/admin.js';
import { patRoutes } from './route/pat.js';
import { webhookRoutes } from './route/webhook.js';

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
  const app = Fastify({ logger: true });

  app.register(cors, { origin: process.env.NODE_ENV === 'production' ? (process.env.CORS_ORIGIN || false) : true });
  app.register(sensible);
  app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: config.accessTokenExpiresIn } });
  await app.register(mysql, { connectionString: authString(), promise: true });
  app.decorate('jwtSecret', config.jwtSecret);

  // 惰性连接 getter：repo 在路由注册阶段构造，运行时（ready 后）才取 app.mysql
  const getMysql = () => app.mysql;

  // repository 层（实现，可换驱动）
  const userRepo = new MysqlUserRepo(getMysql);
  const planRepo = new MysqlPlanRepo(getMysql);
  const subRepo = new MysqlSubscriptionRepo(getMysql);
  const refreshTokenRepo = new MysqlRefreshTokenRepo(getMysql);
  const patRepo = new MysqlPatRepo(getMysql);
  const syncRepo = new MysqlSyncRepo(getMysql);

  // policy / service 层
  const planPolicy = new PlanPolicy((code) => planRepo.findByCode(code));
  const tokenService = new TokenService(app.jwt as unknown as JwtPort, config.accessTokenExpiresIn, config.refreshTokenExpiresIn);
  const authService = new AuthService(userRepo, planRepo, subRepo, refreshTokenRepo, tokenService, config.jwtSecret);
  const subscriptionService = new SubscriptionService(userRepo, planRepo, subRepo, refreshTokenRepo, patRepo, syncRepo);
  const syncService = new SyncService(syncRepo, userRepo, planPolicy);
  const patService = new PatService(patRepo, userRepo, planPolicy);
  const adminService = new AdminService(userRepo);
  const paymentService = new PaymentService(subRepo, userRepo);
  paymentService.registerProvider(new ManualPaymentAdapter());

  // route 层
  app.get('/health', async () => ({ status: 'ok' }));
  app.register(authRoutes, { authService });
  app.register(meRoutes, { subscriptionService });
  app.register(syncRoutes, { syncService });
  app.register(patRoutes, { patService });
  app.register(adminRoutes, { adminService, paymentService });
  app.register(webhookRoutes, { paymentService });

  await app.ready();
  await initSchema(app);

  // 启动时批量降级到期订阅
  void subscriptionService.downgradeExpired().catch((e) => app.log.warn({ err: e }, 'downgradeExpired failed'));

  return app;
}

/** 构造 MySQL 连接串（不含 database，由 initSchema 执行 USE） */
function authString(): string {
  const { mysql: m } = config;
  return `mysql://${encodeURIComponent(m.user)}:${encodeURIComponent(m.password)}@${m.host}:${m.port}`;
}
