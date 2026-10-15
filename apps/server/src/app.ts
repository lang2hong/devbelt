import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import mysql from '@fastify/mysql';
import sensible from '@fastify/sensible';
import { createConnection } from 'mysql2/promise';
import { config, signingKeys } from './config.js';
import { resolveCorsOrigin } from './service/consoleOrigin.js';
import { buildMysqlPoolOptions } from './mysqlPool.js';
import { MysqlUserRepo } from './modules/auth/repository/userRepo.js';
import { MysqlEmailVerificationTokenRepo } from './modules/auth/repository/emailVerificationTokenRepo.js';
import { MysqlPersonalSubscriptionRepo } from './modules/billing/repository/personalSubscriptionRepo.js';
import { MysqlDeviceRepo } from './modules/db/repository/deviceRepo.js';
import { MysqlRefreshTokenRepo } from './modules/auth/repository/refreshTokenRepo.js';
import { MysqlRateLimitRepo } from './repository/mysql/rateLimitRepo.js';
import { MysqlRegistrationRepo } from './modules/auth/repository/registrationRepo.js';
import { MysqlPlanRepo, MysqlPlanFeatureDefRepo } from './modules/billing/repository/planRepo.js';
import { MysqlSyncStateRepo } from './modules/db/repository/syncStateRepo.js';
import { MysqlSyncRecordRepo } from './modules/db/repository/syncRecordRepo.js';
import { MysqlSyncMutationRepo } from './modules/db/repository/syncMutationRepo.js';
import { MysqlSyncNonceRepo } from './modules/db/repository/syncNonceRepo.js';
import { MysqlSyncResetTokenRepo } from './modules/db/repository/syncResetTokenRepo.js';
import { MysqlSyncResetHandoffRepo } from './modules/db/repository/syncResetHandoffRepo.js';
import { TokenService } from './service/tokenService.js';
import { AuthService } from './modules/auth/service/authService.js';
import { SyncStateService } from './modules/db/service/syncStateService.js';
import { SyncRecordService } from './modules/db/service/syncRecordService.js';
import { SyncResetService } from './modules/db/service/syncResetService.js';
import { RateLimitService } from './service/rateLimitService.js';
import { startRateLimitCleanup } from './service/rateLimitCleanup.js';
import { startNonceCleanup } from './service/nonceCleanup.js';
import { startRetentionCleanup } from './service/retentionCleanup.js';
import { resolveEmailSender } from './modules/auth/service/resolveEmailSender.js';
import { authRoutes } from './modules/auth/route/auth.js';
import { meRoutes } from './modules/db/route/me.js';
import { plansRoutes, consolePlansRoutes } from './modules/billing/route/plans.js';
import { buildPlanCatalog, type FeatureDto, type PlanCatalog, type PlanDto } from './modules/billing/service/planCatalog.js';
import type { HomePlan } from './home.js';
import { personalRoutes } from './modules/db/route/personal.js';
import { syncRoutes } from './modules/db/route/sync.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { securityHeaders, globalSecurityHeaders } from './middleware/securityHeaders.js';
import { buildLoggerOptions } from './middleware/requestLogging.js';
import { runMigrations } from './repository/mysql/migrate.js';
import { migrations, LEGACY_MIGRATION_VERSIONS } from './repository/mysql/migrations/index.js';
import { mysqlTimeZoneInit } from './repository/mysql/mysqlTimeZoneInit.js';
import { withTransaction } from './repository/mysql/db.js';
import { registerHealthRoutes } from './route/health.js';
import { MetricsRegistry, attachRequestMetrics } from './service/metrics.js';
import { MysqlMailFlowRepo } from './modules/auth/repository/mailFlowRepo.js';
import { MysqlAuditRepo } from './modules/auth/repository/auditRepo.js';
import { MysqlIdempotencyReceiptRepo } from './repository/mysql/idempotencyReceiptRepo.js';
import { MysqlOrderRepo } from './modules/billing/repository/orderRepo.js';
import { MysqlPaymentRepo } from './modules/billing/repository/paymentRepo.js';
import { MysqlPaymentCallbackNonceRepo } from './modules/billing/repository/paymentCallbackNonceRepo.js';
import { LinkFlowService } from './modules/auth/service/linkFlowService.js';
import { AuditWriter } from './service/auditWriter.js';
import { bootstrapPlatformAdmins } from './modules/auth/service/platformAdminBootstrap.js';
import { IdempotencyService } from './service/idempotencyService.js';
import { CsrfService, deriveCsrfKey } from './service/csrfService.js';
import { linkFlowRoutes } from './modules/auth/route/linkFlows.js';
import { consoleLinkFlowRoutes } from './modules/auth/route/consoleLinkFlows.js';
import { consoleAuthRoutes } from './modules/auth/route/consoleAuth.js';
import { consoleMeRoutes } from './modules/auth/route/consoleMe.js';
import { consoleDataRoutes } from './modules/db/route/consoleData.js';
import { consoleAdminRoutes } from './modules/admin/route/consoleAdmin.js';
import { consoleAiTopupRoutes } from './modules/admin/route/consoleAiTopup.js';
import { aiTopupOrderRoutes } from './modules/ai/route/topup.js';
import { registerPaymentRoutes } from './modules/billing/route/paymentRoutes.js';
import { invoiceRoutes } from './modules/billing/route/invoices.js';
import { InvoiceService } from './modules/billing/service/invoiceService.js';
import { MysqlInvoiceRepo } from './modules/billing/repository/invoiceRepo.js';
import { ConsoleAuthService } from './modules/auth/service/consoleAuthService.js';
import { ConsoleAdminService } from './modules/admin/service/consoleAdminService.js';
import { OrderService } from './modules/billing/service/paymentService.js';
import { resolvePaymentGateway, paymentRoutesEnabled, isChannelConfigured } from './modules/billing/service/paymentChannel.js';
import { resolveFeatureFlags } from './service/featureFlags.js';
import { CursorService, deriveCursorKey } from './service/cursor.js';
import { requestId } from './middleware/requestId.js';
import { readCookie, refreshCookieName } from './middleware/cookies.js';
import { registerConsoleStatic } from './consoleStatic.js';
import { resolveAiUpstreamConfig } from './modules/ai/aiConfig.js';
import { MysqlAiUsageRepo } from './modules/ai/repository/aiUsageRepo.js';
import { AiQuotaService } from './modules/ai/service/aiQuotaService.js';
import { MysqlAiTopupRepo } from './modules/ai/repository/aiTopupRepo.js';
import { AiTopupService } from './modules/ai/service/aiTopupService.js';
import { AiProxyService } from './modules/ai/service/aiProxyService.js';
import { aiRoutes } from './modules/ai/module.js';

