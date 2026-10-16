import type { Migration } from '../migrate.js';

/**
 * AI 计费引擎（2026-10-16）：模型计价 + 计费设置——「统一 token 口径」的配置事实源。
 *
 * - `ai_model_pricing`：按模型计价行（model 唯一；provider_code 仅关联厂商目录展示用；
 *   input/output_cents_per_m = 每百万 token 的**分**价；weight_override 为统一 token 的
 *   输出权重 k，NULL = 由单价推导（output ÷ input，input=0 时回退 1））。
 * - `ai_billing_settings`（单行 id=1）：激活模型 + 上游连接（base_url / api_key）+ 全局
 *   调整系数（实际计费 ÷ 真实消耗，默认 1）。**api_key 只写不读**：任何 GET 仅回
 *   configured/尾号提示，不回明文；审计只记变更不记值。全部缺省时回退 env（现状兼容）。
 * - 计费公式：计费 token = (输入 + 输出 × k) × 系数；预占与结算同口径。
 *
 * 回滚（见 docs/迁移回滚.md）：
 * ```sql
 * DROP TABLE ai_model_pricing;
 * DROP TABLE ai_billing_settings;
 * DELETE FROM schema_migrations WHERE version = '011_ai_model_pricing';
 * ```
 */
export const aiModelPricingMigration: Migration = {
  version: '011_ai_model_pricing',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_model_pricing (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        model VARCHAR(128) NOT NULL,
        provider_code VARCHAR(32) NULL,
        input_cents_per_m INT UNSIGNED NOT NULL DEFAULT 0,
        output_cents_per_m INT UNSIGNED NOT NULL DEFAULT 0,
        weight_override DECIMAL(10,4) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_ai_model_pricing_model (model),
        KEY idx_ai_model_pricing_status (status),
        CONSTRAINT chk_ai_model_pricing_status CHECK (status IN ('active', 'disabled')),
        CONSTRAINT chk_ai_model_pricing_weight CHECK (weight_override IS NULL OR (weight_override >= 0.01 AND weight_override <= 100))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_billing_settings (
        id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        active_model VARCHAR(128) NULL,
        upstream_base_url VARCHAR(255) NULL,
        upstream_api_key VARCHAR(512) NULL,
        global_multiplier DECIMAL(10,4) NOT NULL DEFAULT 1.0000,
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT chk_ai_billing_multiplier CHECK (global_multiplier >= 0.01 AND global_multiplier <= 100)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
