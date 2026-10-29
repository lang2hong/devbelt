import type { Migration } from '../migrate.js';

/**
 * 019：Free / Pro 能力边界收敛（2026-10-29）。详见 docs/套餐边界.md。
 *
 * - Free 的 `allowDataSync` 关闭：跨设备同步是 Pro 能力（服务端 assertRecordQuota 强制）。
 * - Free 的 `allowConnectionImport` 开放：导入是迁移入口，限制它只会挡住新用户。
 * - Pro 的 `maxDevices` 由「不限」（0）改为 5。
 * - `maxConnectionMetas` 的标签改为「云端同步记录数」：该计数覆盖所有同步记录
 *   （连接、分组、查询、文件夹、验证器、注记、AI 配置），不只是连接。
 *
 * Free 的 `maxDevices`（1）、`maxConnectionMetas`（5）、`syncStorageBytes`（1 MiB）保持不变。
 * 同步关闭后 Free 写不了任何云端记录，这两项配额不再生效。切勿把配额写成 0：
 * 服务端把 0 当「不限」（quotaEnabled 为 n > 0）。
 *
 * 与 014 不同，这里是**显式收敛到目标值**，会覆盖运营在后台对这三个值做过的手工调整。
 * 部署前请确认后台没有对它们做过有意的修改。
 *
 * 幂等：重复执行结果相同。
 *
 * 回滚（生产手工 SQL）：
 * ```sql
 * UPDATE plan_feature_values v
 *   JOIN plans p ON p.id = v.plan_id
 *   JOIN plan_feature_defs d ON d.id = v.feature_def_id
 *    SET v.value_json = CASE
 *      WHEN p.code = 'free' AND d.feature_key = 'allowDataSync' THEN 'true'
 *      WHEN p.code = 'free' AND d.feature_key = 'allowConnectionImport' THEN 'false'
 *      WHEN p.code = 'pro'  AND d.feature_key = 'maxDevices' THEN '0'
 *    END
 *  WHERE (p.code = 'free' AND d.feature_key IN ('allowDataSync', 'allowConnectionImport'))
 *     OR (p.code = 'pro'  AND d.feature_key = 'maxDevices');
 *
 * UPDATE plan_feature_defs
 *    SET label_json = '{"en":"Cloud connection metadata","zh":"云端连接元数据"}'
 *  WHERE feature_key = 'maxConnectionMetas';
 *
 * DELETE FROM schema_migrations WHERE version = '019_plan_boundaries';
 * ```
 */
const TARGETS: ReadonlyArray<[planCode: string, featureKey: string, value: unknown]> = [
  ['free', 'allowDataSync', false],
  ['free', 'allowConnectionImport', true],
  ['pro', 'maxDevices', 5],
];

export const planBoundariesMigration: Migration = {
  version: '019_plan_boundaries',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    for (const [planCode, featureKey, value] of TARGETS) {
      await db.query(
        `UPDATE plan_feature_values v
           JOIN plans p ON p.id = v.plan_id
           JOIN plan_feature_defs d ON d.id = v.feature_def_id
            SET v.value_json = ?
          WHERE p.code = ? AND d.feature_key = ?`,
        [JSON.stringify(value), planCode, featureKey],
      );
    }

    await db.query(
      `UPDATE plan_feature_defs SET label_json = ? WHERE feature_key = 'maxConnectionMetas'`,
      [JSON.stringify({ en: 'Cloud sync records', zh: '云端同步记录数' })],
    );
  },
};
