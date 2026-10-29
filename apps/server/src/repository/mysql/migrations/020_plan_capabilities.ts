import type { Migration } from '../migrate.js';

/**
 * 020：能力边界（2026-10-29）。详见 docs/套餐边界.md。
 *
 * - `allowErDiagram`：ER 图是 Pro 能力，Free 关闭。
 * - `allowConnectionExport`：导出连接配置是 Pro 能力，Free 关闭（导入仍对 Free 开放）。
 * - `maxConcurrentConnections`：Free 同时最多 2 个连接，Pro 不限（0）。
 *
 * 这三项都是**本地能力**，服务端只负责下发取值，执行点在扩展里。因此旧版客户端
 * 不受这些限制，这是本地功能的固有限制，不是缺陷。未登录用户在客户端按 Free 处理。
 *
 * 幂等：显式写目标值，重复执行结果相同。会覆盖运营在后台对这三个键做过的手工调整。
 *
 * 回滚（生产手工 SQL）：
 * ```sql
 * UPDATE plan_feature_values v
 *   JOIN plans p ON p.id = v.plan_id
 *   JOIN plan_feature_defs d ON d.id = v.feature_def_id
 *    SET v.value_json = 'true'
 *  WHERE d.feature_key IN ('allowErDiagram', 'allowConnectionExport');
 *
 * DELETE FROM schema_migrations WHERE version = '020_plan_capabilities';
 * ```
 */
const TARGETS: ReadonlyArray<[planCode: string, featureKey: string, value: unknown]> = [
  ['free', 'allowErDiagram', false],
  ['pro', 'allowErDiagram', true],
  ['free', 'allowConnectionExport', false],
  ['pro', 'allowConnectionExport', true],
  ['free', 'maxConcurrentConnections', 2],
  ['pro', 'maxConcurrentConnections', 0],
];

export const planCapabilitiesMigration: Migration = {
  version: '020_plan_capabilities',
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
  },
};
