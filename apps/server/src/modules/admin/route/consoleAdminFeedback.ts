import type { FastifyInstance } from 'fastify';
import { rejectConsole } from '../../../middleware/consoleError.js';
import { consoleWriteGuard } from '../../../middleware/consoleWrite.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import type {
  FeedbackEmailTarget,
  FeedbackReply,
  FeedbackRow,
  FeedbackStatus,
} from '../../../repository/interfaces/feedback.js';
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

const feedbackReplyBody = {
  type: 'object',
  required: ['body', 'emailTarget'],
  additionalProperties: false,
  properties: {
    body: { type: 'string', minLength: 1, maxLength: 4000 },
    emailTarget: { type: 'string', enum: ['none', 'account', 'contact'] },
  },
} as const;

function attachmentDto(a: { id: number; fileName: string; mime: string; sizeBytes: number; createTime: Date }) {
  return {
    id: String(a.id),
    fileName: a.fileName,
    mime: a.mime,
    sizeBytes: a.sizeBytes,
    createTime: a.createTime.toISOString(),
  };
}

const feedbackAttachmentParams = {
  type: 'object',
  required: ['feedbackId', 'attachmentId'],
  properties: {
    feedbackId: { type: 'integer', minimum: 1 },
    attachmentId: { type: 'integer', minimum: 1 },
  },
} as const;

function replyDto(r: FeedbackReply) {
  return {
    id: String(r.id),
    adminUserId: r.adminUserId === null ? null : String(r.adminUserId),
    body: r.body,
    emailStatus: r.emailStatus,
    emailTo: r.emailTo,
    emailError: r.emailError,
    createTime: r.createTime.toISOString(),
  };
}

function dto(r: FeedbackRow) {
  return {
    id: String(r.id),
    userId: r.userId === null ? null : String(r.userId),
    userEmail: r.userEmail,
    installId: r.installId,
    hasReplyKey: r.hasReplyKey,
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

  child.get('/api/admin/feedback/:feedbackId', { schema: { params: feedbackParams } }, async (req, reply) => {
    await readLimit(req);
    const id = Number((req.params as Record<string, unknown>).feedbackId);
    const d = await svc.getFeedbackDetail(userIdOf(req), id);
    reply.send({
      feedback: dto(d.feedback),
      userEmail: d.userEmail,
      // 站内可达：已关联账号（以该账号登录可见），或带 replyKey 哈希（原安装可见）。
      inAppDeliverable: d.feedback.userId !== null || d.feedback.hasReplyKey,
      replies: d.replies.map(replyDto),
      attachments: (d.attachments ?? []).map(attachmentDto),
    });
  });

  // 附件下载：管理后台鉴权后读取；不做公开静态托管。
  child.get(
    '/api/admin/feedback/:feedbackId/attachments/:attachmentId',
    { schema: { params: feedbackAttachmentParams } },
    async (req, reply) => {
      await readLimit(req);
      const p = req.params as { feedbackId: number; attachmentId: number };
      const a = await svc.getFeedbackAttachment(userIdOf(req), Number(p.feedbackId), Number(p.attachmentId));
      // 头里的文件名做 ASCII 兜底 + RFC 5987 的 UTF-8 形式；换行等控制字符不能进 header。
      const ascii = a.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      reply
        .header('Content-Type', a.mime)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .header('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`)
        .header('Content-Length', String(a.data.length))
        .send(a.data);
    },
  );

  child.post(
    '/api/admin/feedback/:feedbackId/replies',
    { schema: { params: feedbackParams, body: feedbackReplyBody } },
    async (req, reply) => {
      if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
        return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
      }
      const actor = userIdOf(req);
      const id = Number((req.params as Record<string, unknown>).feedbackId);
      const body = req.body as { body: string; emailTarget: FeedbackEmailTarget };
      // 邮件参数只在本请求首次执行时由 business 填入；重放不会进入 business，故不会重发。
      let pendingEmail: { replyId: number; to: string; originalContent: string } | null = null;
      const result = await opts.idempotencyService.run({
        actorUserId: actor,
        sessionId: sessionIdOf(req),
        method: 'POST',
        normalizedPath: `/api/admin/feedback/${id}/replies`,
        idempotencyKey: adminWriteKey(req),
        requestBody: req.body,
        retentionMs: ADMIN_RETENTION_MS,
        beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
        business: async (tx: Queryable) => {
          const r = await svc.replyFeedbackInTx(tx, actor, id, body.body, body.emailTarget);
          if (r.email) pendingEmail = { replyId: r.replyId, ...r.email };
          return { status: 201, body: { id: String(r.replyId), emailStatus: r.emailStatus } };
        },
      });

      let responseBody = result.body;
      const toSend = pendingEmail as { replyId: number; to: string; originalContent: string } | null;
      if (!result.replayed && toSend) {
        const status = await svc.sendFeedbackReplyEmail(toSend.replyId, toSend.to, body.body, toSend.originalContent);
        responseBody = { ...(result.body as Record<string, unknown>), emailStatus: status };
      }
      reply.code(result.status).send(responseBody);
    },
  );

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