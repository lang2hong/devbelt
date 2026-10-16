import type { Migration } from '../migrate.js';

/**
 * 积分化与多模型计费（2026-10-16）：每模型倍率 + 成本测算假设 + 请求流水 + 原始 token 账本。
 *
 * - `ai_model_pricing.multiplier_override`：每模型计费倍率（NULL = 用全局 global_multiplier）。
 *   生效规则：upstream() 解析为 `multiplier_override ?? global_multiplier`。
 * - `ai_billing_settings.typical_output_ratio`：成本**测算**的典型输出占比（0-1，默认 0.2）。
 *   仅用于管理端「每积分成本/毛利率」测算列，不参与真实扣费/统计。
 * - `ai_request_log`：每笔 AI 请求一行（结算事务内写入）。存计量与金额快照（原始/计费 token、
 *   当时 k 与倍率、当时成本），**不存对话文本**。区间毛利统计从本表聚合（历史精确值）。
 *   保留 180 天（retentionCleanup 分批物理删除）；月账本 ai_token_usage 不受影响。
 * - `ai_token_usage` 补原始 token 两列（raw_prompt/raw_completion）：修复既有口径 bug——
 *   原本只存计费 token，财务月报把它当原始 token 使用导致成本高估（输出部分多乘 k）。
 *   存量行回填 `raw = 计费`（近似；k=1 时等值，docs 标注切换点）。
 *
 * 回滚（见 docs/迁移回滚.md）：
 * ```sql
 * ALTER TABLE ai_model_pricing DROP COLUMN multiplier_override;
 * ALTER TABLE ai_billing_settings DROP COLUMN typical_output_ratio;
 * ALTER TABLE ai_token_usage DROP COLUMN raw_prompt_tokens, DROP COLUMN raw_completion_tokens;
 * DROP TABLE ai_request_log;
 * DELETE FROM schema_migrations WHERE version = '012_ai_credits_billing';
 * ```
 */
export const aiCreditsBillingMigration: Migration = {
  version: '012_ai_credits_billing',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(`
      ALTER TABLE ai_model_pricing
        ADD COLUMN multiplier_override DECIMAL(10,4) NULL AFTER weight_override,
        ADD CONSTRAINT chk_ai_model_pricing_multiplier CHECK (multiplier_override IS NULL OR (multiplier_override >= 0.01 AND multiplier_override <= 100))
    `);

    await db.query(`
      ALTER TABLE ai_billing_settings
        ADD COLUMN typical_output_ratio DECIMAL(5,4) NOT NULL DEFAULT 0.2000 AFTER global_multiplier,
        ADD CONSTRAINT chk_ai_billing_output_ratio CHECK (typical_output_ratio > 0 AND typical_output_ratio < 1)
    `);

    await db.query(`
      ALTER TABLE ai_token_usage
        ADD COLUMN raw_prompt_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER completion_tokens,
        ADD COLUMN raw_completion_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER raw_prompt_tokens
    `);
    // 存量回填：历史行只有计费 token；k=1 时与原始等值，其余为近似（docs 标注）。
    await db.query(`
      UPDATE ai_token_usage
         SET raw_prompt_tokens = prompt_tokens,
             raw_completion_tokens = completion_tokens
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_request_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        usage_month CHAR(7) NOT NULL,
        model VARCHAR(128) NOT NULL,
        request_id VARCHAR(64) NULL,
        raw_prompt_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
        raw_completion_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
        billing_prompt_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
        billing_completion_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
        weight DECIMAL(10,4) NOT NULL DEFAULT 1,
        multiplier DECIMAL(10,4) NOT NULL DEFAULT 1,
        cost_cents INT UNSIGNED NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'completed',
        usage_estimated TINYINT(1) NOT NULL DEFAULT 0,
        latency_ms INT UNSIGNED NOT NULL DEFAULT 0,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_ai_request_log_user (user_id, id),
        KEY idx_ai_request_log_month_model (usage_month, model),
        CONSTRAINT chk_ai_request_log_status CHECK (status IN ('completed', 'failed', 'aborted'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
