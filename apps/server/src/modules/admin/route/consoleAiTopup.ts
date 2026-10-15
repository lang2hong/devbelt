import type { FastifyInstance, FastifyRequest } from 'fastify';
import { consoleSession, type GetAuthUser } from '../../../middleware/requireAuth.js';
import { registerConsoleErrorHandler, rejectConsole } from '../../../middleware/consoleError.js';
import { consoleWriteGuard } from '../../../middleware/consoleWrite.js';
import { validateIdempotencyKey, type IdempotencyService } from '../../../service/idempotencyService.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { CsrfService } from '../../../service/csrfService.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import type { AiTopupService } from '../../ai/service/aiTopupService.js';
import type { AiQuotaService } from '../../ai/service/aiQuotaService.js';
import type { AiTopupSku } from '../../ai/repository/aiTopupRepo.js';
import { ValidationError } from '../../../domain/errors.js';

/** 高危平台写回执保留 30 天（与 consoleAdmin 同规）。 */
const ADMIN_RETENTION_MS = 30 * 24 * 3600 * 1000;
/** 平台端点按调用者限流：查询 60/min、写 30/min（与 consoleAdmin 同规）。 */
const RATE_READ_WINDOW_S = 60;
const RATE_READ_MAX = 60;
const RATE_WRITE_WINDOW_S = 60;
const RATE_WRITE_MAX = 30;

export interface ConsoleAiTopupRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  csrfService: CsrfService;
  consoleOrigin: string;
  rateLimiter: RateLimitService;
  idempotencyService: IdempotencyService;
  topup: AiTopupService;
  quota: AiQuotaService;
  auditWriter: AuditWriter;
}

function userIdOf(req: FastifyRequest): number {
  return (req as unknown as { authUserId: number }).authUserId;
}
function sessionIdOf(req: FastifyRequest): string {
  return (req as unknown as { authSessionId?: string }).authSessionId ?? '';
}

function adminWriteKey(req: FastifyRequest): string {
  return validateIdempotencyKey(req.headers['idempotency-key']);
}

function requireReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (!reason) throw new ValidationError('reason is required');
  if (reason.length > 500) throw new ValidationError('reason too long');
  return reason;
}

function parsePositiveInt(raw: unknown, field: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError(`invalid ${field}`);
  return n;
}

function skuDto(s: AiTopupSku) {
  return {
    code: s.code,
    label: s.label,
    tokens: s.tokens,
    priceCents: s.priceCents,
    validDays: s.validDays,
    status: s.status,
    sortOrder: s.sortOrder,
  };
}

/**
 * 平台运营路由（P9.1b §十三）：AI 加油包 SKU 管理 / 手工建单（金额二次确认）/
 * 履行 / 退款 / 用户配额查询。全部 console-only + requireAdmin；写走
 * 「Origin 同源 + 会话绑定 CSRF + Idempotency-Key」回执事务，审计随业务同事务落库。
 */
