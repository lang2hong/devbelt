import { describe, it, expect } from 'vitest';
import { InvoiceService } from '../../src/modules/billing/service/invoiceService.js';
import { EntityNotFoundError, InvoiceAlreadyRequestedError, OrderInvalidStateError } from '../../src/domain/errors.js';
import type { Invoice, Order } from '../../src/domain/entities.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import { AuditWriter } from '../../src/service/auditWriter.js';

function fulfilledOrder(): Order {
  return {
    id: 7,
    orderNo: 'ord-fulfilled',
    userId: 1,
    planCode: 'pro', planVersion: 1,
    amountCents: 9900,
    channel: 'wechat',
    status: 'fulfilled',
    channelTradeNo: 'wx-1',
    paidTime: new Date(),
    expiresTime: new Date(Date.now() + 1000),
    createTime: new Date(),
    updateTime: new Date(),
  };
}

function makeService(orders: Map<string, Order>, opts: { dupOnCreate?: boolean; capturePoolRead?: () => void } = {}) {
  const inv: Invoice[] = [];
  const invoiceRepo = {
    async create(_exec: Queryable, input: { userId: number; orderId: number | null; title: string; taxNo: string | null; email: string; amountCents: number }): Promise<Invoice> {
      if (opts.dupOnCreate) {
        const e = new Error('duplicate') as Error & { code: string };
        e.code = 'ER_DUP_ENTRY';
        throw e;
      }
      const i = { id: inv.length + 1, ...input, status: 'requested' as const, reason: null as string | null, createTime: new Date(), updateTime: new Date() };
      inv.push(i);
      return i;
    },
    async listByUser(userId: number): Promise<Invoice[]> {
      return inv.filter((i) => i.userId === userId);
    },
  };
  // 记录是否走了池读（事务内严禁）：用 findByOrderNo 标记。
  let poolRead = false;
  const orderRepo = {
    async findByOrderNoForUpdate(_tx: Queryable, orderNo: string): Promise<Order | undefined> {
      return orders.get(orderNo);
    },
    async findByOrderNo(orderNo: string): Promise<Order | undefined> {
      poolRead = true;
      opts.capturePoolRead?.();
      return orders.get(orderNo);
    },
  };
  const svc = new InvoiceService({
    invoiceRepo: invoiceRepo as never,
    orderRepo: orderRepo as never,
    auditWriter: new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as never),
  });
  return { svc, inv, isPoolRead: () => poolRead };
}

describe('InvoiceService.requestInvoice', () => {
  it('creates an invoice with the order amount for a fulfilled order', async () => {
    const orders = new Map([['ord-fulfilled', fulfilledOrder()]]);
    const { svc, inv } = makeService(orders);
    const r = await svc.requestInvoiceInTx({} as Queryable, 1, { orderNo: 'ord-fulfilled', title: 'Acme Inc.', taxNo: ' 91110000X ', email: 'billing@a.com' });
    expect(r.amountCents).toBe(9900);
    expect(r.title).toBe('Acme Inc.');
    expect(r.taxNo).toBe('91110000X');
    expect(r.email).toBe('billing@a.com');
    expect(inv).toHaveLength(1);
  });

  it('reads the order on the transaction exec, never the pool', async () => {
    const orders = new Map([['ord-fulfilled', fulfilledOrder()]]);
    const { svc, isPoolRead } = makeService(orders);
    await svc.requestInvoiceInTx({} as Queryable, 1, { orderNo: 'ord-fulfilled', title: 'X', email: 'x@a.com' });
    expect(isPoolRead()).toBe(false);
  });

  it('maps a duplicate order_id unique-key violation to INVOICE_ALREADY_REQUESTED', async () => {
    const orders = new Map([['ord-fulfilled', fulfilledOrder()]]);
    const { svc } = makeService(orders, { dupOnCreate: true });
    await expect(
      svc.requestInvoiceInTx({} as Queryable, 1, { orderNo: 'ord-fulfilled', title: 'X', email: 'x@a.com' }),
    ).rejects.toBeInstanceOf(InvoiceAlreadyRequestedError);
  });

  it('rejects a non-fulfilled order', async () => {
    const pending = { ...fulfilledOrder(), status: 'pending' as const };
    const orders = new Map([['ord-pending', pending]]);
    const { svc } = makeService(orders);
    await expect(
      svc.requestInvoiceInTx({} as Queryable, 1, { orderNo: 'ord-pending', title: 'X', email: 'x@a.com' }),
    ).rejects.toBeInstanceOf(OrderInvalidStateError);
  });

  it('rejects another user\'s order', async () => {
    const orders = new Map([['ord-fulfilled', fulfilledOrder()]]);
    const { svc } = makeService(orders);
    await expect(
      svc.requestInvoiceInTx({} as Queryable, 999, { orderNo: 'ord-fulfilled', title: 'X', email: 'x@a.com' }),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });
});