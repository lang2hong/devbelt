import type { Migration } from '../migrate.js';

/**
 * 006：把 `redis` 幂等地补进 free/pro 的 `allowedDatabaseTypes`。
 *
 * 背景：`redis` 引擎权益此前被**就地写进已发布的 001 基线**。迁移账本不会重跑历史版本，
 * 因此**已应用 001 的库**永远拿不到 redis（Redis 连接同步被静默拒绝）。本迁移还原 001 的
 * 原始种子，并用一条增量迁移对**新库与存量库**统一补齐。
 *
 * 幂等：仅当值为 JSON 数组且不含 `'redis'` 时追加；重复执行是 no-op。
 *
 * 回滚（需手工 SQL，见 docs/迁移回滚.md）：
 * ```sql
 * UPDATE plan_feature_values v
 *   JOIN plans p ON p.id = v.plan_id
 *   JOIN plan_feature_defs d ON d.id = v.feature_def_id
 *    SET v.value_json = JSON_REMOVE(
 *          v.value_json,
 *          JSON_UNQUOTE(JSON_SEARCH(v.value_json, 'one', 'redis'))
 *        )
 *  WHERE d.feature_key = 'allowedDatabaseTypes'
 *    AND JSON_VALID(v.value_json)
 *    AND JSON_TYPE(v.value_json) = 'ARRAY'
 *    AND JSON_CONTAINS(v.value_json, JSON_QUOTE('redis'));
 * ```
 * 通常不需要回滚（这是只增不减的权益放宽）。
 */
export const redisEngineMigration: Migration = {
  version: '006_redis_engine',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(
      `UPDATE plan_feature_values v
         JOIN plans p ON p.id = v.plan_id
         JOIN plan_feature_defs d ON d.id = v.feature_def_id
          SET v.value_json = JSON_ARRAY_APPEND(v.value_json, '$', 'redis')
        WHERE d.feature_key = 'allowedDatabaseTypes'
          AND p.code IN ('free', 'pro')
          AND JSON_VALID(v.value_json)
          AND JSON_TYPE(v.value_json) = 'ARRAY'
          AND NOT JSON_CONTAINS(v.value_json, JSON_QUOTE('redis'))`,
    );
  },
};