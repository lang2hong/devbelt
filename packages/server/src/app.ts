import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import mysql from '@fastify/mysql';
import sensible from '@fastify/sensible';
import { createConnection } from 'mysql2/promise';
import { config, signingKeys } from './config.js';
import { buildMysqlPoolOptions } from './mysqlPool.js';
import { MysqlUserRepo } from './repository/mysql/userRepo.js';
import { MysqlEmailVerificationTokenRepo } from './repository/mysql/emailVerificationTokenRepo.js';
import { MysqlPersonalPlanRepo } from './repository/mysql/personalPlanRepo.js';
import { MysqlPersonalSubscriptionRepo } from './repository/mysql/personalSubscriptionRepo.js';
import { MysqlDeviceRepo } from './repository/mysql/deviceRepo.js';
import { MysqlRefreshTokenRepo } from './repository/mysql/refreshTokenRepo.js';
import { MysqlRateLimitRepo } from './repository/mysql/rateLimitRepo.js';
import { MysqlRegistrationRepo } from './repository/mysql/registrationRepo.js';
import { MysqlOrganizationPlanRepo } from './repository/mysql/organizationPlanRepo.js';
import { MysqlOrganizationRepo } from './repository/mysql/organizationRepo.js';
import { MysqlOrganizationSubscriptionRepo } from './repository/mysql/organizationSubscriptionRepo.js';
import { MysqlMembershipRepo } from './repository/mysql/membershipRepo.js';
import { MysqlOrganizationInvitationRepo } from './repository/mysql/invitationRepo.js';
import { MysqlFolderRepo } from './repository/mysql/folderRepo.js';
import { MysqlResourceRepo } from './repository/mysql/resourceRepo.js';
import { MysqlSyncStateRepo } from './repository/mysql/syncStateRepo.js';
import { MysqlSyncRecordRepo } from './repository/mysql/syncRecordRepo.js';
import { MysqlSyncMutationRepo } from './repository/mysql/syncMutationRepo.js';
import { MysqlSyncNonceRepo } from './repository/mysql/syncNonceRepo.js';
import { MysqlSyncResetTokenRepo } from './repository/mysql/syncResetTokenRepo.js';
import { TokenService } from './service/tokenService.js';
import { AuthService } from './service/authService.js';
import { OrganizationService } from './service/organizationService.js';
import { OrganizationResourceService } from './service/organizationResourceService.js';
import { SyncStateService } from './service/syncStateService.js';
import { SyncRecordService } from './service/syncRecordService.js';
import { SyncResetService } from './service/syncResetService.js';
import { RateLimitService } from './service/rateLimitService.js';
import { startRateLimitCleanup } from './service/rateLimitCleanup.js';
import { startInvitationCleanup } from './service/invitationCleanup.js';
import { startRetentionCleanup } from './service/retentionCleanup.js';
import { resolveEmailSender } from './service/resolveEmailSender.js';
import { authRoutes } from './route/auth.js';
import { meRoutes } from './route/me.js';
import { personalRoutes } from './route/personal.js';
import { organizationRoutes } from './route/organizations.js';
import { invitationRoutes } from './route/invitations.js';
import { syncRoutes } from './route/sync.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { buildLoggerOptions } from './middleware/requestLogging.js';
import { runMigrations } from './repository/mysql/migrate.js';
import { migrations } from './repository/mysql/migrations/index.js';
import { mysqlTimeZoneInit } from './repository/mysql/mysqlTimeZoneInit.js';
import { withTransaction } from './repository/mysql/db.js';
import { MysqlMailFlowRepo } from './repository/mysql/mailFlowRepo.js';
import { MysqlAuditRepo } from './repository/mysql/auditRepo.js';
import { LinkFlowService } from './service/linkFlowService.js';
import { AuditWriter } from './service/auditWriter.js';
import { CsrfService } from './service/csrfService.js';
import { linkFlowRoutes } from './route/linkFlows.js';
import { consoleAuthRoutes } from './route/consoleAuth.js';
import { requestId } from './middleware/requestId.js';
import { registerConsoleStatic } from './consoleStatic.js';

/**
 * 组合根（composition root）：组装 Fastify 实例 + 依赖注入。
 *
 * 依赖链：route -> service -> repository(interface) <- mysql 实现。
 *
 * EmailSender 按 SMTP_* 环境变量选择（生产 SMTP / 开发 log）。
 */
