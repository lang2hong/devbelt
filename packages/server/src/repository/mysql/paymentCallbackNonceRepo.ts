import type { IPaymentCallbackNonceRepo } from '../interfaces.js';
import type { PaymentChannel } from '../../domain/enums.js';
import type { MysqlDb } from './db.js';

/**
 * 支付回调 nonce 去重仓储。`INSERT IGNORE` 在值已存在时静默跳过（受影响行 0），
 * 据此区分「首次记录」与「重放」。
 */
export class MysqlPaymentCallbackNonceRepo implements IPaymentCallbackNonceRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async insertIfAbsent(channel: PaymentChannel, nonceHash: string, expiresTime: Date): Promise<boolean> {
    const [result] = await this.db().query<any>(
      `INSERT IGNORE INTO payment_callback_nonces (channel, nonce_hash, expires_time) VALUES (?, ?, ?)`,
      [channel, nonceHash, expiresTime],
    );
    return result.affectedRows === 1;
  }
}