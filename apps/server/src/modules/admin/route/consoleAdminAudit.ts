import type { FastifyInstance } from 'fastify';
import { rejectConsole } from '../../../middleware/consoleError.js';
import { consoleWriteGuard } from '../../../middleware/consoleWrite.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import type { AuditFilter } from '../../../repository/interfaces.js';
import { auditDto } from '../../../service/auditSerialize.js';
import {
  ADMIN_RETENTION_MS,
  adminWriteKey,
  parseCursor,
  parseDate,
  parseLimit,
  sessionIdOf,
  userIdOf,
  type AdminCtx,
} from './consoleAdminContext.js';

/** 平台审计：列表查询 + CSV/JSON 导出（导出纳入幂等回执与限流，§6）。 */
export function registerAuditAdminRoutes(child: FastifyInstance, ctx: AdminCtx): void {
  const { opts, svc, readLimit, exportLimitInTx } = ctx;

  // ── 审计 ──
  child.get('/api/admin/audit', async (req, reply) => {
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
      cursor: cursor ?? undefined,
      limit: parseLimit(q.limit),
    };
    const page = await svc.queryAudit(userIdOf(req), filter);
    reply.send({
      items: page.items.map(auditDto),
      nextCursor: page.nextId != null ? opts.cursorService.encode(String(page.nextId)) : null,
    });
  });

  child.post('/api/admin/audit/exports', { schema: { body: adminAuditExportBody } }, async (req, reply) => {
    if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
    const { format, filters, expectedCountUpperBound } = req.body as {
      format: 'csv' | 'json';
      filters: { fromTime?: string; toTime?: string; actorUserId?: number; eventType?: string; targetType?: string };
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
    };
    // 导出按 §6 需 Idempotency-Key 且纳入幂等回执：beforeWrite 事务内限流 + business 内
    // 读取/渲染/审计写同事务，同键同摘要重放返回首次文件，不重复读/审计/不重复耗限流额度。
    const result = await opts.idempotencyService.run({
      actorUserId: actor,
      sessionId: sessionIdOf(req),
      method: 'POST',
      normalizedPath: '/api/admin/audit/exports',
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
}

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
      },
    },
  },
} as const;