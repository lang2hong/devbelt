import type { IPaymentRepo } from '../interfaces.js';
import type { Payment } from '../../domain/entities.js';
import type { PaymentChannel, PaymentResult } from '../../domain/enums.js';
import type { Queryable } from './db.js';

/** 支付流水仓储（orders 一对多；回调幂等以 uq_payments_channel_trade 兜底）。 */
export class MysqlPaymentRepo implements IPaymentRepo {
  /** 仅事务内使用（回调创建流水 + 推进订单必须同一条连接），不持有池 getter。 */
  async create(exec: Queryable, input: {
    orderId: number;
    channel: PaymentChannel;
    channelTradeNo: string;
    amountCents: number;
    rawNotification: string | null;
    signatureVerified: boolean;
    result: PaymentResult;
  }): Promise<Payment> {
    const [result] = await exec.query<any>(
      `INSERT INTO payments (order_id, channel, channel_trade_no, amount_cents, raw_notification, signature_verified, result)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.orderId,
        input.channel,
        input.channelTradeNo,
        input.amountCents,
        input.rawNotification,
        input.signatureVerified ? 1 : 0,
        input.result,
      ],
    );
    const [readRows] = await exec.query<any[]>('SELECT * FROM payments WHERE id = ?', [result.insertId]);
    const created = readRows[0] ? mapPayment(readRows[0]) : undefined;
    if (!created) throw new Error('payment insert failed');
    return created;
  }

  async findByChannelTradeNo(exec: Queryable, channel: PaymentChannel, channelTradeNo: string): Promise<Payment | undefined> {
    const [rows] = await exec.query<any[]>(
      'SELECT * FROM payments WHERE channel = ? AND channel_trade_no = ?',
      [channel, channelTradeNo],
    );
    return rows[0] ? mapPayment(rows[0]) : undefined;
  }
}

function mapPayment(r: any): Payment {
  return {
    id: r.id,
    orderId: r.order_id,
    channel: r.channel as PaymentChannel,
    channelTradeNo: r.channel_trade_no,
    amountCents: Number(r.amount_cents),
    rawNotification: r.raw_notification ?? null,
    signatureVerified: r.signature_verified === 1 || r.signature_verified === true,
    result: r.result as PaymentResult,
    createTime: new Date(r.create_time),
  };
}