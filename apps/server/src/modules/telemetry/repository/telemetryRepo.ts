import type { MysqlDb } from '../../../repository/mysql/db.js';
import type {
  ITelemetryRepo,
  TelemetryHeartbeat,
  TelemetryOverview,
} from '../../../repository/interfaces/telemetry.js';

/**
 * 扩展安装/活跃仓储（016）。
 *
 * - `record` 以 `install_id` 为幂等键：首次插入写 `first_seen`，后续只更新
 *   `last_seen`/版本/平台字段。
 * - `overview` 全部用 `UTC_TIMESTAMP()`，避免服务器/会话时区不同导致窗口偏移。
 */
export class MysqlTelemetryRepo implements ITelemetryRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async record(input: TelemetryHeartbeat): Promise<void> {
    await this.db().query(
      `INSERT INTO extension_installs
         (install_id, first_seen, last_seen, first_version, last_version, os, arch, is_remote)
       VALUES (?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         last_seen = VALUES(last_seen),
         last_version = VALUES(last_version),
         os = VALUES(os),
         arch = VALUES(arch),
         is_remote = VALUES(is_remote)`,
      [
        input.installId,
        input.appVersion,
        input.appVersion,
        input.os,
        input.arch,
        input.isRemote ? 1 : 0,
      ],
    );
  }

  async overview(): Promise<TelemetryOverview> {
    const result = (await this.db().query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(first_seen >= UTC_TIMESTAMP() - INTERVAL 7 DAY), 0) AS new7d,
              COALESCE(SUM(first_seen >= UTC_TIMESTAMP() - INTERVAL 30 DAY), 0) AS new30d,
              COALESCE(SUM(last_seen >= UTC_TIMESTAMP() - INTERVAL 24 HOUR), 0) AS active24h,
              COALESCE(SUM(last_seen >= UTC_TIMESTAMP() - INTERVAL 7 DAY), 0) AS active7d,
              COALESCE(SUM(last_seen >= UTC_TIMESTAMP() - INTERVAL 30 DAY), 0) AS active30d
         FROM extension_installs`,
    )) as unknown as [Array<Record<string, unknown>>, unknown];
    const row = (Array.isArray(result) ? result[0]?.[0] : undefined) ?? {};
    const num = (v: unknown): number => Number(v ?? 0);
    return {
      totalInstalls: num(row.total),
      newInstalls7d: num(row.new7d),
      newInstalls30d: num(row.new30d),
      active24h: num(row.active24h),
      active7d: num(row.active7d),
      active30d: num(row.active30d),
    };
  }
}