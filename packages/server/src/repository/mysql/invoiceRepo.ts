import type { IInvoiceRepo, AdminInvoiceFilter } from '../interfaces.js';
import type { Invoice } from '../../domain/entities.js';
import type { InvoiceStatus } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/** 发票申请仓储（只登记申请记录与状态，不生成发票文件本身，见 P4 §数据模型）。 */
export class MysqlInvoiceRepo implements IInvoiceRepo {
  constructor(private readonly db: () => MysqlDb) {}

  /**
   * 创建发票申请：回执事务内建发票 + 审计，必须全程走调用方 `exec`，不回读走池
   * （与 paymentRepo.create 同契约）。
   */
  async create(exec: Queryable, input: {
    userId: number;
    orderId: number | null;
    title: string;
    taxNo: string | null;
    email: string;
    amountCents: number;
  }): Promise<Invoice> {
    const [result] = await exec.query<any>(
      `INSERT INTO invoices (user_id, order_id, title, tax_no, email, amount_cents, status)
       VALUES (?, ?, ?, ?, ?, ?, 'requested')`,
      [input.userId, input.orderId ?? null, input.title, input.taxNo ?? null, input.email, input.amountCents],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM invoices WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('invoice insert failed');
    return mapInvoice(rows[0]);
  }

  async listByUser(userId: number, cursor: number | undefined, limit: number): Promise<Invoice[]> {
    const where = cursor !== undefined ? 'user_id = ? AND id < ?' : 'user_id = ?';
    const params = cursor !== undefined ? [userId, cursor] : [userId];
    const [rows] = await this.db().query<any[]>(
      `SELECT * FROM invoices WHERE ${where} ORDER BY id DESC LIMIT ${Number(limit)}`,
      params,
    );
    return rows.map(mapInvoice);
  }

  async findByIdForUpdate(exec: Queryable, id: number): Promise<Invoice | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM invoices WHERE id = ? FOR UPDATE', [id]);
    return rows[0] ? mapInvoice(rows[0]) : undefined;
  }

  async advance(exec: Queryable, input: {
    id: number;
    expectedStatus: InvoiceStatus;
    status: InvoiceStatus;
    reason: string | null;
  }): Promise<boolean> {
    const [result] = await exec.query<any>(
      `UPDATE invoices SET status = ?, reason = ? WHERE id = ? AND status = ?`,
      [input.status, input.reason, input.id, input.expectedStatus],
    );
    return result.affectedRows === 1;
  }

  async hasIssuedForOrder(exec: Queryable, orderId: number): Promise<boolean> {
    const [rows] = await exec.query<any[]>(
      `SELECT 1 FROM invoices WHERE order_id = ? AND status = 'issued' LIMIT 1`,
      [orderId],
    );
    return rows.length > 0;
  }

  async listAll(input: AdminInvoiceFilter): Promise<Invoice[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.userId !== undefined) {
      where.push('user_id = ?');
      params.push(input.userId);
    }
    if (input.status !== undefined) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.cursor !== undefined) {
      where.push('id < ?');
      params.push(input.cursor);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await this.db().query<any[]>(
      `SELECT * FROM invoices ${whereSql} ORDER BY id DESC LIMIT ${Number(input.limit)}`,
      params,
    );
    return rows.map(mapInvoice);
  }
}

function mapInvoice(r: any): Invoice {
  return {
    id: r.id,
    userId: r.user_id,
    orderId: r.order_id ?? null,
    title: r.title,
    taxNo: r.tax_no ?? null,
    email: r.email,
    amountCents: Number(r.amount_cents),
    status: r.status as InvoiceStatus,
    reason: r.reason ?? null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}