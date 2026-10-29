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
 * 本迁移同时把新库种子对齐到生产长期运行的实际值（见 TARGETS 里的注释）。
 * 这些在已部署的生产上是空操作，只影响新库与测试库。
 *
 * 同步关闭后 Free 写不了任何云端记录，所以 Free 的云端配额不再生效。
 * 切勿把配额写成 0：服务端把 0 当「不限」（quotaEnabled 为 n > 0）。
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
  // 边界决策
  ['free', 'allowDataSync', false],
  ['free', 'allowConnectionImport', true],
  ['pro', 'maxDevices', 5],
  // 种子对齐：下面这些值在 001/014/002 里种下的默认值与生产长期运行的
  // 实际值不一致（Free 设备 2 对 1、Free 云端 500/32MiB 对 5/1MiB、Pro
  // 5000/256MiB 对 500/100MiB、Free 引擎缺 postgresql、Free 并发 0 对 2）。
  // 生产上是空操作，作用是让新库、测试库和线上一致。
  ['free', 'maxDevices', 1],
  ['free', 'maxConnectionMetas', 5],
  ['free', 'syncStorageBytes', 1048576],
  ['free', 'allowedDatabaseTypes', ['mysql', 'sqlite', 'redis', 'postgresql']],
  ['free', 'maxConcurrentConnections', 2],
  ['pro', 'maxConnectionMetas', 500],
  ['pro', 'syncStorageBytes', 104857600],
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
