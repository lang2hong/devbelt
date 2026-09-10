import type { IInvoiceRepo } from '../interfaces.js';
import type { Invoice } from '../../domain/entities.js';
import type { InvoiceStatus } from '../../domain/enums.js';
import type { MysqlDb } from './db.js';

/** 发票申请仓储（只登记申请记录与状态，不生成发票文件本身，见 P4 §数据模型）。 */
export class MysqlInvoiceRepo implements IInvoiceRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(input: {
    userId: number;
    orderId: number | null;
    title: string;
    taxNo: string | null;
    email: string;
    amountCents: number;
  }): Promise<Invoice> {
    const [result] = await this.db().query<any>(
      `INSERT INTO invoices (user_id, order_id, title, tax_no, email, amount_cents, status)
       VALUES (?, ?, ?, ?, ?, ?, 'requested')`,
      [input.userId, input.orderId ?? null, input.title, input.taxNo ?? null, input.email, input.amountCents],
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('invoice insert failed');
    return created;
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

  private async findById(id: number): Promise<Invoice | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM invoices WHERE id = ?', [id]);
    return rows[0] ? mapInvoice(rows[0]) : undefined;
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
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}