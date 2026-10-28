import type { Migration } from '../migrate.js';

/**
 * 014：会员权益调整（2026-10-28）。
 *
 * - Pro 的 `allowedDatabaseTypes` 增加 `elasticsearch`（恢复 ES 连接的个人同步入站）。
 * - `maxDevices` 从「不限」（0）改为：free = 2 台、pro = 5 台。
 *   服务端登录时 `upsertDevice` 超限返回 403 PERSONAL_FEATURE_REQUIRED；
 *   客户端把该错误映射为本地化提示，并引导到账户中心注销设备。
 *
 * 幂等：仅在目标值不满足时收敛（可重复执行）。
 *
 * 回滚（生产手工 SQL）：
 * ```sql
 * UPDATE plan_feature_values v
 *   JOIN plans p ON p.id = v.plan_id
 *   JOIN plan_feature_defs d ON d.id = v.feature_def_id
 *    SET v.value_json = JSON_REMOVE(
 *          v.value_json,
 *          JSON_UNQUOTE(JSON_SEARCH(v.value_json, 'one', 'elasticsearch'))
 *        )
 *  WHERE d.feature_key = 'allowedDatabaseTypes'
 *    AND p.code = 'pro'
 *    AND JSON_CONTAINS(v.value_json, JSON_QUOTE('elasticsearch'));
 *
 * UPDATE plan_feature_values v
 *   JOIN plans p ON p.id = v.plan_id
 *   JOIN plan_feature_defs d ON d.id = v.feature_def_id
 *    SET v.value_json = '0'
 *  WHERE d.feature_key = 'maxDevices' AND p.code IN ('free', 'pro');
 *
 * DELETE FROM schema_migrations WHERE version = '014_plan_engines_devices';
 * ```
 */
export const planEnginesDevicesMigration: Migration = {
  version: '014_plan_engines_devices',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    // 1) Pro 增加 elasticsearch（数组幂等追加）。
    await db.query(
      `UPDATE plan_feature_values v
         JOIN plans p ON p.id = v.plan_id
         JOIN plan_feature_defs d ON d.id = v.feature_def_id
          SET v.value_json = JSON_ARRAY_APPEND(v.value_json, '$', 'elasticsearch')
        WHERE d.feature_key = 'allowedDatabaseTypes'
          AND p.code = 'pro'
          AND JSON_VALID(v.value_json)
          AND JSON_TYPE(v.value_json) = 'ARRAY'
          AND NOT JSON_CONTAINS(v.value_json, JSON_QUOTE('elasticsearch'))`,
    );

    // 2) 设备数：free 2 台 / pro 5 台（仅把「不限 = 0」收敛为目标值，避免覆盖运营已改值）。
    await db.query(
      `UPDATE plan_feature_values v
         JOIN plans p ON p.id = v.plan_id
         JOIN plan_feature_defs d ON d.id = v.feature_def_id
          SET v.value_json = '2'
        WHERE d.feature_key = 'maxDevices'
          AND p.code = 'free'
          AND (v.value_json = '0' OR v.value_json = 'null')`,
    );
    await db.query(
      `UPDATE plan_feature_values v
         JOIN plans p ON p.id = v.plan_id
         JOIN plan_feature_defs d ON d.id = v.feature_def_id
          SET v.value_json = '5'
        WHERE d.feature_key = 'maxDevices'
          AND p.code = 'pro'
          AND (v.value_json = '0' OR v.value_json = 'null')`,
    );
  },
};