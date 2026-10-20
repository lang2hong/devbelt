import type { FastifyInstance } from 'fastify';
import { rejectConsole } from '../../../middleware/consoleError.js';
import { consoleWriteGuard } from '../../../middleware/consoleWrite.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import {
  ADMIN_RETENTION_MS,
  adminWriteKey,
  parseCursor,
  parseDate,
  parseLimit,
  sessionIdOf,
  userDto,
  userIdOf,
  type AdminCtx,
} from './consoleAdminContext.js';

/** 平台用户管理：列表、同步概览/记录、状态/角色/订阅写（§6）。 */
export function registerUserAdminRoutes(child: FastifyInstance, ctx: AdminCtx): void {
  const { opts, svc, readLimit, writeLimitInTx } = ctx;

  // ── 用户 ──
  child.get('/api/admin/users', async (req, reply) => {
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
      total: page.total,
    });
  });

  child.get('/api/admin/users/:userId/sync-overview', { schema: { params: adminUserIdParam } }, async (req, reply) => {
    await readLimit(req);
    const userId = Number((req.params as Record<string, unknown>).userId);
    const rows = await svc.getSyncKindOverview(userIdOf(req), userId);
    reply.send({
      kinds: rows.map((r) => ({
        entityKind: r.entityKind,
        count: r.count,
        bytes: r.bytes,
        lastActivityTime: r.lastActivityTime ? r.lastActivityTime.toISOString() : null,
      })),
    });
  });

  // 后台受限读：同步记录元数据明细（E2E 加密，仅元数据；id 倒序 keyset 分页）。
  child.get('/api/admin/users/:userId/sync-records', { schema: { params: adminUserIdParam } }, async (req, reply) => {
    await readLimit(req);
    const userId = Number((req.params as Record<string, unknown>).userId);
    const q = req.query as Record<string, unknown>;
    const cursor = parseCursor(opts.cursorService, q.cursor);
    if (q.cursor !== undefined && q.cursor !== '' && cursor === null) {
      return rejectConsole(reply, 422, 'INVALID_CURSOR', 'invalid cursor');
    }
    const kind = q.kind ? String(q.kind) : undefined;
    const page = await svc.getSyncRecords(userIdOf(req), userId, { kind, afterId: cursor ?? undefined, limit: parseLimit(q.limit) });
    reply.send({
      state: page.state,
      items: page.items.map((r) => ({
        recordId: r.recordIdHex,
        entityKind: r.entityKind,
        version: r.version,
        changeSequence: r.changeSequence,
        bytes: r.bytes,
        createTime: r.createTime.toISOString(),
        updateTime: r.updateTime.toISOString(),
      })),
      nextCursor: page.nextId != null ? opts.cursorService.encode(String(page.nextId)) : null,
    });
  });

  child.patch('/api/admin/users/:userId/status', { schema: { params: adminUserIdParam, body: adminUserStatusBody } }, async (req, reply) => {
    if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
    const actor = userIdOf(req);
    const target = Number((req.params as Record<string, unknown>).userId);
    const { status, reason } = req.body as { status: 'active' | 'disabled'; reason: string };
    const result = await opts.idempotencyService.run({
      actorUserId: actor,
      sessionId: sessionIdOf(req),
      method: 'PATCH',
      normalizedPath: `/api/admin/users/${target}/status`,
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

  child.patch('/api/admin/users/:userId/role', { schema: { params: adminUserIdParam, body: adminUserRoleBody } }, async (req, reply) => {
    if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
    const actor = userIdOf(req);
    const target = Number((req.params as Record<string, unknown>).userId);
    const { role, reason } = req.body as { role: 'user' | 'platform_admin'; reason: string };
    const result = await opts.idempotencyService.run({
      actorUserId: actor,
      sessionId: sessionIdOf(req),
      method: 'PATCH',
      normalizedPath: `/api/admin/users/${target}/role`,
      idempotencyKey: adminWriteKey(req),
      requestBody: req.body,
      retentionMs: ADMIN_RETENTION_MS,
      beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
      business: async (tx: Queryable) => {
        const r = await svc.setUserRoleInTx(tx, actor, target, role, reason);
        return { status: 200, body: { user: r } };
      },
    });
    reply.code(result.status).send(result.body);
  });

  child.patch('/api/admin/users/:userId/subscription', { schema: { params: adminUserIdParam, body: adminUserSubscriptionBody } }, async (req, reply) => {
    if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
    const actor = userIdOf(req);
    const target = Number((req.params as Record<string, unknown>).userId);
    const { planCode, periodEndTime, reason, expectedVersion } = req.body as { planCode: string; periodEndTime: string | null; reason: string; expectedVersion: number };
    const periodEnd = periodEndTime ? parseDate(periodEndTime) ?? null : null;
    const result = await opts.idempotencyService.run({
      actorUserId: actor,
      sessionId: sessionIdOf(req),
      method: 'PATCH',
      normalizedPath: `/api/admin/users/${target}/subscription`,
      idempotencyKey: adminWriteKey(req),
      requestBody: req.body,
      retentionMs: ADMIN_RETENTION_MS,
      beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
      business: async (tx: Queryable) => {
        // 套餐解析放入 business：已完成回执优先于可变套餐状态（套餐停用后重放仍可返回首次结果，§6.1）。
        const plan = await svc.resolvePlanInTx(tx, planCode);
        const r = await svc.adjustUserSubscriptionInTx(tx, actor, target, { planId: plan.id, periodEndTime: periodEnd, reason, expectedVersion });
        return { status: 200, body: r };
      },
    });
    reply.code(result.status).send(result.body);
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

const adminUserRoleBody = {
  type: 'object',
  required: ['role', 'reason'],
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: ['user', 'platform_admin'] },
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