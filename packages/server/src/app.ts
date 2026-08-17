import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import mysql from '@fastify/mysql';
import sensible from '@fastify/sensible';
import { createConnection } from 'mysql2/promise';
import { config } from './config.js';
import { initSchema } from './repository/mysql/schema.js';
import { MysqlUserRepo } from './repository/mysql/userRepo.js';
import { MysqlPlanRepo } from './repository/mysql/planRepo.js';
import { MysqlSubscriptionRepo } from './repository/mysql/subscriptionRepo.js';
import { MysqlRefreshTokenRepo } from './repository/mysql/refreshTokenRepo.js';
import { MysqlDeviceRepo } from './repository/mysql/deviceRepo.js';
import { MysqlConnectionMetaRepo } from './repository/mysql/connectionMetaRepo.js';
import { MysqlSyncEventRepo } from './repository/mysql/syncEventRepo.js';
import { MysqlUsageEventRepo } from './repository/mysql/usageEventRepo.js';
import { MysqlSyncRepo } from './repository/mysql/syncRepo.js';
import { TokenService, type JwtPort } from './service/tokenService.js';
import { AuthService } from './service/authService.js';
import { SubscriptionService } from './service/subscriptionService.js';
import { authRoutes } from './route/auth.js';
import { meRoutes } from './route/me.js';
import { syncRoutes } from './route/sync.js';
import { PlanPolicy } from './policy/planPolicy.js';
import { SyncService } from './service/syncService.js';
import { PaymentService } from './service/paymentService.js';
import { AdminService } from './service/adminService.js';
import { ManualPaymentAdapter } from './adapter/manualPaymentAdapter.js';
import { adminRoutes } from './route/admin.js';
import { adminUiRoutes } from './route/adminUi.js';
import { webhookRoutes } from './route/webhook.js';
import { usageRoutes } from './route/usage.js';

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
  // 建库必须早于池注册：池里每条连接都要带默认库，否则并发时非首条连接会 ER_NO_DB_ERROR
  await ensureDatabase(app);
  await app.register(mysql, { connectionString: authString(), promise: true });
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
  const syncEventRepo = new MysqlSyncEventRepo(getMysql);
  const usageEventRepo = new MysqlUsageEventRepo(getMysql);
  const syncRepo = new MysqlSyncRepo(getMysql);

  // policy / service 层
  const planPolicy = new PlanPolicy((code) => planRepo.findByCode(code));
  const tokenService = new TokenService(app.jwt as unknown as JwtPort, config.accessTokenExpiresIn, config.refreshTokenExpiresIn);
  const authService = new AuthService(userRepo, subRepo, refreshTokenRepo, deviceRepo, tokenService, config.jwtSecret);
  const subscriptionService = new SubscriptionService(userRepo, planRepo, subRepo, refreshTokenRepo, syncRepo, connectionMetaRepo);
  const syncService = new SyncService(syncRepo, userRepo, planPolicy, connectionMetaRepo, syncEventRepo);
  const adminService = new AdminService(userRepo, planRepo, subRepo, refreshTokenRepo, syncRepo, deviceRepo, connectionMetaRepo, syncEventRepo, usageEventRepo);
  const paymentService = new PaymentService(subRepo, userRepo);
  paymentService.registerProvider(new ManualPaymentAdapter());

  // route 层
  app.get('/health', async () => ({ status: 'ok' }));
  app.register(adminUiRoutes);
  app.register(authRoutes, { authService });
  app.register(meRoutes, { subscriptionService });
  app.register(syncRoutes, { syncService });
  app.register(usageRoutes, { usageEventRepo });
  app.register(adminRoutes, { adminService, paymentService });
  app.register(webhookRoutes, { paymentService });

  await app.ready();
  await initSchema(app);

  // 启动时批量降级到期订阅
  void subscriptionService.downgradeExpired().catch((e) => app.log.warn({ err: e }, 'downgradeExpired failed'));

  return app;
}

/**
 * 构造 MySQL 连接串（**含 database**）。
 *
 * 必须带库名：`@fastify/mysql` 默认走 `createPool`，池中每条连接独立握手，
 * 靠一次 `USE db` 只能影响当前借出的那条，其余连接没有默认库。
 */
function authString(): string {
  const { mysql: m } = config;
  const auth = `${encodeURIComponent(m.user)}:${encodeURIComponent(m.password)}`;
  return `mysql://${auth}@${m.host}:${m.port}/${encodeURIComponent(m.database)}`;
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
      `CREATE DATABASE IF NOT EXISTS \`${m.database.replace(/`/g, '``')}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } catch (err: any) {
    if (err?.code !== 'ER_DBACCESS_DENIED_ERROR' && err?.code !== 'ER_CANT_CREATE_DB') throw err;
    app.log.warn({ err }, `no privilege to create database "${m.database}"; assuming it already exists`);
  } finally {
    await conn?.end().catch(() => {});
  }
}
