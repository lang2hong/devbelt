import type { Migration } from '../migrate.js';

/**
 * 支付闭环 schema（P4 §数据模型）：orders / payments / invoices。
 *
 * ## 金额
 * 一律 CNY 分，`BIGINT UNSIGNED`，服务端按 `plan_code` 计算，绝不接受前端传入金额。
 *
 * ## 敏感信息边界
 * 不存银行卡号、支付密码、证书/密钥；回调原始数据只保留必要的交易信息
 * （`raw_notification` 由渠道适配器脱敏后写入，见 P4 §金额与安全）。
 *
 * ## 外键
 * 与全库一致，不建业务外键（软删 + 服务层行锁校验，见 001 注释）；补回所需索引。
 */
export const paymentMigration: Migration = {
  version: '018_payment',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_no VARCHAR(64) NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        plan_code VARCHAR(32) NOT NULL,
        amount_cents BIGINT UNSIGNED NOT NULL,
        channel VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL,
        channel_trade_no VARCHAR(64) NULL,
        paid_time DATETIME(3) NULL,
        expires_time DATETIME(3) NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_orders_order_no (order_no),
        KEY idx_orders_user (user_id, status, create_time),
        KEY idx_orders_trade (channel, channel_trade_no),
        CONSTRAINT chk_orders_channel CHECK (channel IN ('wechat', 'alipay')),
        CONSTRAINT chk_orders_status CHECK (status IN ('pending', 'paid', 'fulfilled', 'failed', 'refunded', 'expired'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_id BIGINT UNSIGNED NOT NULL,
        channel VARCHAR(16) NOT NULL,
        channel_trade_no VARCHAR(64) NOT NULL,
        amount_cents BIGINT UNSIGNED NOT NULL,
        raw_notification MEDIUMTEXT NULL,
        signature_verified TINYINT(1) NOT NULL DEFAULT 0,
        result VARCHAR(16) NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_payments_order (order_id, create_time),
        UNIQUE KEY uq_payments_channel_trade (channel, channel_trade_no),
        CONSTRAINT chk_payments_channel CHECK (channel IN ('wechat', 'alipay')),
        CONSTRAINT chk_payments_result CHECK (result IN ('success', 'failure', 'duplicate'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        order_id BIGINT UNSIGNED NULL,
        title VARCHAR(200) NOT NULL,
        tax_no VARCHAR(64) NULL,
        email VARCHAR(255) NOT NULL,
        amount_cents BIGINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'requested',
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_invoices_user (user_id, create_time),
        CONSTRAINT chk_invoices_status CHECK (status IN ('requested', 'issued', 'rejected'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};