export async function consoleAiTopupRoutes(app: FastifyInstance, opts: ConsoleAiTopupRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);
  const readLimit = (req: FastifyRequest) => opts.rateLimiter.hit(`console:admin:read:${userIdOf(req)}`, RATE_READ_WINDOW_S, RATE_READ_MAX);
  const writeLimitInTx = (tx: Queryable, req: FastifyRequest) =>
    opts.rateLimiter.hitInTx(tx, `console:admin:write:${userIdOf(req)}`, RATE_WRITE_WINDOW_S, RATE_WRITE_MAX);
  const audit = (
    tx: Queryable,
    eventType: 'admin.ai.topup.manual_created' | 'admin.ai.topup.fulfilled' | 'admin.ai.topup.refunded' | 'admin.ai.sku.updated',
    req: FastifyRequest,
    targetType: 'order' | 'sku',
    targetId: string,
    reason: string,
  ) =>
    opts.auditWriter.writeInTx(tx, {
      eventType,
      result: 'success',
      actorUserId: userIdOf(req),
      actorRole: 'platform_admin',
      targetType,
      targetId,
      reason,
    });

  await app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    requireAdmin: true,
    routes: async (child) => {
      // ── SKU 目录（含停用档；管理视图）──
      child.get('/api/admin/ai/skus', async (req, reply) => {
        await readLimit(req);
        opts.auditWriter.write({ eventType: 'admin.ai.skus.read', result: 'success', actorUserId: userIdOf(req), actorRole: 'platform_admin' });
        reply.send({ items: (await opts.topup.listAllSkus()).map(skuDto) });
      });

      // ── SKU 更新（改价/停启用/文案/有效期/排序；reason 必填）──
      child.patch('/api/admin/ai/skus/:code', { schema: { body: adminSkuUpdateBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const code = String((req.params as Record<string, unknown>).code);
        const body = req.body as {
          priceCents?: number;
          status?: 'active' | 'disabled';
          label?: { en: string; zh: string };
          validDays?: number;
          sortOrder?: number;
          reason: string;
        };
        const reason = requireReason(body.reason);
        if (body.priceCents !== undefined && (!Number.isSafeInteger(body.priceCents) || body.priceCents < 0)) {
          return rejectConsole(reply, 422, 'VALIDATION_FAILED', 'invalid priceCents');
        }
        if (body.validDays !== undefined && (!Number.isSafeInteger(body.validDays) || body.validDays < 1 || body.validDays > 3650)) {
          return rejectConsole(reply, 422, 'VALIDATION_FAILED', 'invalid validDays');
        }
        const result = await opts.idempotencyService.run({
          actorUserId: userIdOf(req),
          sessionId: sessionIdOf(req),
          method: 'PATCH',
          normalizedPath: `/api/admin/ai/skus/${code}`,
          idempotencyKey: adminWriteKey(req),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            const updated = await opts.topup.updateSkuInTx(tx, code, {
              priceCents: body.priceCents,
              status: body.status,
              label: body.label,
              validDays: body.validDays,
              sortOrder: body.sortOrder,
            });
            if (!updated) {
              return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'sku not found' } } };
            }
            audit(tx, 'admin.ai.sku.updated', req, 'sku', code, reason);
            const sku = await opts.topup.listAllSkus();
            const fresh = sku.find((s) => s.code === code);
            return { status: 200, body: { sku: fresh ? skuDto(fresh) : null } };
          },
        });
        reply.code(result.status).send(result.body);
      });

      // ── 手工建单（金额二次确认：expectedAmountCents 必须与当前价一致）──
      child.post('/api/admin/ai/topup-orders', { schema: { body: adminManualCreateBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const body = req.body as { userId: number; skuCode: string; expectedAmountCents: number; reason: string };
        const reason = requireReason(body.reason);
        const targetUserId = parsePositiveInt(body.userId, 'userId');
        const expectedAmountCents = parsePositiveInt(body.expectedAmountCents, 'expectedAmountCents');
        const result = await opts.idempotencyService.run({
          actorUserId: userIdOf(req),
          sessionId: sessionIdOf(req),
          method: 'POST',
          normalizedPath: '/api/admin/ai/topup-orders',
          idempotencyKey: adminWriteKey(req),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            const sku = await opts.topup.findSkuInTx(tx, body.skuCode);
            if (!sku || sku.status !== 'active') {
              return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'sku not found or disabled' } } };
            }
            if (sku.priceCents !== expectedAmountCents) {
              // 金额二次确认失败：价格在运营查看后已变化，拒绝并提示刷新（防旧价误发额度）。
              return {
                status: 422,
                body: { error: { code: 'AMOUNT_MISMATCH', message: 'current sku price differs from expectedAmountCents' } },
              };
            }
            const r = await opts.topup.createManualOrderInTx(tx, { userId: targetUserId, skuCode: body.skuCode });
            audit(tx, 'admin.ai.topup.manual_created', req, 'order', r.orderNo, reason);
            return { status: 201, body: { order: r } };
          },
        });
        reply.code(result.status).send(result.body);
      });

      // ── 履行（paid → fulfilled；重放幂等。渠道回调失败后的运营重试）──
      child.post('/api/admin/ai/topup-orders/:orderNo/fulfill', { schema: { body: adminActionBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const orderNo = String((req.params as Record<string, unknown>).orderNo);
        const reason = requireReason((req.body as { reason: string }).reason);
        const result = await opts.idempotencyService.run({
          actorUserId: userIdOf(req),
          sessionId: sessionIdOf(req),
          method: 'POST',
          normalizedPath: `/api/admin/ai/topup-orders/${orderNo}/fulfill`,
          idempotencyKey: adminWriteKey(req),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            const r = await opts.topup.fulfillInTx(tx, orderNo);
            audit(tx, 'admin.ai.topup.fulfilled', req, 'order', orderNo, reason);
            return { status: 200, body: { order: r } };
          },
        });
        reply.code(result.status).send(result.body);
      });

      // ── 退款（manual 语义：仅撤销额度，不发起渠道退款）──
      child.post('/api/admin/ai/topup-orders/:orderNo/refund', { schema: { body: adminActionBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const orderNo = String((req.params as Record<string, unknown>).orderNo);
        const reason = requireReason((req.body as { reason: string }).reason);
        const result = await opts.idempotencyService.run({
          actorUserId: userIdOf(req),
          sessionId: sessionIdOf(req),
          method: 'POST',
          normalizedPath: `/api/admin/ai/topup-orders/${orderNo}/refund`,
          idempotencyKey: adminWriteKey(req),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            const r = await opts.topup.refundInTx(tx, orderNo);
            audit(tx, 'admin.ai.topup.refunded', req, 'order', orderNo, reason);
            return { status: 200, body: { order: r } };
          },
        });
        reply.code(result.status).send(result.body);
      });

      // ── 用户配额查询（双段快照 + grants 明细）──
      child.get('/api/admin/ai/users/:userId/quota', { schema: { params: adminUserIdParam } }, async (req, reply) => {
        await readLimit(req);
        const targetUserId = Number((req.params as Record<string, unknown>).userId);
        opts.auditWriter.write({ eventType: 'admin.ai.quota.read', result: 'success', actorUserId: userIdOf(req), actorRole: 'platform_admin' });
        const snapshot = await opts.quota.getUsage(targetUserId);
        const grants = await opts.topup.listGrants(targetUserId);
        reply.send({
          snapshot,
          grants: grants.map((g) => ({
            grantId: g.id,
            orderId: g.orderId,
            skuCode: g.skuCode,
            status: g.status,
            tokensTotal: g.tokensTotal,
            tokensUsed: g.tokensUsed,
            tokensReserved: g.tokensReserved,
            expiresTime: g.expiresTime.toISOString(),
          })),
        });
      });
    },
  });
}

const adminUserIdParam = {
  type: 'object',
  required: ['userId'],
  additionalProperties: false,
  properties: { userId: { type: 'integer', minimum: 1 } },
} as const;

const adminSkuUpdateBody = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    priceCents: { type: 'integer', minimum: 0 },
    status: { type: 'string', enum: ['active', 'disabled'] },
    label: {
      type: 'object',
      required: ['en', 'zh'],
      additionalProperties: false,
      properties: { en: { type: 'string', minLength: 1, maxLength: 64 }, zh: { type: 'string', minLength: 1, maxLength: 64 } },
    },
    validDays: { type: 'integer', minimum: 1, maximum: 3650 },
    sortOrder: { type: 'integer', minimum: 0 },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const adminManualCreateBody = {
  type: 'object',
  required: ['userId', 'skuCode', 'expectedAmountCents', 'reason'],
  additionalProperties: false,
  properties: {
    userId: { type: 'integer', minimum: 1 },
    skuCode: { type: 'string', minLength: 1, maxLength: 32 },
    expectedAmountCents: { type: 'integer', minimum: 1 },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const adminActionBody = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
} as const;
