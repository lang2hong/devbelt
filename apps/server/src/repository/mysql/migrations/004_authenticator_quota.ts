import type { Migration } from '../migrate.js';

/**
 * P5 · 验证器条目配额（增量，幂等）。
 *
 * - feature_key: `maxAuthenticatorEntries`（number，个人档）
 * - 默认值：free=10，pro=1000
 *
 * 幂等：defs 用 `ON DUPLICATE KEY UPDATE feature_key = feature_key`（不覆盖运营已调过的 label/unit/sortOrder）；
 *       values 用 `ON DUPLICATE KEY UPDATE value_json = value_json`（不覆盖运营已调整的配额值）。
 */

export const authenticatorQuotaMigration: Migration = {
  version: '004_authenticator_quota',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(
      `INSERT INTO plan_feature_defs (feature_key, kind, label_json, value_type, unit, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE feature_key = feature_key`,
      [
        'maxAuthenticatorEntries',
        'personal',
        JSON.stringify({ en: 'Authenticator entries', zh: '验证器条目' }),
        'number',
        'count',
        95,
      ],
    );

    const VALUES: ReadonlyArray<[string, number]> = [
      ['free', 10],
      ['pro', 1000],
    ];
    for (const [planCode, value] of VALUES) {
      await db.query(
        `INSERT INTO plan_feature_values (plan_id, feature_def_id, value_json)
         SELECT p.id, d.id, ? FROM plans p JOIN plan_feature_defs d
          WHERE p.code = ? AND d.feature_key = ?
         ON DUPLICATE KEY UPDATE value_json = value_json`,
        [JSON.stringify(value), planCode, 'maxAuthenticatorEntries'],
      );
    }
  },
};
