import type { Migration } from '../migrate.js';

/**
 * P9 · AI 月额度（增量，幂等）。
 *
 * - feature_key: `maxAiTokensMonthly`（number，个人档；0 = 拒绝，AI 无"不限"档）
 * - 默认值：free=100_000（基于 schema 3-4K 预算 ≈ 15–20 次），pro=2_000_000（≈ 300–400 次）
 * - 新表 `ai_token_usage`：按 (user_id, usage_month) 分桶的单段月额度账本，
 *   `reserved_*` 支持请求期预占 + finish 对账（防并发超发）；列名用 `usage_month`
 *   而非 `year_month`（后者与 MySQL 的 `YEAR_MONTH` INTERVAL 单位同名易致困惑）。
 *
 * 幂等：defs 用 `ON DUPLICATE KEY UPDATE feature_key = feature_key`（不覆盖运营已调过的
 * label/unit/sortOrder）；values 用 `ON DUPLICATE KEY UPDATE value_json = value_json`
 * （不覆盖运营已调整的配额）；建表 `IF NOT EXISTS`。
 *
 * 回滚（见 docs/迁移回滚.md）：DROP TABLE ai_token_usage + 删除
 * plan_feature_values（按 feature_key 关联）/ plan_feature_defs 中的 maxAiTokensMonthly 行。
 */
export const aiQuotaMigration: Migration = {
  version: '008_ai_quota',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(
      `INSERT INTO plan_feature_defs (feature_key, kind, label_json, value_type, unit, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE feature_key = feature_key`,
      [
        'maxAiTokensMonthly',
        'personal',
        JSON.stringify({ en: 'AI tokens (monthly)', zh: 'AI 额度（每月）' }),
        'number',
        'tokens',
        100,
      ],
    );

    const VALUES: ReadonlyArray<[string, number]> = [
      ['free', 100_000],
      ['pro', 2_000_000],
    ];
    for (const [planCode, value] of VALUES) {
      await db.query(
        `INSERT INTO plan_feature_values (plan_id, feature_def_id, value_json)
         SELECT p.id, d.id, ? FROM plans p JOIN plan_feature_defs d
          WHERE p.code = ? AND d.feature_key = ?
         ON DUPLICATE KEY UPDATE value_json = value_json`,
        [JSON.stringify(value), planCode, 'maxAiTokensMonthly'],
      );
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_token_usage (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        usage_month CHAR(7) NOT NULL,
        prompt_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
        completion_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
        reserved_prompt_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
        reserved_completion_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
        request_count INT UNSIGNED NOT NULL DEFAULT 0,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uk_user_month (user_id, usage_month),
        INDEX idx_month (usage_month)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};