import type { MysqlDb } from '../../../repository/mysql/db.js';
import type {
  ITelemetryRepo,
  TelemetryDailyPoint,
  TelemetryHeartbeat,
  TelemetryOverview,
} from '../../../repository/interfaces/telemetry.js';

type Rec = Record<string, unknown>;

/** mysql2 `query` 返回 `[rows, fields]`；结果集取首段。 */
function rowsOf(result: unknown): Rec[] {
  const r = result as [unknown, unknown];
  return Array.isArray(r) && Array.isArray(r[0]) ? (r[0] as Rec[]) : [];
}

/** DATE 列在 mysql2 下可能是 Date 也可能是字符串；统一成 `YYYY-MM-DD`。 */
function dayKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

/** 近 30 天（含今天）的 UTC 日期键，从旧到新。 */
function last30DaysUtc(now = new Date()): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: string[] = [];
  for (let i = 29; i >= 0; i--) {
    out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * 扩展安装/活跃仓储（016/018）。
 *
 * - `record` 以 `install_id` 为幂等键：首次插入写 `first_seen`，后续只更新
 *   `last_seen`/版本/平台字段；同时按天写入 `extension_active_days`（INSERT IGNORE 去重）。
 * - `overview` 全部用 UTC 日期，避免服务器/会话时区不同导致窗口偏移。
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
    // 同一天重复心跳/多窗口同时发都只留一行；跨天自然新增。
    await this.db().query(
      `INSERT IGNORE INTO extension_active_days (install_id, active_day) VALUES (?, UTC_DATE())`,
      [input.installId],
    );
  }

  async overview(): Promise<TelemetryOverview> {
    const db = this.db();
    const totals = rowsOf(await db.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(first_seen >= UTC_TIMESTAMP() - INTERVAL 7 DAY), 0) AS new7d,
              COALESCE(SUM(first_seen >= UTC_TIMESTAMP() - INTERVAL 30 DAY), 0) AS new30d,
              COALESCE(SUM(last_seen >= UTC_TIMESTAMP() - INTERVAL 24 HOUR), 0) AS active24h,
              COALESCE(SUM(last_seen >= UTC_TIMESTAMP() - INTERVAL 7 DAY), 0) AS active7d,
              COALESCE(SUM(last_seen >= UTC_TIMESTAMP() - INTERVAL 30 DAY), 0) AS active30d
         FROM extension_installs`,
    ))[0] ?? {};

    const newRows = rowsOf(await db.query(
      `SELECT DATE(first_seen) AS day, COUNT(*) AS n
         FROM extension_installs
        WHERE first_seen >= UTC_DATE() - INTERVAL 29 DAY
        GROUP BY DATE(first_seen)`,
    ));
    const activeRows = rowsOf(await db.query(
      `SELECT active_day AS day, COUNT(*) AS n
         FROM extension_active_days
        WHERE active_day >= UTC_DATE() - INTERVAL 29 DAY
        GROUP BY active_day`,
    ));

    const newByDay = new Map(newRows.map((r) => [dayKey(r.day), num(r.n)]));
    const activeByDay = new Map(activeRows.map((r) => [dayKey(r.day), num(r.n)]));
    const daily: TelemetryDailyPoint[] = last30DaysUtc().map((day) => ({
      day,
      newInstalls: newByDay.get(day) ?? 0,
      activeInstalls: activeByDay.get(day) ?? 0,
    }));

    return {
      totalInstalls: num(totals.total),
      newInstalls7d: num(totals.new7d),
      newInstalls30d: num(totals.new30d),
      active24h: num(totals.active24h),
      active7d: num(totals.active7d),
      active30d: num(totals.active30d),
      daily,
    };
  }
}