/**
 * 组合根（composition root）：组装 Fastify 实例 + 依赖注入。
 *
 * 依赖链：route -> service -> repository(interface) <- mysql 实现。
 *
 * EmailSender 按 SMTP_* 环境变量选择（生产 SMTP / 开发 log）。
 */
/** 首页套餐卡片展示的特性 key（按此顺序取前若干项）。 */
const HOME_PLAN_FEATURE_KEYS: readonly string[] = [
  'allowedDatabaseTypes',
  'maxSavedConnections',
  'maxDevices',
  'syncStorageBytes',
  'allowDataSync',
  'allowConnectionImport',
];

function humanBytes(bytes: number): string {
  if (bytes <= 0) return '不限';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function formatFeature(f: FeatureDto): string {
  const label = f.label?.zh ?? f.key;
  if (typeof f.value === 'boolean') return f.value ? label : `不含${label}`;
  if (Array.isArray(f.value)) return `${label}：${f.value.join(' / ')}`;
  if (typeof f.value === 'number') {
    if (f.type === 'bytes') return `${label}：${humanBytes(f.value)}`;
    return `${label}：${f.value === 0 ? '不限' : f.value}`;
  }
  return `${label}：${String(f.value)}`;
}

function toHomePlan(dto: PlanDto, kind: HomePlan['kind']): HomePlan {
  const byKey = new Map(dto.features.map((f) => [f.key, f]));
  const highlights = HOME_PLAN_FEATURE_KEYS.flatMap((key) => {
    const f = byKey.get(key);
    return f ? [formatFeature(f)] : [];
  }).slice(0, 5);
  return {
    code: dto.code,
    name: dto.name,
    kind,
    priceCents: dto.billing.priceCents,
    unit: dto.billing.unit,
    highlights,
  };
}

/** 组合根适配：billing 套餐目录 → 首页展示模型（home.ts 不依赖 modules）。 */
function toHomePlans(catalog: PlanCatalog): HomePlan[] {
  return catalog.personal.map((p) => toHomePlan(p, 'personal'));
}

export async function createApp() {
  const app = Fastify({
    // 自定义 req 序列化器：URL 里的一次性链接 token 不得进日志（§8）。
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
    featureDefRepo,
    personalSubscriptionRepo,
    auditRepo,
    orderRepo,
    invoiceRepo,
    auditWriter,
    syncStateRepo,
    syncRecordService,
    rateLimiter,
  });
  const cursorService = new CursorService(deriveCursorKey());

  const invoiceService = new InvoiceService({ invoiceRepo, orderRepo, auditWriter });

  // AI 服务端代理（P9 §6.8）：双段配额（月额度 ai_token_usage + 加油包 grants FIFO，P9.1）+ parse-and-forward。
  const aiUsageRepo = new MysqlAiUsageRepo(getMysql);
  const aiTopupRepo = new MysqlAiTopupRepo(getMysql);
  const aiQuotaService = new AiQuotaService(
    aiUsageRepo,
    aiTopupRepo,
    personalSubscriptionRepo,
    planRepo,
    (fn) => withTransaction(app.mysql, fn),
  );
  const aiTopupService = new AiTopupService(aiTopupRepo, (fn) => withTransaction(app.mysql, fn));
  const aiUpstreamConfig = resolveAiUpstreamConfig(process.env);
  if (!aiUpstreamConfig.configured) {
    app.log.warn(
      'AI upstream is not configured: /api/ai/chat will return 503 ' +
        '(set DEVBELT_AI_UPSTREAM_BASE_URL / DEVBELT_AI_UPSTREAM_MODEL)',
    );
  }
  const aiProxyService = new AiProxyService({
    config: aiUpstreamConfig,
    quota: aiQuotaService,
    audit: auditWriter,
    log: (msg, data) => app.log.warn({ data }, msg),
  });

  const orderService = new OrderService({
    orderRepo,
    paymentRepo,
    planRepo,
    personalSubscriptionRepo,
    auditWriter,
    runner: (fn) => withTransaction(app.mysql, fn),
    gatewayFor: (channel) => resolvePaymentGateway(channel),
    nonceRepo: paymentNonceRepo,
    // P9.1c：回调按 purpose 分发——topup 订单履约走加油包入账（grants + fulfilled 同事务）。
    fulfillTopupInTx: async (tx, orderNo) => {
      await aiTopupService.fulfillInTx(tx, orderNo);
    },
  });
  const featureFlags = resolveFeatureFlags();
  // opt-in：凭据齐全 + 显式 DEVBELT_DB_FEATURE_PAYMENT=true 才注册真支付路由，否则仅注册只读订单路由。
  const paymentEnabled = paymentRoutesEnabled();

  // 受控限流清理任务（实施规格 §3）：过期桶由周期任务删除，不依赖请求
  // 过期数据保留清理（refresh_tokens / email_verification_tokens /
  // personal_sync_mutations / personal_sync_reset_tokens 等表原本只增不减）。
  // 返回 { stop }：绑定到 app.close()，避免测试/嵌入式多实例里定时器持续打已关闭的池。
  const cleanupHandles = [
    startRateLimitCleanup(rateLimitRepo),
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
  app.register(aiRoutes, {
    tokenService,
    getUser,
    getSessionActive,
    rateLimiter,
    proxy: aiProxyService,
    quota: aiQuotaService,
    topup: aiTopupService,
  });
  app.register(personalRoutes, { tokenService, getUser, getSessionActive, auditWriter, csrfService, consoleOrigin: config.consoleOrigin, deviceRepo, idempotencyService, revokeDevice: (userId, deviceId) => authService.revokeDevice(userId, deviceId), revokeDeviceInTx: (tx, userId, deviceId) => authService.revokeDeviceInTx(tx, userId, deviceId) });
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
    syncStateRepo,
    syncRecordRepo,
    syncState: syncStateService,
    syncRecordService,
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
    planRepo,
    serverVersion: '1.0.0',
    consoleApiVersion: '1',
  });
  // P9.1c：用户侧加油包下单（console + CSRF，复用 P4 收银台；支付开关 fail-closed 503）。
  app.register(aiTopupOrderRoutes, {
    tokenService,
    getUser,
    getSessionActive,
    csrfService,
    consoleOrigin: config.consoleOrigin,
    rateLimiter,
    topup: aiTopupService,
    auditWriter,
    paymentFeatureEnabled: () => featureFlags.enabled('payment'),
    channelConfigured: (ch) => isChannelConfigured(ch),
    gatewayFor: (ch) => resolvePaymentGateway(ch),
    exec: getMysql(),
  });
  // P9.1b：AI 加油包运营（SKU 管理/手工建单/履行/退款/配额查询）。
  app.register(consoleAiTopupRoutes, {
    tokenService,
    getUser,
    getSessionActive,
    csrfService,
    consoleOrigin: config.consoleOrigin,
    rateLimiter,
    idempotencyService,
    topup: aiTopupService,
    quota: aiQuotaService,
    auditWriter,
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
  await registerConsoleStatic(app, {
    getHomePlans: async () => toHomePlans(await buildPlanCatalog(planRepo, featureDefRepo)),
    // 首页登录态：仅当带 refresh cookie 时按 token-hash 查一次（已撤销/过期 fail-closed）。
    isLoggedIn: async (req) => {
      const raw = readCookie(req, refreshCookieName());
      if (!raw) return false;
      try {
        return (await consoleAuthService.sessionIdOf(raw)) !== undefined;
      } catch {
        return false;
      }
    },
  });

  await app.ready();
  await runMigrations(app.mysql as any, [...migrations], LEGACY_MIGRATION_VERSIONS);
  // 平台管理员受控引导（§2.3/§10.4）：DEVBELT_DB_PLATFORM_ADMIN_EMAILS 仅作首次引导来源；
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
