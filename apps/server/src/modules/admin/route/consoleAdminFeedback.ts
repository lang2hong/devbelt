import type { FastifyInstance } from 'fastify';
import { rejectConsole } from '../../../middleware/consoleError.js';
import { consoleWriteGuard } from '../../../middleware/consoleWrite.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import type { FeedbackRow, FeedbackStatus } from '../../../repository/interfaces/feedback.js';
import {
  ADMIN_RETENTION_MS,
  adminWriteKey,
  parseCursor,
  parseLimit,
  sessionIdOf,
  userIdOf,
  type AdminCtx,
} from './consoleAdminContext.js';

const STATUSES = ['new', 'triaged', 'done', 'rejected'] as const;
const CATEGORIES = ['bug', 'feature', 'other'] as const;

const feedbackParams = {
  type: 'object',
  required: ['feedbackId'],
  properties: { feedbackId: { type: 'integer', minimum: 1 } },
} as const;

const feedbackPatchBody = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: STATUSES },
    adminNote: { type: ['string', 'null'], maxLength: 1000 },
  },
} as const;

function dto(r: FeedbackRow) {
  return {
    id: String(r.id),
    userId: r.userId === null ? null : String(r.userId),
    installId: r.installId,
    category: r.category,
    content: r.content,
    contact: r.contact,
    appVersion: r.appVersion,
    os: r.os,
    status: r.status,
    adminNote: r.adminNote,
    sourceIp: r.sourceIp,
    createTime: r.createTime.toISOString(),
    updateTime: r.updateTime.toISOString(),
  };
}

/** 运营：概览聚合 + 用户反馈列表与状态流转。 */
export function registerFeedbackAdminRoutes(child: FastifyInstance, ctx: AdminCtx): void {
  const { opts, svc, readLimit, writeLimitInTx } = ctx;

  child.get('/api/admin/overview', async (req, reply) => {
    await readLimit(req);
    reply.send(await svc.getOverview(userIdOf(req)));
  });

  child.get('/api/admin/feedback', async (req, reply) => {
    await readLimit(req);
    const q = req.query as Record<string, unknown>;
    const cursor = parseCursor(opts.cursorService, q.cursor);
    if (q.cursor !== undefined && q.cursor !== '' && cursor === null) {
      return rejectConsole(reply, 422, 'INVALID_CURSOR', 'invalid cursor');
    }
    const status = q.status === undefined || q.status === '' ? undefined : String(q.status);
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
      return rejectConsole(reply, 422, 'VALIDATION_FAILED', 'invalid status');
    }
    const category = q.category === undefined || q.category === '' ? undefined : String(q.category);
    if (category !== undefined && !(CATEGORIES as readonly string[]).includes(category)) {
      return rejectConsole(reply, 422, 'VALIDATION_FAILED', 'invalid category');
    }
    const page = await svc.listFeedback(userIdOf(req), {
      status: status as FeedbackStatus | undefined,
      category: category as FeedbackRow['category'] | undefined,
      userId: q.userId ? Number(q.userId) : undefined,
      afterId: cursor ?? undefined,
      limit: parseLimit(q.limit),
    });
    reply.send({
      items: page.items.map(dto),
      nextCursor: page.nextId != null ? opts.cursorService.encode(String(page.nextId)) : null,
      total: page.total,
    });
  });

  child.patch(
    '/api/admin/feedback/:feedbackId',
    { schema: { params: feedbackParams, body: feedbackPatchBody } },
    async (req, reply) => {
      if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
        return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
      }
      const actor = userIdOf(req);
      const id = Number((req.params as Record<string, unknown>).feedbackId);
      const body = req.body as { status: FeedbackStatus; adminNote?: string | null };
      const result = await opts.idempotencyService.run({
        actorUserId: actor,
        sessionId: sessionIdOf(req),
        method: 'PATCH',
        normalizedPath: `/api/admin/feedback/${id}`,
        idempotencyKey: adminWriteKey(req),
        requestBody: req.body,
        retentionMs: ADMIN_RETENTION_MS,
        beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
        business: async (tx: Queryable) => {
          const ok = await svc.updateFeedbackInTx(tx, actor, id, body.status, body.adminNote ?? null);
          if (!ok) return { status: 404, body: { code: 'NOT_FOUND', message: 'feedback not found' } };
          return { status: 200, body: { id: String(id), status: body.status } };
        },
      });
      reply.code(result.status).send(result.body);
    },
  );
}