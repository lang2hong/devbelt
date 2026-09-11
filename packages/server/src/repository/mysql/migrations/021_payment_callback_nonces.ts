import type { Migration } from '../migrate.js';

/**
 * 支付回调 nonce 去重表（P4 收尾）。
 *
 * 微信回调验签头含 `wechatpay-nonce`；freshness 窗口内同一次回调可被重放，故需以
 * (channel, nonce_hash) 持久化去重，在业务处理前拒绝重放（channel_trade_no 唯一键
 * 只防「重复处理」，不防「重放洪流」，二者定位不同）。nonce 仅存 SHA-256 摘要。
 */
export const paymentNonceMigration: Migration = {
  version: '021_payment_callback_nonces',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_callback_nonces (
        channel VARCHAR(16) NOT NULL,
        nonce_hash CHAR(64) NOT NULL,
        expires_time DATETIME(3) NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (channel, nonce_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};