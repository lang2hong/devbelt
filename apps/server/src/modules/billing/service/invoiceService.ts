import { EntityNotFoundError, InvoiceAlreadyRequestedError, OrderInvalidStateError } from '../../../domain/errors.js';
import type { Invoice } from '../../../domain/entities.js';
import type { IInvoiceRepo, IOrderRepo } from '../../../repository/interfaces.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import type { AuditWriter } from '../../../service/auditWriter.js';

export interface InvoiceServiceDeps {
  invoiceRepo: IInvoiceRepo;
  orderRepo: IOrderRepo;
  auditWriter: AuditWriter;
}

/**
 * 发票申请服务（P4 切片 3）。金额取自订单 `amountCents`（服务端权威，不接前端金额）；
 * 仅对归属当前用户的 fulfilled 订单可申请。登记申请记录，不生成发票文件本身。
 *
 * 跨渠道/跨会话重复开票由 `invoices.order_id` 唯一键兜底：不同 Idempotency-Key 的
 * 第二次申请触发 ER_DUP_ENTRY，映射为 `INVOICE_ALREADY_REQUESTED`(409)，绝不裸抛 500。
 */
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

export class InvoiceService {
  private readonly invoiceRepo: IInvoiceRepo;
  private readonly orderRepo: IOrderRepo;
  private readonly auditWriter: AuditWriter;

  constructor(deps: InvoiceServiceDeps) {
    this.invoiceRepo = deps.invoiceRepo;
    this.orderRepo = deps.orderRepo;
    this.auditWriter = deps.auditWriter;
  }

  async listInvoices(userId: number, cursor: number | undefined, limit: number): Promise<Invoice[]> {
    return this.invoiceRepo.listByUser(userId, cursor, limit);
  }

  async requestInvoiceInTx(
    tx: Queryable,
    userId: number,
    input: { orderNo: string; title: string; taxNo?: string; email: string },
  ): Promise<Invoice> {
    // 事务内锁定并读订单（同一连接），归属/状态/金额校验基于本事务的稳定读。
    const order = await this.orderRepo.findByOrderNoForUpdate(tx, input.orderNo);
    if (!order || order.userId !== userId) throw new EntityNotFoundError('order', input.orderNo);
    // 仅 fulfilled（已履约）可开票；pending/paid/expired/refunded 一律拒绝。
    if (order.status !== 'fulfilled') throw new OrderInvalidStateError('invoice requires a fulfilled order');

    let inv: Invoice;
    try {
      inv = await this.invoiceRepo.create(tx, {
        userId,
        orderId: order.id,
        title: input.title.trim(),
        taxNo: input.taxNo && input.taxNo.trim() ? input.taxNo.trim() : null,
        email: input.email.trim(),
        amountCents: order.amountCents,
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw new InvoiceAlreadyRequestedError();
      throw e;
    }

    this.auditWriter.writeInTx(tx, {
      eventType: 'invoice.requested',
      result: 'success',
      actorUserId: userId,
      targetType: 'order',
      targetId: order.orderNo,
    });
    return inv;
  }
}

function isDuplicateKey(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === ER_DUP_ENTRY;
}