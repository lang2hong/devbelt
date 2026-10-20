import type { FastifyInstance } from 'fastify';
import { rejectConsole } from '../../../middleware/consoleError.js';
import { consoleWriteGuard } from '../../../middleware/consoleWrite.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import type { Order } from '../../../domain/entities.js';
import type { InvoiceStatus } from '../../../domain/enums.js';
import { PAYMENT_CHANNELS } from '../../billing/service/paymentChannel.js';
import {
  ADMIN_RETENTION_MS,
  adminInvoiceDto,
  adminOrderDto,
  adminWriteKey,
  INVOICE_STATUSES,
  ORDER_STATUSES,
  parseCursor,
  parseDate,
  parseLimit,
  sessionIdOf,
  userIdOf,
  type AdminCtx,
} from './consoleAdminContext.js';

/** 平台订单/发票：只读列表 + 退款/开票状态写（§6）。 */
export function registerBillingAdminRoutes(child: FastifyInstance, ctx: AdminCtx): void {
  const { opts, svc, readLimit, writeLimitInTx } = ctx;

  // ── 订单 ──
  child.get('/api/admin/orders', async (req, reply) => {
    await readLimit(req);
    const q = req.query as Record<string, unknown>;
    const cursor = parseCursor(opts.cursorService, q.cursor);
    if (q.cursor !== undefined && q.cursor !== '' && cursor === null) {
      return rejectConsole(reply, 422, 'INVALID_CURSOR', 'invalid cursor');
    }
    const status = q.status !== undefined && q.status !== '' ? String(q.status) : undefined;
    const channel = q.channel !== undefined && q.channel !== '' ? String(q.channel) : undefined;
    const rawUserId = q.userId !== undefined && q.userId !== '' ? String(q.userId) : undefined;
    let filterUserId: number | undefined;
    if (rawUserId !== undefined) {
      const n = Number(rawUserId);
      if (!/^[0-9]+$/.test(rawUserId) || !Number.isSafeInteger(n) || n <= 0) {
        return rejectConsole(reply, 422, 'VALIDATION_FAILED', 'invalid userId');
      }
      filterUserId = n;
    }
    const purpose = q.purpose !== undefined && q.purpose !== '' ? String(q.purpose) : undefined;
    const ADMIN_CHANNELS: readonly string[] = [...PAYMENT_CHANNELS, 'manual'];
    const page = await svc.listOrders(userIdOf(req), {
      userId: filterUserId,
      status: status && (ORDER_STATUSES as readonly string[]).includes(status) ? (status as Order['status']) : undefined,
      channel: channel && (ADMIN_CHANNELS as readonly string[]).includes(channel) ? (channel as Order['channel']) : undefined,
      purpose: purpose && (['plan', 'topup'] as readonly string[]).includes(purpose) ? (purpose as Order['purpose']) : undefined,
      planCode: q.planCode ? String(q.planCode) : undefined,
      createdFrom: parseDate(q.createdFrom),
      createdTo: parseDate(q.createdTo),
      cursor: cursor ?? undefined,
      limit: parseLimit(q.limit),
    });
    reply.send({
      items: page.items.map(adminOrderDto),
      nextCursor: page.nextId != null ? opts.cursorService.encode(String(page.nextId)) : null,
      total: page.total,
    });
  });

  child.patch('/api/admin/orders/:orderNo/refund', { schema: { params: adminOrderNoParam, body: adminOrderRefundBody } }, async (req, reply) => {
    if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
    const actor = userIdOf(req);
    const orderNo = (req.params as Record<string, unknown>).orderNo as string;
    const { reason } = req.body as { reason: string };
    const result = await opts.idempotencyService.run({
      actorUserId: actor,
      sessionId: sessionIdOf(req),
      method: 'PATCH',
      normalizedPath: `/api/admin/orders/${orderNo}/refund`,
      idempotencyKey: adminWriteKey(req),
      requestBody: req.body,
      retentionMs: ADMIN_RETENTION_MS,
      beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
      business: async (tx: Queryable) => {
        const r = await svc.refundOrderInTx(tx, actor, orderNo, reason);
        return { status: 200, body: r };
      },
    });
    reply.code(result.status).send(result.body);
  });

  // ── 发票 ──
  child.get('/api/admin/invoices', async (req, reply) => {
    await readLimit(req);
    const q = req.query as Record<string, unknown>;
    const cursor = parseCursor(opts.cursorService, q.cursor);
    if (q.cursor !== undefined && q.cursor !== '' && cursor === null) {
      return rejectConsole(reply, 422, 'INVALID_CURSOR', 'invalid cursor');
    }
    const status = q.status !== undefined && q.status !== '' ? String(q.status) : undefined;
    if (status !== undefined && !(INVOICE_STATUSES as readonly string[]).includes(status)) {
      return rejectConsole(reply, 422, 'VALIDATION_FAILED', 'invalid status');
    }
    const rawUserId = q.userId !== undefined && q.userId !== '' ? String(q.userId) : undefined;
    let filterUserId: number | undefined;
    if (rawUserId !== undefined) {
      const n = Number(rawUserId);
      if (!/^[0-9]+$/.test(rawUserId) || !Number.isSafeInteger(n) || n <= 0) {
        return rejectConsole(reply, 422, 'VALIDATION_FAILED', 'invalid userId');
      }
      filterUserId = n;
    }
    const page = await svc.listInvoicesForAdmin(userIdOf(req), {
      userId: filterUserId,
      status: status as InvoiceStatus | undefined,
      cursor: cursor ?? undefined,
      limit: parseLimit(q.limit),
    });
    reply.send({
      items: page.items.map(adminInvoiceDto),
      nextCursor: page.nextId != null ? opts.cursorService.encode(String(page.nextId)) : null,
      total: page.total,
    });
  });

  child.patch('/api/admin/invoices/:invoiceId', { schema: { params: adminInvoiceIdParam, body: adminInvoiceStatusBody } }, async (req, reply) => {
    if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
    const actor = userIdOf(req);
    const invoiceId = Number((req.params as Record<string, unknown>).invoiceId);
    const { status, reason } = req.body as { status: 'issued' | 'rejected' | 'failed'; reason?: string };
    const result = await opts.idempotencyService.run({
      actorUserId: actor,
      sessionId: sessionIdOf(req),
      method: 'PATCH',
      normalizedPath: `/api/admin/invoices/${invoiceId}`,
      idempotencyKey: adminWriteKey(req),
      requestBody: req.body,
      retentionMs: ADMIN_RETENTION_MS,
      beforeWrite: (tx: Queryable) => writeLimitInTx(tx, req),
      business: async (tx: Queryable) => {
        const r = await svc.setInvoiceStatusInTx(tx, actor, invoiceId, status, reason ?? null);
        return { status: 200, body: r };
      },
    });
    reply.code(result.status).send(result.body);
  });
}

const adminOrderNoParam = {
  type: 'object',
  required: ['orderNo'],
  additionalProperties: false,
  properties: { orderNo: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const adminOrderRefundBody = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
} as const;

const adminInvoiceIdParam = {
  type: 'object',
  required: ['invoiceId'],
  additionalProperties: false,
  properties: { invoiceId: { type: 'string', pattern: '^[0-9]+$' } },
} as const;

const adminInvoiceStatusBody = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['issued', 'rejected', 'failed'] },
    reason: { type: 'string', maxLength: 500 },
  },
} as const;