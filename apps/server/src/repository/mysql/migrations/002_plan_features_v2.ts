import type { Migration } from '../migrate.js';

/**
 * 套餐特性目录扩展（增量，幂等）：新增个人档 4 个特性维度。
 *
 * - `maxConcurrentConnections`（number）：可同时打开的连接数；0 = 不限（仅扩展侧执行）。
 * - `allowConnectionExport`（bool）：是否允许导出连接配置。
 * - `allowErDiagram`（bool）：是否允许 ER 图。
 * - `allowDataSync`（bool）：是否允许「表/数据库数据的同步」。
 *
 * ## 默认值
 *
 * free 与 pro 默认均为**不限制**（0 / true），保持现状行为不变；运营可在控制台按档收紧。
 * 幂等：defs 用 `ON DUPLICATE KEY UPDATE`（按 feature_key）；values 用主键 `(plan_id, feature_def_id)`
 * 的 `ON DUPLICATE KEY UPDATE`，重复执行不产生副作用、也不覆盖运营已调整的值 ——
 * 因此这里仅在**不存在**时插入（见下方 INSERT ... WHERE NOT EXISTS 语义由主键冲突兜住）。
 */
interface FeatureDefSeed {
  key: string;
  kind: 'personal' | 'organization' | 'both';
  labelEn: string;
  labelZh: string;
  valueType: 'bool' | 'number' | 'bytes' | 'stringList' | 'enum';
  unit: string | null;
  sortOrder: number;
}

const DEFS: readonly FeatureDefSeed[] = [
  { key: 'maxConcurrentConnections', kind: 'personal', labelEn: 'Concurrent connections', labelZh: '并发连接数', valueType: 'number', unit: 'count', sortOrder: 65 },
  { key: 'allowConnectionExport', kind: 'personal', labelEn: 'Export connections', labelZh: '导出连接配置', valueType: 'bool', unit: null, sortOrder: 70 },
  { key: 'allowErDiagram', kind: 'personal', labelEn: 'ER diagram', labelZh: 'ER 图', valueType: 'bool', unit: null, sortOrder: 80 },
  { key: 'allowDataSync', kind: 'personal', labelEn: 'Data sync', labelZh: '数据同步', valueType: 'bool', unit: null, sortOrder: 90 },
];

/** free/pro 默认值：不限制。 */
const VALUES: ReadonlyArray<[string, string, unknown]> = [
  ['free', 'maxConcurrentConnections', 0],
  ['pro', 'maxConcurrentConnections', 0],
  ['free', 'allowConnectionExport', true],
  ['pro', 'allowConnectionExport', true],
  ['free', 'allowErDiagram', true],
  ['pro', 'allowErDiagram', true],
  ['free', 'allowDataSync', true],
  ['pro', 'allowDataSync', true],
];

export const planFeaturesV2Migration: Migration = {
  version: '002_plan_features_v2',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    for (const def of DEFS) {
      await db.query(
        `INSERT INTO plan_feature_defs (feature_key, kind, label_json, value_type, unit, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE feature_key = feature_key`,
        [def.key, def.kind, JSON.stringify({ en: def.labelEn, zh: def.labelZh }), def.valueType, def.unit, def.sortOrder],
      );
    }

    for (const [planCode, featureKey, value] of VALUES) {
      await db.query(
        `INSERT INTO plan_feature_values (plan_id, feature_def_id, value_json)
         SELECT p.id, d.id, ? FROM plans p JOIN plan_feature_defs d
          WHERE p.code = ? AND d.feature_key = ?
         ON DUPLICATE KEY UPDATE value_json = value_json`,
        [JSON.stringify(value), planCode, featureKey],
      );
    }
  },
};