import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import mysql from '@fastify/mysql';
import sensible from '@fastify/sensible';
import { createConnection } from 'mysql2/promise';
import { config, signingKeys } from './config.js';
import { resolveCorsOrigin } from './service/consoleOrigin.js';
import { buildMysqlPoolOptions } from './mysqlPool.js';
import { MysqlUserRepo } from './repository/mysql/userRepo.js';
import { MysqlEmailVerificationTokenRepo } from './repository/mysql/emailVerificationTokenRepo.js';
import { MysqlPersonalSubscriptionRepo } from './repository/mysql/personalSubscriptionRepo.js';
import { MysqlDeviceRepo } from './repository/mysql/deviceRepo.js';
import { MysqlRefreshTokenRepo } from './repository/mysql/refreshTokenRepo.js';
import { MysqlRateLimitRepo } from './repository/mysql/rateLimitRepo.js';
import { MysqlRegistrationRepo } from './repository/mysql/registrationRepo.js';
import { MysqlPlanRepo, MysqlPlanFeatureDefRepo } from './repository/mysql/planRepo.js';
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
import { MysqlSyncResetHandoffRepo } from './repository/mysql/syncResetHandoffRepo.js';
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
import { startNonceCleanup } from './service/nonceCleanup.js';
import { startRetentionCleanup } from './service/retentionCleanup.js';
import { resolveEmailSender } from './service/resolveEmailSender.js';
import { authRoutes } from './route/auth.js';
import { meRoutes } from './route/me.js';
import { plansRoutes, consolePlansRoutes } from './route/plans.js';
import { personalRoutes } from './route/personal.js';
import { organizationRoutes } from './route/organizations.js';
import { invitationRoutes } from './route/invitations.js';
import { syncRoutes } from './route/sync.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { securityHeaders, globalSecurityHeaders } from './middleware/securityHeaders.js';
import { buildLoggerOptions } from './middleware/requestLogging.js';
import { runMigrations } from './repository/mysql/migrate.js';
import { migrations, LEGACY_MIGRATION_VERSIONS } from './repository/mysql/migrations/index.js';
import { mysqlTimeZoneInit } from './repository/mysql/mysqlTimeZoneInit.js';
import { withTransaction } from './repository/mysql/db.js';
import { registerHealthRoutes } from './route/health.js';
import { MetricsRegistry, attachRequestMetrics } from './service/metrics.js';
import { MysqlMailFlowRepo } from './repository/mysql/mailFlowRepo.js';
import { MysqlAuditRepo } from './repository/mysql/auditRepo.js';
import { MysqlIdempotencyReceiptRepo } from './repository/mysql/idempotencyReceiptRepo.js';
import { MysqlOrderRepo } from './repository/mysql/orderRepo.js';
import { MysqlPaymentRepo } from './repository/mysql/paymentRepo.js';
import { MysqlPaymentCallbackNonceRepo } from './repository/mysql/paymentCallbackNonceRepo.js';
import { LinkFlowService } from './service/linkFlowService.js';
import { AuditWriter } from './service/auditWriter.js';
import { bootstrapPlatformAdmins } from './service/platformAdminBootstrap.js';
import { IdempotencyService } from './service/idempotencyService.js';
import { CsrfService, deriveCsrfKey } from './service/csrfService.js';
import { linkFlowRoutes } from './route/linkFlows.js';
import { consoleLinkFlowRoutes } from './route/consoleLinkFlows.js';
import { consoleAuthRoutes } from './route/consoleAuth.js';
import { consoleMeRoutes } from './route/consoleMe.js';
import { consoleDataRoutes } from './route/consoleData.js';
import { consoleAdminRoutes } from './route/consoleAdmin.js';
import { registerPaymentRoutes } from './route/paymentRoutes.js';
import { invoiceRoutes } from './route/invoices.js';
import { InvoiceService } from './service/invoiceService.js';
import { MysqlInvoiceRepo } from './repository/mysql/invoiceRepo.js';
import { ConsoleAuthService } from './service/consoleAuthService.js';
import { ConsoleAdminService } from './service/consoleAdminService.js';
import { OrderService } from './service/paymentService.js';
import { resolvePaymentGateway, paymentRoutesEnabled, isChannelConfigured } from './service/paymentChannel.js';
import { resolveFeatureFlags } from './service/featureFlags.js';
import { CursorService, deriveCursorKey } from './service/cursor.js';
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

  app.register(cors, { origin: resolveCorsOrigin() });
  app.register(helmet, securityHeaders(process.env.NODE_ENV === 'production'));
  globalSecurityHeaders(app);
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
  const planRepo = new MysqlPlanRepo(getMysql);
  const featureDefRepo = new MysqlPlanFeatureDefRepo(getMysql);
  const personalSubscriptionRepo = new MysqlPersonalSubscriptionRepo(getMysql);
  const deviceRepo = new MysqlDeviceRepo(getMysql);
  const refreshTokenRepo = new MysqlRefreshTokenRepo(getMysql);
  const rateLimitRepo = new MysqlRateLimitRepo(getMysql);
  const registrationRepo = new MysqlRegistrationRepo(getMysql);
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
  const syncResetTokenRepo = new MysqlSyncResetTokenRepo(getMysql);
  const syncResetHandoffRepo = new MysqlSyncResetHandoffRepo(getMysql);
  const mailFlowRepo = new MysqlMailFlowRepo(getMysql);
  const auditRepo = new MysqlAuditRepo(getMysql);
  const idempotencyReceiptRepo = new MysqlIdempotencyReceiptRepo(getMysql);
  const orderRepo = new MysqlOrderRepo(getMysql);
  const paymentRepo = new MysqlPaymentRepo();
  const paymentNonceRepo = new MysqlPaymentCallbackNonceRepo();
  const invoiceRepo = new MysqlInvoiceRepo(getMysql);

  // service 层
  const tokenService = new TokenService(signingKeys, config.accessTokenExpiresIn, config.refreshTokenExpiresMs);
  const rateLimiter = new RateLimitService(rateLimitRepo, config.rateLimitEnabled);
  const emailSender = resolveEmailSender(process.env);
  const auditWriter = new AuditWriter(auditRepo, (msg, data) => app.log.warn({ data }, msg));
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
    (fn) => withTransaction(app.mysql, fn),
    auditWriter,
  );
  const organizationService = new OrganizationService(
    userRepo,
    organizationRepo,
    planRepo,
    organizationSubscriptionRepo,
    membershipRepo,
    invitationRepo,
    rateLimiter,
    tokenService,
    emailSender,
    (fn) => withTransaction(app.mysql, fn),
    auditWriter,
  );
  const resourceService = new OrganizationResourceService(
    organizationRepo,
    organizationSubscriptionRepo,
    planRepo,
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
    // 状态密钥 mutation 的按用户限流（回执优先于限流，仅 account-recover 在真正写时计数）。
    // 窗口/上限与 route/sync.ts 的 SYNC_KEYS_WINDOW_S / SYNC_KEYS_MAX 保持一致。
    (tx, userId) => rateLimiter.hitInTx(tx, `sync:keys:user:${userId}`, 3600, 20),
  );
  const syncRecordService = new SyncRecordService(
    syncStateRepo,
    syncRecordRepo,
    syncNonceRepo,
    syncMutationRepo,
    personalSubscriptionRepo,
    planRepo,
    (fn) => withTransaction(app.mysql, fn),
  );
  const csrfService = new CsrfService(deriveCsrfKey());
  const syncResetService = new SyncResetService(
    syncStateRepo,
    syncRecordRepo,
    syncResetTokenRepo,
    userRepo,
    (fn) => withTransaction(app.mysql, fn),
    emailSender,
    rateLimiter,
    mailFlowRepo,
    syncResetHandoffRepo,
    auditWriter,
    config.syncExtensionId,
  );
  const idempotencyService = new IdempotencyService(idempotencyReceiptRepo, (fn) => withTransaction(app.mysql, fn));
  const linkFlowService = new LinkFlowService(
    mailFlowRepo,
    emailVerificationTokenRepo,
    syncResetTokenRepo,
    userRepo,
    invitationRepo,
    organizationRepo,
    organizationSubscriptionRepo,
    membershipRepo,
    (fn) => withTransaction(app.mysql, fn),
    rateLimiter,
  );
  const consoleAuthService = new ConsoleAuthService(
    userRepo,
    deviceRepo,
    refreshTokenRepo,
    tokenService,
    rateLimiter,
    (fn) => withTransaction(app.mysql, fn),
    auditWriter,
  );
  const adminService = new ConsoleAdminService({
    userRepo,
    refreshTokenRepo,
    planRepo,
    personalSubscriptionRepo,
    organizationRepo,
    organizationSubscriptionRepo,
    membershipRepo,
    auditRepo,
    orderRepo,
    invoiceRepo,
    auditWriter,
    rateLimiter,
  });
  const cursorService = new CursorService(deriveCursorKey());

  const invoiceService = new InvoiceService({ invoiceRepo, orderRepo, auditWriter });

  const orderService = new OrderService({
    orderRepo,
    paymentRepo,
    planRepo,
    personalSubscriptionRepo,
    auditWriter,
    runner: (fn) => withTransaction(app.mysql, fn),
    gatewayFor: (channel) => resolvePaymentGateway(channel),
    nonceRepo: paymentNonceRepo,
  });
  const featureFlags = resolveFeatureFlags();
  // opt-in：凭据齐全 + 显式 FEATURE_PAYMENT=true 才注册真支付路由，否则仅注册只读订单路由。
  const paymentEnabled = paymentRoutesEnabled();

  // 受控限流清理任务（实施规格 §3）：过期桶由周期任务删除，不依赖请求
  // 受控邀请过期清理任务（实施规格 §3）：过期邀请释放容量，不依赖成员再次操作
  // 过期数据保留清理（refresh_tokens / email_verification_tokens /
  // personal_sync_mutations / personal_sync_reset_tokens 等表原本只增不减）。
  // 三者返回 { stop }：绑定到 app.close()，避免测试/嵌入式多实例里定时器持续打已关闭的池。
  const cleanupHandles = [
    startRateLimitCleanup(rateLimitRepo),
    startInvitationCleanup(() => organizationService.expireInvitations()),
    startNonceCleanup(async () => { await paymentNonceRepo.purgeExpired(app.mysql); }),
    startRetentionCleanup({
      refreshTokenRepo,
      emailVerificationTokenRepo,
      syncMutationRepo,
      syncResetTokenRepo,
      syncResetHandoffRepo,
      mailFlowRepo,
      idempotencyReceiptRepo,
      orderRepo,
      auditWriter,
      exec: () => app.mysql,
    }),
  ];
  app.addHook('onClose', async () => {
    for (const handle of cleanupHandles) {
      try { handle.stop(); } catch { /* 已停止 */ }
    }
  });

  // route 层
  const getUser = async (id: number) => userRepo.findById(id);
  const getSessionActive = (sessionId: string) => refreshTokenRepo.hasActiveToken(sessionId);

  // 请求速率 / 错误率打点（§11.3）：按 (method, route, status) 维度累加。
  // 通过 app 装饰器 `app.metrics.snapshot()` 暴露给部署层/监控集成采集（受限出口，
  // 不含 path 实际值 / query / token / 用户标识）。
  const metrics = new MetricsRegistry();
  attachRequestMetrics(app, metrics);
  app.decorate('metrics', metrics);

  registerHealthRoutes(app, {
    migrations,
    getDb: () => app.mysql,
    // 邮件依赖就绪性由启动期把关（production 缺 SMTP 直接启动失败），此处恒就绪。
    mailReady: true,
  });
  app.register(authRoutes, { authService, tokenService, getUser, getSessionActive, auditWriter, csrfService, consoleOrigin: config.consoleOrigin });
  app.register(meRoutes, { tokenService, getUser, getSessionActive, userRepo, personalSubscriptionRepo, planRepo });
  app.register(plansRoutes, { tokenService, getUser, getSessionActive, planRepo, featureDefRepo });
  app.register(personalRoutes, { tokenService, getUser, getSessionActive, auditWriter, csrfService, consoleOrigin: config.consoleOrigin, deviceRepo, idempotencyService, revokeDevice: (userId, deviceId) => authService.revokeDevice(userId, deviceId), revokeDeviceInTx: (tx, userId, deviceId) => authService.revokeDeviceInTx(tx, userId, deviceId) });
  app.register(organizationRoutes, { tokenService, getUser, getSessionActive, csrfService, consoleOrigin: config.consoleOrigin, organizationService, resourceService, organizationRepo, membershipRepo, auditWriter, idempotencyService, sendInvitation: (o) => organizationService.sendInvitation(o) });
  app.register(invitationRoutes, { tokenService, getUser, getSessionActive, csrfService, consoleOrigin: config.consoleOrigin, organizationService });
  app.register(syncRoutes, { tokenService, getUser, getSessionActive, syncState: syncStateService, syncRecord: syncRecordService, syncReset: syncResetService, rateLimiter, verifyAccountRecoveryPassword: (userId, password) => authService.verifyPasswordStepUp(userId, password), auditWriter, emailSender, userRepo });
  app.register(consoleAuthRoutes, {
    csrfService,
    rateLimiter,
    consoleAuthService,
    consoleOrigin: config.consoleOrigin,
    auditWriter,
    refreshMaxAgeSeconds: Math.floor(config.refreshTokenExpiresMs / 1000),
    register: (email, password, displayName, ip) => authService.register(email, password, displayName, ip),
    bindMailFlow: (nonce, userId) => linkFlowService.bindFlowToUser(nonce, userId),
  });
  app.register(consoleMeRoutes, {
    tokenService,
    getUser,
    getSessionActive,
    csrfService,
    auditWriter,
    rateLimiter,
    idempotencyService,
    consoleOrigin: config.consoleOrigin,
    userRepo,
    personalSubscriptionRepo,
    planRepo,
    membershipRepo,
  });
  app.register(consolePlansRoutes, { tokenService, getUser, getSessionActive, planRepo, featureDefRepo });
  app.register(consoleDataRoutes, {
    tokenService,
    getUser,
    getSessionActive,
    auditWriter,
    rateLimiter,
    userRepo,
    personalSubscriptionRepo,
    planRepo,
    membershipRepo,
    organizationRepo,
    syncStateRepo,
    syncRecordRepo,
    db: getMysql(),
  });
  app.register(consoleAdminRoutes, {
    tokenService,
    getUser,
    getSessionActive,
    csrfService,
    consoleOrigin: config.consoleOrigin,
    rateLimiter,
    idempotencyService,
    adminService,
    cursorService,
    serverVersion: '1.0.0',
    consoleApiVersion: '1',
  });
  app.register(linkFlowRoutes, {
    linkFlowService,
    csrfService,
    auditWriter,
    consoleOrigin: config.consoleOrigin,
    resendVerification: (email, ip) => authService.resendVerification(email, ip),
  });
  app.register(consoleLinkFlowRoutes, {
    tokenService,
    getUser,
    getSessionActive,
    linkFlowService,
    csrfService,
    auditWriter,
    rateLimiter,
    consoleOrigin: config.consoleOrigin,
    createSyncResetHandoff: (nonce, userId) => syncResetService.createHandoff(nonce, userId),
  });
  if (paymentEnabled) {
    await registerPaymentRoutes(app, {
      enabled: true,
      orders: {
        tokenService,
        getUser,
        getSessionActive,
        csrfService,
        consoleOrigin: config.consoleOrigin,
        rateLimiter,
        cursorService,
        orderService,
        paymentFeatureEnabled: () => featureFlags.enabled('payment'),
        channelConfigured: (ch) => isChannelConfigured(ch),
      },
      callback: {
        orderService,
        auditWriter,
        rateLimiter,
        paymentFeatureEnabled: () => featureFlags.enabled('payment'),
        channelConfigured: (ch) => isChannelConfigured(ch),
      },
    });
  } else {
    // 只读订单路由仍注册（无资金面风险）；下单/回调随真网关一起关闭。
    await registerPaymentRoutes(app, {
      enabled: false,
      orders: {
        tokenService,
        getUser,
        getSessionActive,
        csrfService,
        consoleOrigin: config.consoleOrigin,
        rateLimiter,
        cursorService,
        orderService,
        paymentFeatureEnabled: () => featureFlags.enabled('payment'),
        channelConfigured: (ch) => isChannelConfigured(ch),
      },
      callback: {
        orderService,
        auditWriter,
        rateLimiter,
        paymentFeatureEnabled: () => featureFlags.enabled('payment'),
        channelConfigured: (ch) => isChannelConfigured(ch),
      },
    });
    app.log.warn('payment gateway disabled: order create + callback routes are not registered (P4 requires a real adapter)');
  }
  await app.register(invoiceRoutes, {
    tokenService,
    getUser,
    getSessionActive,
    csrfService,
    consoleOrigin: config.consoleOrigin,
    rateLimiter,
    idempotencyService,
    cursorService,
    invoiceService,
  });
  await registerConsoleStatic(app);

  await app.ready();
  await runMigrations(app.mysql as any, [...migrations], LEGACY_MIGRATION_VERSIONS);
  // 平台管理员受控引导（§2.3/§10.4）：PLATFORM_ADMIN_EMAILS 仅作首次引导来源；
  // 缺失时 fail-closed（无人被提升，requireAdmin 一律 403）。
  await bootstrapPlatformAdmins(userRepo, auditWriter, config.platformAdminEmails, app.log.warn.bind(app.log));

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
