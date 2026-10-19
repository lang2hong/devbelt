import type { Migration } from '../migrate.js';

/**
 * 积分制重构（2026-10-16）：换算 1 积分 = 1000 计费 token（k 固定 1.3）、四档充值、
 * Pro 订阅调整、并发分级特性。
 *
 * - SKU（充值档，token 数 = 积分 × 1000；四档 code 与 token 数全部对齐现有/历史 code，
 *   在途订单 fulfill 零影响）：
 *   - `topup_1m`（1,000,000 token = 1,000 积分，¥5，新档）；
 *   - `topup_2m`（2,000,000 = 2,000 积分，¥10，沿用改价）；
 *   - `topup_5m`（5,000,000 = 5,000 积分，¥25，新档）；
 *   - `topup_10m`（10,000,000 = 10,000 积分，¥50，沿用改价）；
 *   - 停用 `topup_500k`（500 积分不在梯子；历史订单自含金额/token）。
 * - 套餐：`pro` 价格 ¥99 → ¥8；`maxAiTokensMonthly` free 100,000 → 200,000（= 200 积分）、
 *   pro 2,000,000 → 1,000,000（= 1,000 积分；订阅期间不叠加免费额度——月度额度单源自
 *   当前套餐，天然满足）。月底清零为既有月账本行为。
 * - 新特性 `maxAiConcurrentRequests`（并发 AI 请求数）：free = 1，pro = 3。
 *   aiProxyService 以此为每用户并发闸门（进程内计数，超限 429）。
 * - 定价毛利：deepseek-v4.1-flash 忙时成本（k=1.3、4:1 配比）≈ ¥3.02/千积分 → 四档忙时
 *   毛利 40%、闲时 70%（毛利底线 30%）。
 * - 幂等：INSERT ON DUPLICATE KEY（不覆盖）/ UPDATE 限定 code / feature 值 UPDATE 收敛到目标值。
 *
 * 回滚（见 docs/迁移回滚.md）：
 * ```sql
 * DELETE FROM ai_topup_skus WHERE code IN ('topup_1m', 'topup_5m');
 * UPDATE ai_topup_skus SET label_json = '{"en":"2M tokens","zh":"200 万 tokens"}', price_cents = 2900, sort_order = 20 WHERE code = 'topup_2m';
 * UPDATE ai_topup_skus SET label_json = '{"en":"10M tokens","zh":"1000 万 tokens"}', price_cents = 9900, sort_order = 30 WHERE code = 'topup_10m';
 * UPDATE ai_topup_skus SET status = 'active' WHERE code = 'topup_500k';
 * UPDATE plans SET price_cents = 9900 WHERE code = 'pro';
 * UPDATE plan_feature_values v JOIN plan_feature_defs d ON d.id = v.feature_def_id
 *   JOIN plans p ON p.id = v.plan_id SET v.value_json = '100000'
 *   WHERE p.code = 'free' AND d.feature_key = 'maxAiTokensMonthly';
 * UPDATE plan_feature_values v JOIN plan_feature_defs d ON d.id = v.feature_def_id
 *   JOIN plans p ON p.id = v.plan_id SET v.value_json = '2000000'
 *   WHERE p.code = 'pro' AND d.feature_key = 'maxAiTokensMonthly';
 * DELETE FROM plan_feature_values v USING plan_feature_values v
 *   JOIN plan_feature_defs d ON d.id = v.feature_def_id WHERE d.feature_key = 'maxAiConcurrentRequests';
 * DELETE FROM plan_feature_defs WHERE feature_key = 'maxAiConcurrentRequests';
 * DELETE FROM schema_migrations WHERE version = '013_ai_credit_tiers';
 * ```
 */
export const aiCreditTiersMigration: Migration = {
  version: '013_ai_credit_tiers',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    // ── 充值四档（1 积分 = 1000 计费 token）──
    const NEW_TIERS: ReadonlyArray<[string, { en: string; zh: string }, number, number, number, number]> = [
      ['topup_1m', { en: '1,000 credits', zh: '1,000 积分' }, 1_000_000, 500, 365, 10],
      ['topup_5m', { en: '5,000 credits', zh: '5,000 积分' }, 5_000_000, 2_500, 365, 30],
    ];
    for (const [code, label, tokens, priceCents, validDays, sortOrder] of NEW_TIERS) {
      await db.query(
        `INSERT INTO ai_topup_skus (code, label_json, tokens, price_cents, valid_days, status, sort_order)
         VALUES (?, ?, ?, ?, ?, 'active', ?)
         ON DUPLICATE KEY UPDATE code = code`,
        [code, JSON.stringify(label), tokens, priceCents, validDays, sortOrder],
      );
    }
    // 沿用档（token 不变 → 在途订单 fulfill 零影响）：改价 + 积分口径文案。
    await db.query(
      `UPDATE ai_topup_skus
          SET label_json = ?, price_cents = 1000, sort_order = 20
        WHERE code = 'topup_2m'`,
      [JSON.stringify({ en: '2,000 credits', zh: '2,000 积分' })],
    );
    await db.query(
      `UPDATE ai_topup_skus
          SET label_json = ?, price_cents = 5000, sort_order = 40
        WHERE code = 'topup_10m'`,
      [JSON.stringify({ en: '10,000 credits', zh: '10,000 积分' })],
    );
    // 500 积分档不在新梯子：停用（不删除：历史订单/审计引用 code）。
    await db.query(`UPDATE ai_topup_skus SET status = 'disabled' WHERE code = 'topup_500k'`);

    // ── 套餐：pro ¥8/月、月度 1,000,000 计费 token（1,000 积分）；free 200,000（200 积分）──
    await db.query(`UPDATE plans SET price_cents = 800 WHERE code = 'pro'`);
    const MONTHLY: ReadonlyArray<[string, number]> = [
      ['free', 200_000],
      ['pro', 1_000_000],
    ];
    for (const [planCode, value] of MONTHLY) {
      await db.query(
        `UPDATE plan_feature_values v
            JOIN plan_feature_defs d ON d.id = v.feature_def_id
            JOIN plans p ON p.id = v.plan_id
            SET v.value_json = ?
          WHERE p.code = ? AND d.feature_key = 'maxAiTokensMonthly'`,
        [String(value), planCode],
      );
    }

    // ── 并发分级特性（free=1 / pro=3）──
    await db.query(
      `INSERT INTO plan_feature_defs (feature_key, kind, label_json, value_type, unit, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE feature_key = feature_key`,
      [
        'maxAiConcurrentRequests',
        'personal',
        JSON.stringify({ en: 'AI concurrent requests', zh: 'AI 并发请求数' }),
        'number',
        'requests',
        110,
      ],
    );
    const CONCURRENCY: ReadonlyArray<[string, number]> = [
      ['free', 1],
      ['pro', 3],
    ];
    for (const [planCode, value] of CONCURRENCY) {
      await db.query(
        `INSERT INTO plan_feature_values (plan_id, feature_def_id, value_json)
         SELECT p.id, d.id, ? FROM plans p JOIN plan_feature_defs d
          WHERE p.code = ? AND d.feature_key = ?
         ON DUPLICATE KEY UPDATE value_json = value_json`,
        [JSON.stringify(value), planCode, 'maxAiConcurrentRequests'],
      );
    }
  },
};
