import type { Migration } from '../migrate.js';

/**
 * 付费档位目录（个人 pro + 组织 team）。
 *
 * ## 数值语义
 *
 * `max_devices` / `max_connection_metas` / `sync_storage_bytes` /
 * `max_shared_resources` / `shared_storage_quota_bytes` 一律以 **0 表示不限**
 * （消费侧都是 `if (limit > 0)` 才启用配额判定，见 authService.upsertDevice 与
 * syncRecordService.assertRecordQuota / organizationResourceService.assertResourceQuota）。
 * 因此把某项调成 0 是「放开」而不是「禁止」，改动时务必留意。
 *
 * ## 引擎白名单只有三个取值
 *
 * 客户端只认 `mysql` / `postgresql` / `sqlite`（vscode-ext 的 entitlementGate 里
 * ENGINE_BY_DB_TYPE 就这三项，且未知引擎 fail-closed 判为不允许）。
 * 免费档已给 mysql+sqlite，所以引擎维度上付费档唯一能解锁的就是 **postgresql**。
 * 写入其它字符串不会报错，但客户端一律视为不允许，等于无效配置。
 *
 * ## 幂等策略
 *
 * 与 002 / 005 一致：`ON DUPLICATE KEY UPDATE` 只更新 `name`，**不覆盖配额列**。
 * 迁移只负责首次播种；运维后续在库里调过的配额不会被重跑冲掉。
 * 反过来说，改了本文件里的配额数值对已存在的行**不生效** —— 那属于运营调整，
 * 应直接改库或走后台，不要靠改迁移。
 *
 * ## 一个尚未打通的环节
 *
 * 目前没有任何代码路径能把用户/组织分配到付费档：
 * 注册固定取 `code='free'`（registrationRepo），建组织固定取 `organization_free`
 * （organizationService）。所以这两行在计费或后台改档能力落地之前，只是**目录数据**，
 * 不会自动生效。补齐时注意：`personal_subscriptions.entitlement_snapshot` 是注册时
 * 冻结的快照，换档必须同时重写该快照，否则权益不变。
 */

/** 客户端支持的全部引擎（付费档解锁 postgresql）。 */
const ALL_ENGINES = ['mysql', 'postgresql', 'sqlite'] as const;

const PERSONAL_PRO = {
  code: 'pro',
  name: 'Pro',
  allowedDatabaseTypes: ALL_ENGINES,
  /**
   * 0 = 不限设备数。
   * 注意免费档当前也是 0（同样不限），所以**设备数眼下不是档位差异点**。
   * 若要把它变成差异点，需先给 free 一个正数上限 —— 那是运营决策，且只影响
   * 新注册用户（老用户的 entitlement_snapshot 已冻结），故此处不擅自改动 free。
   */
  maxDevices: 0,
  /** free 为 500。 */
  maxConnectionMetas: 5000,
  /** free 为 32 MiB。此处 256 MiB。 */
  syncStorageBytes: 268435456,
  /** free 为 10。连接资产差异点：本机可保存连接数。 */
  maxSavedConnections: 100,
  /** free 为 0（禁止导入连接配置）。pro 放开。 */
  allowConnectionImport: 1,
} as const;

const ORGANIZATION_TEAM = {
  code: 'organization_team',
  name: 'Organization Team',
  /** free 为 3。included_seats 有 CHECK >= 1。 */
  includedSeats: 10,
  /** free 为 50。列是 SMALLINT UNSIGNED，上限 65535。 */
  maxSharedResources: 500,
  /** free 为 10 MiB。此处 100 MiB。 */
  sharedStorageQuotaBytes: 104857600,
  allowedTemplateDatabaseTypes: ALL_ENGINES,
} as const;

export const seedPaidPlansMigration: Migration = {
  version: '010_seed_paid_plans',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(
      `INSERT INTO personal_plans
         (code, name, allowed_database_types, max_devices, max_connection_metas, sync_storage_bytes, max_saved_connections, allow_connection_import, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [
        PERSONAL_PRO.code,
        PERSONAL_PRO.name,
        JSON.stringify(PERSONAL_PRO.allowedDatabaseTypes),
        PERSONAL_PRO.maxDevices,
        PERSONAL_PRO.maxConnectionMetas,
        PERSONAL_PRO.syncStorageBytes,
        PERSONAL_PRO.maxSavedConnections,
        PERSONAL_PRO.allowConnectionImport,
      ],
    );

    await db.query(
      `INSERT INTO organization_plans
         (code, name, included_seats, max_shared_resources, shared_storage_quota_bytes, allowed_template_database_types, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [
        ORGANIZATION_TEAM.code,
        ORGANIZATION_TEAM.name,
        ORGANIZATION_TEAM.includedSeats,
        ORGANIZATION_TEAM.maxSharedResources,
        ORGANIZATION_TEAM.sharedStorageQuotaBytes,
        JSON.stringify(ORGANIZATION_TEAM.allowedTemplateDatabaseTypes),
      ],
    );
  },
};
