import type { IOrderRepo, AdminOrderFilter } from '../interfaces.js';
import type { Order } from '../../domain/entities.js';
import type { OrderStatus, PaymentChannel } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/**
 * 支付订单仓储。金额/状态推进由服务层在行锁内序列化；本仓储只提供读写原语。
 * 无业务外键（全库约定：软删 + 服务层行锁校验）。
 */
export class MysqlOrderRepo implements IOrderRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(input: {
    orderNo: string;
    userId: number;
    planCode: string;
    amountCents: number;
    channel: PaymentChannel;
    expiresTime: Date;
  }): Promise<Order> {
    const [result] = await this.db().query<any>(
      `INSERT INTO orders (order_no, user_id, plan_code, amount_cents, channel, status, expires_time)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [input.orderNo, input.userId, input.planCode, input.amountCents, input.channel, input.expiresTime],
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('order insert failed');
    return created;
  }

  async findByOrderNo(orderNo: string): Promise<Order | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM orders WHERE order_no = ?', [orderNo]);
    return rows[0] ? mapOrder(rows[0]) : undefined;
  }

  async findByOrderNoForUpdate(exec: Queryable, orderNo: string): Promise<Order | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM orders WHERE order_no = ? FOR UPDATE', [orderNo]);
    return rows[0] ? mapOrder(rows[0]) : undefined;
  }

  async findByIdForUpdate(exec: Queryable, id: number): Promise<Order | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
    return rows[0] ? mapOrder(rows[0]) : undefined;
  }

  async advance(exec: Queryable, input: {
    id: number;
    expectedStatus: OrderStatus;
    status: OrderStatus;
    channelTradeNo: string | null;
    paidTime: Date | null;
  }): Promise<boolean> {
    const [result] = await exec.query<any>(
      `UPDATE orders
       SET status = ?, channel_trade_no = COALESCE(?, channel_trade_no), paid_time = COALESCE(?, paid_time)
       WHERE id = ? AND status = ?`,
      [input.status, input.channelTradeNo, input.paidTime, input.id, input.expectedStatus],
    );
    return result.affectedRows === 1;
  }

  async listByUser(userId: number, cursor: number | undefined, limit: number): Promise<Order[]> {
    const where = cursor !== undefined ? 'user_id = ? AND id < ?' : 'user_id = ?';
    const params = cursor !== undefined ? [userId, cursor] : [userId];
    const [rows] = await this.db().query<any[]>(
      `SELECT * FROM orders WHERE ${where} ORDER BY id DESC LIMIT ${Number(limit)}`,
      params,
    );
    return rows.map(mapOrder);
  }

  async listAll(input: AdminOrderFilter): Promise<Order[]> {
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
    if (input.channel !== undefined) {
      where.push('channel = ?');
      params.push(input.channel);
    }
    if (input.planCode !== undefined) {
      where.push('plan_code = ?');
      params.push(input.planCode);
    }
    if (input.createdFrom) {
      where.push('create_time >= ?');
      params.push(input.createdFrom);
    }
    if (input.createdTo) {
      where.push('create_time <= ?');
      params.push(input.createdTo);
    }
    if (input.cursor !== undefined) {
      where.push('id < ?');
      params.push(input.cursor);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await this.db().query<any[]>(
      `SELECT * FROM orders ${whereSql} ORDER BY id DESC LIMIT ${Number(input.limit)}`,
      params,
    );
    return rows.map(mapOrder);
  }

  async findPendingByUserAndPlan(userId: number, planCode: string, channel: PaymentChannel): Promise<Order | undefined> {
    const [rows] = await this.db().query<any[]>(
      `SELECT * FROM orders
       WHERE user_id = ? AND plan_code = ? AND channel = ? AND status = 'pending' AND expires_time > NOW(3)
       ORDER BY id DESC LIMIT 1`,
      [userId, planCode, channel],
    );
    return rows[0] ? mapOrder(rows[0]) : undefined;
  }

  async expirePending(now: Date, limit: number): Promise<number> {
    const [result] = await this.db().query<any>(
      `UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_time < ? LIMIT ?`,
      [now, limit],
    );
    return result.affectedRows;
  }

  private async findById(id: number): Promise<Order | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM orders WHERE id = ?', [id]);
    return rows[0] ? mapOrder(rows[0]) : undefined;
  }
}

function mapOrder(r: any): Order {
  return {
    id: r.id,
    orderNo: r.order_no,
    userId: r.user_id,
    planCode: r.plan_code,
    amountCents: Number(r.amount_cents),
    channel: r.channel as PaymentChannel,
    status: r.status as OrderStatus,
    channelTradeNo: r.channel_trade_no ?? null,
    paidTime: r.paid_time ? new Date(r.paid_time) : null,
    expiresTime: new Date(r.expires_time),
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}