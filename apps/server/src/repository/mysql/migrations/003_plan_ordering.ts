import type { Migration } from '../migrate.js';

/**
 * 规范化套餐特性的展示排序（增量、幂等）。
 *
 * 此前 `plan_feature_defs` 读取按 `kind` 字母序排，会插错观感。这里统一改为按
 * **sort_order 为主序**：引擎 → 本机连接资产 → 能力开关 → 云端配额 → 设备。
 *
 * 只更新排序值（`WHERE feature_key = ?`），不触碰类型/标签/取值；重复执行无副作用。
 */
const ORDER: ReadonlyArray<[string, number]> = [
  // 引擎白名单
  ['allowedDatabaseTypes', 10],
  // 本机连接资产
  ['maxSavedConnections', 20],
  ['maxConcurrentConnections', 30],
  ['allowConnectionExport', 40],
  ['allowConnectionImport', 45],
  // 能力开关
  ['allowErDiagram', 50],
  ['allowDataSync', 60],
  // 云端配额
  ['maxConnectionMetas', 70],
  ['syncStorageBytes', 80],
  // 设备
  ['maxDevices', 100],
];

export const planOrderingMigration: Migration = {
  version: '003_plan_ordering',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    for (const [key, sortOrder] of ORDER) {
      await db.query('UPDATE plan_feature_defs SET sort_order = ? WHERE feature_key = ?', [sortOrder, key]);
    }
  },
};