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
import type { AiProviderService } from '../../ai/service/aiProviderService.js';
import type { AiProvider } from '../../ai/repository/aiProviderRepo.js';
import { ValidationError } from '../../../domain/errors.js';

/** 高危平台写回执保留 30 天（与 consoleAiTopup 同规）。 */
const ADMIN_RETENTION_MS = 30 * 24 * 3600 * 1000;
const RATE_READ_WINDOW_S = 60;
const RATE_READ_MAX = 60;
const RATE_WRITE_WINDOW_S = 60;
const RATE_WRITE_MAX = 30;

export interface ConsoleAiProvidersRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  csrfService: CsrfService;
  consoleOrigin: string;
  rateLimiter: RateLimitService;
  idempotencyService: IdempotencyService;
  providers: AiProviderService;
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

function providerDto(p: AiProvider) {
  return { code: p.code, name: p.name, baseUrl: p.baseUrl, models: p.models, status: p.status, sortOrder: p.sortOrder };
}

const modelItem = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    label: { type: 'string', maxLength: 64 },
    default: { type: 'boolean' },
  },
};
const nameObj = {
  type: 'object',
  required: ['en', 'zh'],
  additionalProperties: false,
  properties: { en: { type: 'string', minLength: 1, maxLength: 64 }, zh: { type: 'string', minLength: 1, maxLength: 64 } },
};
const createBody = {
  type: 'object',
  required: ['code', 'name', 'baseUrl', 'models', 'reason'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', maxLength: 32 },
    name: nameObj,
    baseUrl: { type: 'string', maxLength: 255 },
    models: { type: 'array', minItems: 1, maxItems: 50, items: modelItem },
    sortOrder: { type: 'integer', minimum: -100000, maximum: 100000 },
    reason: { type: 'string', maxLength: 500 },
  },
};
const updateBody = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    name: nameObj,
    baseUrl: { type: 'string', maxLength: 255 },
    models: { type: 'array', minItems: 1, maxItems: 50, items: modelItem },
    status: { type: 'string', enum: ['active', 'disabled'] },
    sortOrder: { type: 'integer', minimum: -100000, maximum: 100000 },
    reason: { type: 'string', maxLength: 500 },
  },
};

/**
 * 平台运营路由：AI 模型厂商目录管理（自带 Key 预设）。console-only + requireAdmin；
 * 写走「Origin 同源 + 会话绑定 CSRF + Idempotency-Key」回执事务，审计随业务同事务落库，reason 必填。
 */
export async function consoleAiProvidersRoutes(app: FastifyInstance, opts: ConsoleAiProvidersRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);
  const readLimit = (req: FastifyRequest) => opts.rateLimiter.hit(`console:admin:read:${userIdOf(req)}`, RATE_READ_WINDOW_S, RATE_READ_MAX);
  const writeLimitInTx = (tx: Queryable, req: FastifyRequest) =>
    opts.rateLimiter.hitInTx(tx, `console:admin:write:${userIdOf(req)}`, RATE_WRITE_WINDOW_S, RATE_WRITE_MAX);
  const audit = (tx: Queryable, eventType: 'admin.ai.provider.created' | 'admin.ai.provider.updated', req: FastifyRequest, code: string, reason: string) =>
    opts.auditWriter.writeInTx(tx, {
      eventType,
      result: 'success',
      actorUserId: userIdOf(req),
      actorRole: 'platform_admin',
      targetType: 'provider',
      targetId: code,
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
      child.get('/api/admin/ai/providers', async (req, reply) => {
        await readLimit(req);
        opts.auditWriter.write({ eventType: 'admin.ai.providers.read', result: 'success', actorUserId: userIdOf(req), actorRole: 'platform_admin' });
        reply.send({ items: (await opts.providers.listAll()).map(providerDto) });
      });

      child.post('/api/admin/ai/providers', { schema: { body: createBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const body = req.body as { code: string; name: unknown; baseUrl: string; models: unknown; sortOrder?: number; reason: string };
        const reason = requireReason(body.reason);
        const result = await opts.idempotencyService.run({
          actorUserId: userIdOf(req),
          sessionId: sessionIdOf(req),
          method: 'POST',
          normalizedPath: '/api/admin/ai/providers',
          idempotencyKey: validateIdempotencyKey(req.headers['idempotency-key']),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            const created = await opts.providers.createInTx(tx, body);
            if (!created) return { status: 409, body: { error: { code: 'CONFLICT', message: 'provider code already exists' } } };
            audit(tx, 'admin.ai.provider.created', req, created.code, reason);
            return { status: 201, body: { provider: providerDto(created) } };
          },
        });
        reply.code(result.status).send(result.body);
      });

      child.patch('/api/admin/ai/providers/:code', { schema: { body: updateBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        const code = String((req.params as Record<string, unknown>).code);
        const body = req.body as { name?: unknown; baseUrl?: string; models?: unknown; status?: 'active' | 'disabled'; sortOrder?: number; reason: string };
        const reason = requireReason(body.reason);
        const result = await opts.idempotencyService.run({
          actorUserId: userIdOf(req),
          sessionId: sessionIdOf(req),
          method: 'PATCH',
          normalizedPath: `/api/admin/ai/providers/${code}`,
          idempotencyKey: validateIdempotencyKey(req.headers['idempotency-key']),
          requestBody: req.body,
          retentionMs: ADMIN_RETENTION_MS,
          beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
          business: async (tx: Queryable) => {
            const updated = await opts.providers.updateInTx(tx, code, body);
            if (!updated) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'provider not found' } } };
            audit(tx, 'admin.ai.provider.updated', req, code, reason);
            return { status: 200, body: { provider: providerDto(updated) } };
          },
        });
        reply.code(result.status).send(result.body);
      });
    },
  });
}