export async function createApp() {
  const app = Fastify({
    // 自定义 req 序列化器：URL 里的邮箱验证 / 邀请 token 不得进日志（§8）。
    logger: buildLoggerOptions(),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    ajv: {
      customOptions: {
        // 让 additionalProperties: false 真正拒绝未知字段（实施规格 §5.2），
        // 而不是 Fastify 默认的「静默剔除」。
        removeAdditional: false,
      },
    },
  });

  registerErrorHandler(app);
  app.register(requestId);

  app.register(cors, { origin: process.env.NODE_ENV === 'production' ? (process.env.CORS_ORIGIN || false) : true });
  app.register(helmet, securityHeaders());
  app.register(sensible);

  // 建库必须早于池注册（池带默认库，库不存在时连接建不起来）。
  await ensureDatabase(app);

  const mysqlOptions = buildMysqlPoolOptions(config.mysql, process.env);
  await app.register(mysql, {
    ...mysqlOptions,
    promise: true,
  });
  await mysqlTimeZoneInit(app.mysql);

  const getMysql = () => app.mysql;

  // repository 层
  const userRepo = new MysqlUserRepo(getMysql);
  const emailVerificationTokenRepo = new MysqlEmailVerificationTokenRepo(getMysql);
  const personalPlanRepo = new MysqlPersonalPlanRepo(getMysql);
  const personalSubscriptionRepo = new MysqlPersonalSubscriptionRepo(getMysql);
  const deviceRepo = new MysqlDeviceRepo(getMysql);
  const refreshTokenRepo = new MysqlRefreshTokenRepo(getMysql);
  const rateLimitRepo = new MysqlRateLimitRepo(getMysql);
  const registrationRepo = new MysqlRegistrationRepo(getMysql);
  const organizationPlanRepo = new MysqlOrganizationPlanRepo(getMysql);
  const organizationRepo = new MysqlOrganizationRepo(getMysql);
  const organizationSubscriptionRepo = new MysqlOrganizationSubscriptionRepo(getMysql);
  const membershipRepo = new MysqlMembershipRepo(getMysql);
  const invitationRepo = new MysqlOrganizationInvitationRepo(getMysql);
  const folderRepo = new MysqlFolderRepo(getMysql);
  const resourceRepo = new MysqlResourceRepo(getMysql);
  const syncStateRepo = new MysqlSyncStateRepo(getMysql);
  const syncRecordRepo = new MysqlSyncRecordRepo();
  const syncMutationRepo = new MysqlSyncMutationRepo();
  const syncNonceRepo = new MysqlSyncNonceRepo();
  const syncResetTokenRepo = new MysqlSyncResetTokenRepo();
  const mailFlowRepo = new MysqlMailFlowRepo(getMysql);
  const auditRepo = new MysqlAuditRepo(getMysql);

  // service 层
  const tokenService = new TokenService(signingKeys, config.accessTokenExpiresIn, config.refreshTokenExpiresMs);
  const rateLimiter = new RateLimitService(rateLimitRepo, config.rateLimitEnabled);
  const emailSender = resolveEmailSender(process.env);
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
    (fn) => withTransaction(app.mysql, fn),
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
    (fn) => withTransaction(app.mysql, fn),
  );
  const resourceService = new OrganizationResourceService(
    organizationRepo,
    organizationSubscriptionRepo,
    membershipRepo,
    folderRepo,
    resourceRepo,
    (fn) => withTransaction(app.mysql, fn),
  );
  const syncStateService = new SyncStateService(
    syncStateRepo,
    syncRecordRepo,
    syncMutationRepo,
    (fn) => withTransaction(app.mysql, fn),
  );
  const syncRecordService = new SyncRecordService(
    syncStateRepo,
    syncRecordRepo,
    syncNonceRepo,
    syncMutationRepo,
    personalSubscriptionRepo,
    (fn) => withTransaction(app.mysql, fn),
  );
  const syncResetService = new SyncResetService(
    syncStateRepo,
    syncRecordRepo,
    syncResetTokenRepo,
    userRepo,
    (fn) => withTransaction(app.mysql, fn),
    emailSender,
    rateLimiter,
  );
  const csrfService = new CsrfService();
  const auditWriter = new AuditWriter(auditRepo, (msg, data) => app.log.warn({ data }, msg));
  const linkFlowService = new LinkFlowService(
    mailFlowRepo,
    emailVerificationTokenRepo,
    userRepo,
    (fn) => withTransaction(app.mysql, fn),
    rateLimiter,
  );

  // 受控限流清理任务（实施规格 §3）：过期桶由周期任务删除，不依赖请求
  startRateLimitCleanup(rateLimitRepo);
  // 受控邀请过期清理任务（实施规格 §3）：过期邀请释放容量，不依赖成员再次操作
  startInvitationCleanup(() => organizationService.expireInvitations());
  // 过期数据保留清理：refresh_tokens / email_verification_tokens /
  // personal_sync_mutations / personal_sync_reset_tokens 四张表原本只增不减
  // （其中三张自带 expires_time 却无人消费）。
  startRetentionCleanup({
    refreshTokenRepo,
    emailVerificationTokenRepo,
    syncMutationRepo,
    syncResetTokenRepo,
    mailFlowRepo,
    exec: () => app.mysql,
  });

  // route 层
  const getUser = async (id: number) => userRepo.findById(id);

  app.get('/health', async () => ({ status: 'ok' }));
  app.register(authRoutes, { authService, tokenService, getUser });
  app.register(meRoutes, { tokenService, getUser, userRepo, personalSubscriptionRepo, personalPlanRepo });
  app.register(personalRoutes, { tokenService, getUser, deviceRepo, revokeDevice: (userId, deviceId) => authService.revokeDevice(userId, deviceId) });
  app.register(organizationRoutes, { tokenService, getUser, organizationService, resourceService, organizationRepo, membershipRepo });
  app.register(invitationRoutes, { tokenService, getUser, organizationService });
  app.register(syncRoutes, { tokenService, getUser, syncState: syncStateService, syncRecord: syncRecordService, syncReset: syncResetService });
  app.register(consoleAuthRoutes, { csrfService, rateLimiter });
  app.register(linkFlowRoutes, {
    linkFlowService,
    csrfService,
    auditWriter,
    consoleOrigin: config.consoleOrigin,
    resendVerification: (email, ip) => authService.resendVerification(email, ip),
  });
  await registerConsoleStatic(app);

  await app.ready();
  await runMigrations(app.mysql as any, [...migrations]);

  return app;
}

/**
 * 用一条临时连接确保目标库存在，随后立即关闭。
 * 账号无建库权限时不视为失败（库通常已由 DBA 预建）。
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
