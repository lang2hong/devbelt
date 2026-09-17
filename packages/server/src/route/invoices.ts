import type { FastifyInstance, FastifyRequest } from 'fastify';
import { consoleSession, type GetAuthUser } from '../middleware/requireAuth.js';
import { registerConsoleErrorHandler, rejectConsole } from '../middleware/consoleError.js';
import { consoleWriteGuard } from '../middleware/consoleWrite.js';
import { validateIdempotencyKey, type IdempotencyService } from '../service/idempotencyService.js';
import type { InvoiceService } from '../service/invoiceService.js';
import type { TokenService } from '../service/tokenService.js';
import type { CsrfService } from '../service/csrfService.js';
import type { RateLimitService } from '../service/rateLimitService.js';
import type { CursorService } from '../service/cursor.js';
import type { Queryable } from '../repository/mysql/db.js';
import type { Invoice } from '../domain/entities.js';

/** 发票申请回执保留 30 天。 */
const INVOICE_RETENTION_MS = 30 * 24 * 3600 * 1000;

export interface InvoiceRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  csrfService: CsrfService;
  consoleOrigin: string;
  rateLimiter: RateLimitService;
  idempotencyService: IdempotencyService;
  cursorService: CursorService;
  invoiceService: InvoiceService;
}

function userIdOf(req: FastifyRequest): number {
  return (req as unknown as { authUserId: number }).authUserId;
}
function sessionIdOf(req: FastifyRequest): string {
  return (req as unknown as { authSessionId?: string }).authSessionId ?? '';
}

function invoiceDto(inv: Invoice) {
  return {
    invoiceId: String(inv.id),
    title: inv.title,
    taxNo: inv.taxNo ?? null,
    email: inv.email,
    amountCents: inv.amountCents,
    status: inv.status,
    reason: inv.reason ?? null,
    createTime: inv.createTime.toISOString(),
  };
}

function parseCursor(cursorService: CursorService, raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return undefined;
  const decoded = cursorService.decode(raw);
  if (decoded === null) return undefined;
  const n = Number(decoded);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : 50;
  if (!Number.isInteger(n) || n <= 0) return 50;
  return Math.min(n, 100);
}

/** 发票申请路由（P4 切片 3，console-only，恒注册）。申请 = 受控写；列表 = 限流读。 */
export async function invoiceRoutes(app: FastifyInstance, opts: InvoiceRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);
  const svc = opts.invoiceService;

  await app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    routes: async (child) => {
      child.get('/api/db/console/invoices', async (req, reply) => {
        const actor = userIdOf(req);
        await opts.rateLimiter.hit(`console:invoice:read:${actor}`, 60, 60);
        const q = req.query as Record<string, unknown>;
        const cursor = parseCursor(opts.cursorService, q.cursor);
        if (q.cursor !== undefined && q.cursor !== '' && cursor === undefined) {
          return rejectConsole(reply, 422, 'INVALID_CURSOR', 'invalid cursor');
        }
        const limit = parseLimit(q.limit);
        const invoices = await svc.listInvoices(actor, cursor, limit + 1);
        const hasMore = invoices.length > limit;
        const items = hasMore ? invoices.slice(0, limit) : invoices;
        reply.send({
          items: items.map(invoiceDto),
          nextCursor: hasMore && items.length ? opts.cursorService.encode(String(items[items.length - 1].id)) : null,
        });
      });

      child.post('/api/db/console/invoices', { schema: { body: createInvoiceBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
          return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        }
        const actor = userIdOf(req);
        const { orderNo, title, taxNo, email } = req.body as { orderNo: string; title: string; taxNo?: string; email: string };
        const result = await opts.idempotencyService.run({
          actorUserId: actor,
          sessionId: sessionIdOf(req),
          method: 'POST',
          normalizedPath: '/api/db/console/invoices',
          idempotencyKey: validateIdempotencyKey(req.headers['idempotency-key']),
          requestBody: req.body,
          retentionMs: INVOICE_RETENTION_MS,
          beforeWrite: (tx: Queryable) => opts.rateLimiter.hitInTx(tx, `console:invoice:create:${actor}`, 3600, 20),
          business: async (tx: Queryable) => {
            const inv = await svc.requestInvoiceInTx(tx, actor, { orderNo, title, taxNo, email });
            return { status: 201, body: { invoice: invoiceDto(inv) } };
          },
        });
        reply.code(result.status).send(result.body);
      });
    },
  });
}

const createInvoiceBody = {
  type: 'object',
  required: ['orderNo', 'title', 'email'],
  additionalProperties: false,
  properties: {
    orderNo: { type: 'string', minLength: 1, maxLength: 64 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    taxNo: { type: 'string', maxLength: 64 },
    email: { type: 'string', minLength: 3, maxLength: 255 },
  },
} as const;