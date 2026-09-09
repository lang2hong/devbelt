import type { FastifyInstance, FastifyRequest } from 'fastify';
import { consoleSession, type GetAuthUser } from '../middleware/requireAuth.js';
import { registerConsoleErrorHandler, rejectConsole } from '../middleware/consoleError.js';
import { consoleWriteGuard } from '../middleware/consoleWrite.js';
import { validateIdempotencyKey, type IdempotencyService } from '../service/idempotencyService.js';
import { ConsoleAdminService } from '../service/consoleAdminService.js';
import type { CursorService } from '../service/cursor.js';
import type { TokenService } from '../service/tokenService.js';
import type { CsrfService } from '../service/csrfService.js';
import type { RateLimitService } from '../service/rateLimitService.js';
import type { Queryable } from '../repository/mysql/db.js';
import type { AdminUserRow, AdminOrgRow, AuditFilter } from '../repository/interfaces.js';
import { ValidationError } from '../domain/errors.js';
import { auditDto } from '../service/auditSerialize.js';
import { organizationIdParam } from './schemas.js';

/** 高危平台写回执保留 30 天（§6.1）。 */
const ADMIN_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** 平台端点按调用者限流（§6）：查询 60/min、写 30/min、导出 10/h。 */
const RATE_READ_WINDOW_S = 60;
const RATE_READ_MAX = 60;
const RATE_WRITE_WINDOW_S = 60;
const RATE_WRITE_MAX = 30;
const RATE_EXPORT_WINDOW_S = 3600;
const RATE_EXPORT_MAX = 10;

export interface ConsoleAdminRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  csrfService: CsrfService;
  consoleOrigin: string;
  rateLimiter: RateLimitService;
  idempotencyService: IdempotencyService;
  adminService: ConsoleAdminService;
  cursorService: CursorService;
  serverVersion: string;
  consoleApiVersion: string;
}

function userIdOf(req: FastifyRequest): number {
  return (req as unknown as { authUserId: number }).authUserId;
}
function sessionIdOf(req: FastifyRequest): string {
  return (req as unknown as { authSessionId?: string }).authSessionId ?? '';
}

/** 平台写：Origin 同源 + 会话绑定 CSRF + Idempotency-Key（validate 缺失即抛 validation）。 */
function adminWriteKey(req: FastifyRequest): string {
  return validateIdempotencyKey(req.headers['idempotency-key']);
}

function parseCursor(cursorService: CursorService, raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return null;
  const decoded = cursorService.decode(raw);
  if (decoded === null) return null;
  const n = Number(decoded);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : 50;
  if (!Number.isInteger(n) || n <= 0) return 50;
  return Math.min(n, 100);
}

function parseDate(raw: unknown): Date | undefined {
  if (raw === undefined || raw === '' || raw === null) return undefined;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw new ValidationError('invalid date');
  return d;
}

function iso(v: Date | null): string | null {
  return v ? v.toISOString() : null;
}

function userDto(r: AdminUserRow) {
  return {
    userId: String(r.userId),
    email: r.email,
    emailVerified: !!r.emailVerifiedTime,
    displayName: r.displayName ?? null,
    status: r.status,
    role: r.role,
    lastLoginTime: iso(r.lastLoginTime),
    planCode: r.planCode,
    deviceCount: r.deviceCount,
    subscriptionVersion: r.subscriptionVersion,
    periodEndTime: iso(r.periodEndTime),
    createTime: r.createTime.toISOString(),
  };
}

function orgDto(r: AdminOrgRow) {
  return {
    organizationId: String(r.organizationId),
    name: r.name,
    status: r.status,
    planCode: r.planCode,
    seatLimit: r.seatLimit,
    activeMemberCount: r.activeMemberCount,
    invitedCount: r.invitedCount,
    subscriptionVersion: r.subscriptionVersion,
    periodEndTime: iso(r.periodEndTime),
    createTime: r.createTime.toISOString(),
  };
}

