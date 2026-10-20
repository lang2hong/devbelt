import type { FastifyInstance } from 'fastify';
import { rejectConsole } from '../../../middleware/consoleError.js';
import { consoleWriteGuard } from '../../../middleware/consoleWrite.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import {
  ADMIN_RETENTION_MS,
  adminPlanDto,
  adminWriteKey,
  sessionIdOf,
  userIdOf,
  type AdminCtx,
} from './consoleAdminContext.js';

/** 平台套餐：列表 + 套餐/特性定义写；提交后失效缓存（§6）。 */
export function registerPlanAdminRoutes(child: FastifyInstance, ctx: AdminCtx): void {
  const { opts, svc, readLimit, writeLimitInTx } = ctx;

  // ── 套餐 ──
  child.get('/api/admin/plans', async (req, reply) => {
    await readLimit(req);
    const items = await svc.listPlansForAdmin(userIdOf(req));
    const featureDefs = await svc.listFeatureDefs();
    reply.send({ items: items.map(adminPlanDto), featureDefs });
  });

  child.patch('/api/admin/plans/:planId', { schema: { params: adminPlanIdParam, body: adminPlanBody } }, async (req, reply) => {
    if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
    const actor = userIdOf(req);
    const planId = Number((req.params as Record<string, unknown>).planId);
    const body = req.body as {
      name: string; priceCents: number; billingUnit: 'month' | 'seat-month'; sortOrder: number;
      status: 'active' | 'archived'; features: Array<{ featureKey: string; value: unknown }>;
      expectedVersion: number; reason: string;
    };
    const result = await opts.idempotencyService.run({
      actorUserId: actor,
      sessionId: sessionIdOf(req),
      method: 'PATCH',
      normalizedPath: `/api/admin/plans/${planId}`,
      idempotencyKey: adminWriteKey(req),
      requestBody: req.body,
      retentionMs: ADMIN_RETENTION_MS,
      beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
      business: async (tx: Queryable) => {
        const plan = await svc.updatePlanInTx(tx, actor, { id: planId, ...body });
        return { status: 200, body: { plan: adminPlanDto(plan) } };
      },
    });
    // 提交后失效：避免窗口内并发读者用「提交前旧值」回填缓存而长期滞留。
    opts.planRepo.invalidate(planId);
    reply.code(result.status).send(result.body);
  });

  child.put('/api/admin/plan-feature-defs/:key', { schema: { params: adminFeatureDefKeyParam, body: adminFeatureDefBody } }, async (req, reply) => {
    if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
    const actor = userIdOf(req);
    const key = String((req.params as Record<string, unknown>).key);
    const body = req.body as {
      kind: 'personal' | 'both'; label: { en: string; zh: string };
      valueType: 'bool' | 'number' | 'bytes' | 'stringList' | 'enum';
      unit: string | null; sortOrder: number; reason: string;
    };
    const result = await opts.idempotencyService.run({
      actorUserId: actor,
      sessionId: sessionIdOf(req),
      method: 'PUT',
      normalizedPath: `/api/admin/plan-feature-defs/${key}`,
      idempotencyKey: adminWriteKey(req),
      requestBody: req.body,
      retentionMs: ADMIN_RETENTION_MS,
      beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
      business: async (tx: Queryable) => {
        const def = await svc.upsertFeatureDefInTx(tx, actor, { key, ...body });
        return { status: 200, body: { featureDef: def } };
      },
    });
    reply.code(result.status).send(result.body);
  });
}

const adminPlanIdParam = {
  type: 'object',
  required: ['planId'],
  additionalProperties: false,
  properties: { planId: { type: 'integer', minimum: 1 } },
} as const;

const adminPlanBody = {
  type: 'object',
  required: ['name', 'priceCents', 'billingUnit', 'sortOrder', 'status', 'features', 'expectedVersion', 'reason'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64 },
    priceCents: { type: 'integer', minimum: 0 },
    billingUnit: { type: 'string', enum: ['month', 'seat-month'] },
    sortOrder: { type: 'integer' },
    status: { type: 'string', enum: ['active', 'archived'] },
    features: {
      type: 'array',
      items: {
        type: 'object',
        required: ['featureKey'],
        additionalProperties: false,
        properties: {
          featureKey: { type: 'string', minLength: 1, maxLength: 64 },
          value: {},
        },
      },
    },
    expectedVersion: { type: 'integer', minimum: 0 },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const adminFeatureDefKeyParam = {
  type: 'object',
  required: ['key'],
  additionalProperties: false,
  properties: { key: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const adminFeatureDefBody = {
  type: 'object',
  required: ['kind', 'label', 'valueType', 'sortOrder', 'reason'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['personal', 'both'] },
    label: {
      type: 'object',
      required: ['en', 'zh'],
      additionalProperties: false,
      properties: { en: { type: 'string', minLength: 1 }, zh: { type: 'string', minLength: 1 } },
    },
    valueType: { type: 'string', enum: ['bool', 'number', 'bytes', 'stringList', 'enum'] },
    unit: { type: ['string', 'null'] },
    sortOrder: { type: 'integer' },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;