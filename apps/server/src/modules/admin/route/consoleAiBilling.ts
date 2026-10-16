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
import type { AiBillingService } from '../../ai/service/aiBillingService.js';
import type { AiModelPricing } from '../../ai/repository/aiBillingRepo.js';
import { ValidationError } from '../../../domain/errors.js';

const ADMIN_RETENTION_MS = 30 * 24 * 3600 * 1000;
const RATE_READ_WINDOW_S = 60;
const RATE_READ_MAX = 60;
const RATE_WRITE_WINDOW_S = 60;
const RATE_WRITE_MAX = 30;

export interface ConsoleAiBillingRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  csrfService: CsrfService;
  consoleOrigin: string;
  rateLimiter: RateLimitService;
  idempotencyService: IdempotencyService;
  billing: AiBillingService;
  auditWriter: AuditWriter;
}

function userIdOf(req: FastifyRequest): number {
  return (req as unknown as { authUserId: number }).authUserId;
}
function sessionIdOf(req: FastifyRequest): string {
  return (req as unknown as { authSessionId?: string }).authSessionId ?? '';
}
function requireReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (!reason) throw new ValidationError('reason is required');
  if (reason.length > 500) throw new ValidationError('reason too long');
  return reason;
}

function pricingDto(p: AiModelPricing) {
  return {
    model: p.model,
    providerCode: p.providerCode,
    inputCentsPerM: p.inputCentsPerM,
    outputCentsPerM: p.outputCentsPerM,
    weightOverride: p.weightOverride,
    status: p.status,
  };
}

const pricingBody = {
  type: 'object',
  required: ['model', 'reason'],
  additionalProperties: false,
  properties: {
    model: { type: 'string', minLength: 1, maxLength: 128 },
    providerCode: { type: 'string', maxLength: 32 },
    inputCentsPerM: { type: 'integer', minimum: 0, maximum: 1000000 },
    outputCentsPerM: { type: 'integer', minimum: 0, maximum: 1000000 },
    weightOverride: { type: ['number', 'null'], minimum: 0.01, maximum: 100 },
    status: { type: 'string', enum: ['active', 'disabled'] },
    reason: { type: 'string', maxLength: 500 },
  },
};
const pricingPatchBody = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    providerCode: { type: ['string', 'null'], maxLength: 32 },
    inputCentsPerM: { type: 'integer', minimum: 0, maximum: 1000000 },
    outputCentsPerM: { type: 'integer', minimum: 0, maximum: 1000000 },
    weightOverride: { type: ['number', 'null'], minimum: 0.01, maximum: 100 },
    status: { type: 'string', enum: ['active', 'disabled'] },
    reason: { type: 'string', maxLength: 500 },
  },
};
const settingsBody = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    activeModel: { type: ['string', 'null'], maxLength: 128 },
    upstreamBaseUrl: { type: ['string', 'null'], maxLength: 255 },
    /** 只写不读：任何 GET 不回明文（仅 configured + 尾号提示）。 */
    upstreamApiKey: { type: 'string', maxLength: 512 },
    clearUpstreamApiKey: { type: 'boolean' },
    globalMultiplier: { type: 'number', minimum: 0.01, maximum: 100 },
    reason: { type: 'string', maxLength: 500 },
  },
};

/**
 * 平台运营路由：AI 计费引擎（模型计价表 / 计费设置 / 财务月报）。
 * console-only + requireAdmin；写走「Origin 同源 + 会话绑定 CSRF + Idempotency-Key」
 * 回执事务，审计随业务同事务落库，reason 必填；**密钥值不进审计**。
 */