/** 平台运营路由（P3 §6，切片 4）。全部 console-only + requireAdmin。 */
export async function consoleAdminRoutes(app: FastifyInstance, opts: ConsoleAdminRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);
  const svc = opts.adminService;
  const readLimit = (req: FastifyRequest) => opts.rateLimiter.hit(`console:admin:read:${userIdOf(req)}`, RATE_READ_WINDOW_S, RATE_READ_MAX);
  // 写/导出的限流必须落在幂等回执事务内（beforeWrite + hitInTx），使已完成回执优先于限流；
  // 与组织创建的 throttleCreateOrganizationInTx 同构，避免已完成请求因限流被提前 429 而无法重放。
  const writeLimitInTx = (tx: Queryable, req: FastifyRequest) => opts.rateLimiter.hitInTx(tx, `console:admin:write:${userIdOf(req)}`, RATE_WRITE_WINDOW_S, RATE_WRITE_MAX);
  const exportLimitInTx = (tx: Queryable, req: FastifyRequest) => opts.rateLimiter.hitInTx(tx, `console:admin:export:${userIdOf(req)}`, RATE_EXPORT_WINDOW_S, RATE_EXPORT_MAX);

  await app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    requireAdmin: true,
    routes: async (child) => {
      // ── 用户 ──
      child.get('/api/console/admin/users', async (req, reply) => {
        await readLimit(req);
        const q = req.query as Record<string, unknown>;
        const cursor = parseCursor(opts.cursorService, q.cursor);
        if (q.cursor !== undefined && q.cursor !== '' && cursor === null) {
          return rejectConsole(reply, 422, 'INVALID_CURSOR', 'invalid cursor');
        }
        const page = await svc.listUsers(userIdOf(req), {
          emailExact: q.emailExact ? String(q.emailExact) : undefined,
          userId: q.userId ? Number(q.userId) : undefined,
          status: q.status === 'active' || q.status === 'disabled' ? q.status : undefined,
          planCode: q.planCode ? String(q.planCode) : undefined,
          createdFrom: parseDate(q.createdFrom),
          createdTo: parseDate(q.createdTo),
          cursor: cursor ?? undefined,
          limit: parseLimit(q.limit),
        });
        reply.send({
          items: page.items.map(userDto),
          nextCursor: page.nextId != null ? opts.cursorService.encode(String(page.nextId)) : null,
        });
      });

      child.patch('/api/console/admin/users/:userId/status', { schema: { params: adminUserIdParam, body: adminUserStatusBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const actor = userIdOf(req);
        const target = Number((req.params as Record<string, unknown>).userId);
        const { status, reason } = req.body as { status: 'active' | 'disabled'; reason: string };
        const result = await opts.idempotencyService.run({
          actorUserId: actor,
          sessionId: sessionIdOf(req),
          method: 'PATCH',
          normalizedPath: `/api/console/admin/users/${target}/status`,
          idempotencyKey: adminWriteKey(req),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            const r = await svc.setUserStatusInTx(tx, actor, target, status, reason);
            return { status: 200, body: { user: r } };
          },
        });
        reply.code(result.status).send(result.body);
      });

      child.patch('/api/console/admin/users/:userId/subscription', { schema: { params: adminUserIdParam, body: adminUserSubscriptionBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const actor = userIdOf(req);
        const target = Number((req.params as Record<string, unknown>).userId);
        const { planCode, periodEndTime, reason, expectedVersion } = req.body as { planCode: string; periodEndTime: string | null; reason: string; expectedVersion: number };
        const periodEnd = periodEndTime ? parseDate(periodEndTime) ?? null : null;
        const result = await opts.idempotencyService.run({
          actorUserId: actor,
          sessionId: sessionIdOf(req),
          method: 'PATCH',
          normalizedPath: `/api/console/admin/users/${target}/subscription`,
          idempotencyKey: adminWriteKey(req),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            // 套餐解析放入 business：已完成回执优先于可变套餐状态（套餐停用后重放仍可返回首次结果，§6.1）。
            const plan = await svc.resolvePersonalPlanInTx(tx, planCode);
            const snapshot = svc.personalEntitlementSnapshot(plan);
            const r = await svc.adjustUserSubscriptionInTx(tx, actor, target, { planId: plan.id, snapshot, periodEndTime: periodEnd, reason, expectedVersion });
            return { status: 200, body: r };
          },
        });
        reply.code(result.status).send(result.body);
      });

      // ── 组织 ──
      child.get('/api/console/admin/organizations', async (req, reply) => {
        await readLimit(req);
        const q = req.query as Record<string, unknown>;
        const cursor = parseCursor(opts.cursorService, q.cursor);
        if (q.cursor !== undefined && q.cursor !== '' && cursor === null) {
          return rejectConsole(reply, 422, 'INVALID_CURSOR', 'invalid cursor');
        }
        const page = await svc.listOrganizations(userIdOf(req), {
          namePrefix: q.namePrefix ? String(q.namePrefix) : undefined,
          status: q.status === 'active' || q.status === 'closed' ? q.status : undefined,
          planCode: q.planCode ? String(q.planCode) : undefined,
          cursor: cursor ?? undefined,
          limit: parseLimit(q.limit),
        });
        reply.send({
          items: page.items.map(orgDto),
          nextCursor: page.nextId != null ? opts.cursorService.encode(String(page.nextId)) : null,
        });
      });

      child.patch('/api/console/admin/organizations/:organizationId/subscription', { schema: { params: organizationIdParam, body: adminOrganizationSubscriptionBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const actor = userIdOf(req);
        const organizationId = Number((req.params as Record<string, unknown>).organizationId);
        const { planCode, seatLimit, periodEndTime, reason, expectedVersion } = req.body as { planCode: string; seatLimit: number; periodEndTime: string | null; reason: string; expectedVersion: number };
        const periodEnd = periodEndTime ? parseDate(periodEndTime) ?? null : null;
        const result = await opts.idempotencyService.run({
          actorUserId: actor,
          sessionId: sessionIdOf(req),
          method: 'PATCH',
          normalizedPath: `/api/console/admin/organizations/${organizationId}/subscription`,
          idempotencyKey: adminWriteKey(req),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            // 套餐解析放入 business：已完成回执优先于可变套餐状态（§6.1）。
            const plan = await svc.resolveOrganizationPlanInTx(tx, planCode);
            const snapshot = {
              includedSeats: plan.includedSeats,
              maxSharedResources: plan.maxSharedResources,
              sharedStorageQuotaBytes: plan.sharedStorageQuotaBytes,
              allowedTemplateDatabaseTypes: plan.allowedTemplateDatabaseTypes,
            };
            const r = await svc.adjustOrganizationSubscriptionInTx(tx, actor, organizationId, { planId: plan.id, seatLimit, snapshot, periodEndTime: periodEnd, reason, expectedVersion });
            return { status: 200, body: r };
          },
        });
        reply.code(result.status).send(result.body);
      });

      // ── 审计 ──
      child.get('/api/console/admin/audit', async (req, reply) => {
        await readLimit(req);
        const q = req.query as Record<string, unknown>;
        const cursor = parseCursor(opts.cursorService, q.cursor);
        if (q.cursor !== undefined && q.cursor !== '' && cursor === null) {
          return rejectConsole(reply, 422, 'INVALID_CURSOR', 'invalid cursor');
        }
        const filter: AuditFilter = {
          fromTime: parseDate(q.fromTime),
          toTime: parseDate(q.toTime),
          actorUserId: q.actorUserId ? Number(q.actorUserId) : undefined,
          eventType: q.eventType ? String(q.eventType) : undefined,
          targetType: q.targetType ? String(q.targetType) : undefined,
          organizationId: q.organizationId ? Number(q.organizationId) : undefined,
          cursor: cursor ?? undefined,
          limit: parseLimit(q.limit),
        };
        const page = await svc.queryAudit(userIdOf(req), filter);
        reply.send({
          items: page.items.map(auditDto),
          nextCursor: page.nextId != null ? opts.cursorService.encode(String(page.nextId)) : null,
        });
      });

      child.post('/api/console/admin/audit/exports', { schema: { body: adminAuditExportBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const { format, filters, expectedCountUpperBound } = req.body as {
          format: 'csv' | 'json';
          filters: { fromTime?: string; toTime?: string; actorUserId?: number; eventType?: string; targetType?: string; organizationId?: number };
          expectedCountUpperBound?: number;
        };
        if (expectedCountUpperBound && expectedCountUpperBound > 10_000) {
          return rejectConsole(reply, 422, 'EXPORT_TOO_LARGE', 'export exceeds the maximum allowed rows');
        }
        const actor = userIdOf(req);
        const exportFilters = {
          fromTime: parseDate(filters?.fromTime),
          toTime: parseDate(filters?.toTime),
          actorUserId: filters?.actorUserId,
          eventType: filters?.eventType,
          targetType: filters?.targetType,
          organizationId: filters?.organizationId,
        };
        // 导出按 §6 需 Idempotency-Key 且纳入幂等回执：beforeWrite 事务内限流 + business 内
        // 读取/渲染/审计写同事务，同键同摘要重放返回首次文件，不重复读/审计/不重复耗限流额度。
        const result = await opts.idempotencyService.run({
          actorUserId: actor,
          sessionId: sessionIdOf(req),
          method: 'POST',
          normalizedPath: '/api/console/admin/audit/exports',
          idempotencyKey: adminWriteKey(req),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => exportLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            const r = await svc.exportAuditInTx(tx, actor, exportFilters, format);
            return { status: 200, body: r };
          },
        });
        const body = result.body as { content: string; filename: string; contentType: string };
        reply.header('Content-Type', body.contentType);
        reply.header('Content-Disposition', `attachment; filename="${body.filename}"`);
        reply.code(result.status).send(body.content);
      });
    },
  });

  // 版本（仅平台管理员）
  await app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    requireAdmin: true,
    routes: async (child) => {
      child.get('/api/console/version', async (req, reply) => {
        await opts.rateLimiter.hit(`console:admin:read:${userIdOf(req)}`, RATE_READ_WINDOW_S, RATE_READ_MAX);
        reply.header('Cache-Control', 'no-store');
        reply.send({
          consoleApiVersion: opts.consoleApiVersion,
          serverVersion: opts.serverVersion,
          consoleBuildId: null,
          buildTime: null,
        });
      });
    },
  });
}

