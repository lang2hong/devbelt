import type { Migration } from '../migrate.js';

/**
 * P9.1 · AI 加油包（增量；迁移账本只跑一次，ALTER 无需幂等）。
 *
 * - 新表 `ai_topup_skus`：多档位 SKU 目录（code 唯一；label_json/tokens/price_cents/
 *   valid_days/status/sort_order）。预置 3 档默认值（运营可改价/停用；已售订单不受影响）。
 * - 新表 `ai_quota_grants`：用户额度账本（每次 fulfillment 一行；`uq_grants_order` 唯一键
 *   = 入账幂等锚点，D17「双来源收敛到订单行后入账」）。`tokens_reserved` 承担请求期预占。
 * - `orders` 扩列：purpose('plan'|'topup')、sku_code（topup 必填）；plan_code 放宽 NULL
 *   （加油包无套餐）；channel CHECK 扩 'manual'（管理后台手工建单旁路）。
 *
 * 回滚（见 docs/迁移回滚.md；回滚前先导出 grants 资金关联数据）：
 * ```sql
 * DROP TABLE ai_quota_grants;
 * DROP TABLE ai_topup_skus;
 * ALTER TABLE orders DROP CHECK chk_orders_topup;
 * ALTER TABLE orders DROP CHECK chk_orders_purpose;
 * ALTER TABLE orders DROP KEY idx_orders_purpose;
 * ALTER TABLE orders DROP CHECK chk_orders_channel;
 * ALTER TABLE orders ADD CONSTRAINT chk_orders_channel CHECK (channel IN ('wechat', 'alipay'));
 * ALTER TABLE orders DROP COLUMN sku_code;
 * ALTER TABLE orders DROP COLUMN purpose;
 * ALTER TABLE orders MODIFY COLUMN plan_code VARCHAR(32) NOT NULL;
 * ```
 */
export const aiTopupMigration: Migration = {
  version: '009_ai_topup',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_topup_skus (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(32) NOT NULL,
        label_json JSON NOT NULL,
        tokens BIGINT UNSIGNED NOT NULL,
        price_cents BIGINT UNSIGNED NOT NULL,
        valid_days INT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        sort_order INT NOT NULL DEFAULT 0,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_topup_skus_code (code),
        KEY idx_topup_skus_status (status, sort_order),
        CONSTRAINT chk_topup_skus_status CHECK (status IN ('active', 'disabled'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 预置 3 档默认 SKU（幂等：不覆盖运营已调整的价格/文案/状态）。
    const SKUS: ReadonlyArray<[string, { en: string; zh: string }, number, number, number, number]> = [
      ['topup_500k', { en: '500K tokens', zh: '50 万 tokens' }, 500_000, 900, 365, 10],
      ['topup_2m', { en: '2M tokens', zh: '200 万 tokens' }, 2_000_000, 2900, 365, 20],
      ['topup_10m', { en: '10M tokens', zh: '1000 万 tokens' }, 10_000_000, 9900, 365, 30],
    ];
    for (const [code, label, tokens, priceCents, validDays, sortOrder] of SKUS) {
      await db.query(
        `INSERT INTO ai_topup_skus (code, label_json, tokens, price_cents, valid_days, status, sort_order)
         VALUES (?, ?, ?, ?, ?, 'active', ?)
         ON DUPLICATE KEY UPDATE code = code`,
        [code, JSON.stringify(label), tokens, priceCents, validDays, sortOrder],
      );
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_quota_grants (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        order_id BIGINT UNSIGNED NOT NULL,
        sku_code VARCHAR(32) NOT NULL,
        tokens_total BIGINT UNSIGNED NOT NULL,
        tokens_used BIGINT UNSIGNED NOT NULL DEFAULT 0,
        tokens_reserved BIGINT UNSIGNED NOT NULL DEFAULT 0,
        expires_time DATETIME(3) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_grants_order (order_id),
        KEY idx_grants_user (user_id, status, expires_time),
        CONSTRAINT fk_grants_user FOREIGN KEY (user_id) REFERENCES users(id),
        CONSTRAINT fk_grants_order FOREIGN KEY (order_id) REFERENCES orders(id),
        CONSTRAINT chk_grants_status CHECK (status IN ('active', 'exhausted', 'expired', 'refunded'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // orders 扩列：purpose/sku_code；plan_code 放宽 NULL；channel 扩 'manual'。
    await db.query(`ALTER TABLE orders MODIFY COLUMN plan_code VARCHAR(32) NULL`);
    await db.query(`ALTER TABLE orders ADD COLUMN purpose VARCHAR(16) NOT NULL DEFAULT 'plan' AFTER user_id`);
    await db.query(`ALTER TABLE orders ADD COLUMN sku_code VARCHAR(32) NULL AFTER plan_version`);
    await db.query(`ALTER TABLE orders DROP CHECK chk_orders_channel`);
    await db.query(
      `ALTER TABLE orders ADD CONSTRAINT chk_orders_channel CHECK (channel IN ('wechat', 'alipay', 'manual'))`,
    );
    await db.query(
      `ALTER TABLE orders ADD CONSTRAINT chk_orders_purpose CHECK (purpose IN ('plan', 'topup'))`,
    );
    await db.query(
      `ALTER TABLE orders ADD CONSTRAINT chk_orders_topup CHECK (purpose <> 'topup' OR sku_code IS NOT NULL)`,
    );
    await db.query(`ALTER TABLE orders ADD KEY idx_orders_purpose (purpose, status)`);
  },
};