export async function consoleAiBillingRoutes(app: FastifyInstance, opts: ConsoleAiBillingRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);
  const readLimit = (req: FastifyRequest) => opts.rateLimiter.hit(`console:admin:read:${userIdOf(req)}`, RATE_READ_WINDOW_S, RATE_READ_MAX);
  const writeLimitInTx = (tx: Queryable, req: FastifyRequest) =>
    opts.rateLimiter.hitInTx(tx, `console:admin:write:${userIdOf(req)}`, RATE_WRITE_WINDOW_S, RATE_WRITE_MAX);
  const audit = (tx: Queryable, eventType: 'admin.ai.model_pricing.created' | 'admin.ai.model_pricing.updated' | 'admin.ai.billing_settings.updated', req: FastifyRequest, targetId: string, reason: string) =>
    opts.auditWriter.writeInTx(tx, {
      eventType,
      result: 'success',
      actorUserId: userIdOf(req),
      actorRole: 'platform_admin',
      targetType: 'ai_billing',
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
      // ── 生效配置视图（含 env 回退对照；不含 Key 明文）──
      child.get('/api/admin/ai/billing-settings', async (req, reply) => {
        await readLimit(req);
        opts.auditWriter.write({ eventType: 'admin.ai.billing.read', result: 'success', actorUserId: userIdOf(req), actorRole: 'platform_admin' });
        reply.send(await opts.billing.settingsView());
      });

      // ── 计费设置（激活模型/上游连接/系数；reason 必填；写后即时生效）──
      child.patch('/api/admin/ai/billing-settings', { schema: { body: settingsBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const body = req.body as Record<string, unknown>;
        const reason = requireReason(body.reason);
        const result = await opts.idempotencyService.run({
          actorUserId: userIdOf(req),
          sessionId: sessionIdOf(req),
          method: 'PATCH',
          normalizedPath: '/api/admin/ai/billing-settings',
          idempotencyKey: validateIdempotencyKey(req.headers['idempotency-key']),
          requestBody: { ...body, upstreamApiKey: body.upstreamApiKey ? '(redacted)' : body.upstreamApiKey },
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            await opts.billing.updateSettingsInTx(tx, body);
            audit(tx, 'admin.ai.billing_settings.updated', req, 'settings', reason);
            return { status: 200, body: await opts.billing.settingsView() };
          },
        });
        reply.code(result.status).send(result.body);
      });

      // ── 计价表（全量含停用）──
      child.get('/api/admin/ai/model-pricing', async (req, reply) => {
        await readLimit(req);
        opts.auditWriter.write({ eventType: 'admin.ai.billing.read', result: 'success', actorUserId: userIdOf(req), actorRole: 'platform_admin' });
        reply.send({ items: (await opts.billing.listPricingAll()).map(pricingDto) });
      });

      child.post('/api/admin/ai/model-pricing', { schema: { body: pricingBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const body = req.body as Record<string, unknown>;
        const reason = requireReason(body.reason);
        const result = await opts.idempotencyService.run({
          actorUserId: userIdOf(req),
          sessionId: sessionIdOf(req),
          method: 'POST',
          normalizedPath: '/api/admin/ai/model-pricing',
          idempotencyKey: validateIdempotencyKey(req.headers['idempotency-key']),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            const created = await opts.billing.createPricingInTx(tx, { model: body.model, providerCode: body.providerCode, inputCentsPerM: body.inputCentsPerM, outputCentsPerM: body.outputCentsPerM, weightOverride: body.weightOverride });
            if (!created) return { status: 409, body: { error: { code: 'CONFLICT', message: 'model pricing already exists' } } };
            audit(tx, 'admin.ai.model_pricing.created', req, created.model, reason);
            return { status: 201, body: { pricing: pricingDto(created) } };
          },
        });
        reply.code(result.status).send(result.body);
      });

      child.patch('/api/admin/ai/model-pricing/:model', { schema: { body: pricingPatchBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const model = String((req.params as Record<string, unknown>).model);
        const body = req.body as Record<string, unknown>;
        const reason = requireReason(body.reason);
        const result = await opts.idempotencyService.run({
          actorUserId: userIdOf(req),
          sessionId: sessionIdOf(req),
          method: 'PATCH',
          normalizedPath: `/api/admin/ai/model-pricing/${encodeURIComponent(model)}`,
          idempotencyKey: validateIdempotencyKey(req.headers['idempotency-key']),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            const updated = await opts.billing.updatePricingInTx(tx, model, { providerCode: body.providerCode, inputCentsPerM: body.inputCentsPerM, outputCentsPerM: body.outputCentsPerM, weightOverride: body.weightOverride, status: body.status });
            if (!updated) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'model pricing not found' } } };
            audit(tx, 'admin.ai.model_pricing.updated', req, model, reason);
            return { status: 200, body: { pricing: pricingDto(updated) } };
          },
        });
        reply.code(result.status).send(result.body);
      });

      // ── 财务月报（token/成本/实收/毛利；成本按激活模型现价折算，历史为近似）──
      child.get('/api/admin/ai/finance', async (req, reply) => {
        await readLimit(req);
        const month = String((req.query as Record<string, unknown>).month ?? '');
        opts.auditWriter.write({ eventType: 'admin.ai.finance.read', result: 'success', actorUserId: userIdOf(req), actorRole: 'platform_admin' });
        try {
          reply.send(await opts.billing.finance(month));
        } catch (err) {
          if (err instanceof ValidationError) return rejectConsole(reply, 422, 'VALIDATION_FAILED', 'invalid month');
          throw err;
        }
      });
    },
  });
}