const adminUserIdParam = {
  type: 'object',
  required: ['userId'],
  additionalProperties: false,
  properties: { userId: { type: 'string', pattern: '^[0-9]+$' } },
} as const;

const adminUserStatusBody = {
  type: 'object',
  required: ['status', 'reason'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['active', 'disabled'] },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const adminUserSubscriptionBody = {
  type: 'object',
  required: ['planCode', 'reason', 'expectedVersion'],
  additionalProperties: false,
  properties: {
    planCode: { type: 'string', minLength: 1, maxLength: 32 },
    periodEndTime: { type: 'string', format: 'date-time' },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    expectedVersion: { type: 'integer', minimum: 0 },
  },
} as const;

const adminOrganizationSubscriptionBody = {
  type: 'object',
  required: ['planCode', 'seatLimit', 'reason', 'expectedVersion'],
  additionalProperties: false,
  properties: {
    planCode: { type: 'string', minLength: 1, maxLength: 32 },
    seatLimit: { type: 'integer', minimum: 1, maximum: 100000 },
    periodEndTime: { type: 'string', format: 'date-time' },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    expectedVersion: { type: 'integer', minimum: 0 },
  },
} as const;

const adminAuditExportBody = {
  type: 'object',
  required: ['format', 'filters'],
  additionalProperties: false,
  properties: {
    format: { type: 'string', enum: ['csv', 'json'] },
    expectedCountUpperBound: { type: 'integer', minimum: 0 },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fromTime: { type: 'string', format: 'date-time' },
        toTime: { type: 'string', format: 'date-time' },
        actorUserId: { type: 'integer' },
        eventType: { type: 'string' },
        targetType: { type: 'string' },
        organizationId: { type: 'integer' },
      },
    },
  },
} as const;