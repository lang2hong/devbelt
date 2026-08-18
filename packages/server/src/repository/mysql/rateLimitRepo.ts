import type { AllowlistRow, IRateLimitRepo, RateLimitRuleRow } from '../interfaces.js';
import type { MysqlDb } from './db.js';

/**
 * 限流配置仓储：rate_limit_rules（阈值覆盖）+ rate_limit_allowlist（免限流 IP）。
 *
 * 这两张表都很小（桶数个位数、白名单十几行），全表扫描即可，无需索引优化。
 */
export class MysqlRateLimitRepo implements IRateLimitRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async listRules(): Promise<RateLimitRuleRow[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT bucket, max_requests, window_seconds, enabled FROM rate_limit_rules',
    );
    return rows.map((r: any) => ({
      bucket: r.bucket,
      maxRequests: Number(r.max_requests),
      windowSeconds: Number(r.window_seconds),
      // MySQL TINYINT(1) 回来是 0/1，不是 boolean
      enabled: Number(r.enabled) === 1,
    }));
  }

  async upsertRule(rule: RateLimitRuleRow): Promise<void> {
    await this.db().query(
      `INSERT INTO rate_limit_rules (bucket, max_requests, window_seconds, enabled)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         max_requests = VALUES(max_requests),
         window_seconds = VALUES(window_seconds),
         enabled = VALUES(enabled)`,
      [rule.bucket, rule.maxRequests, rule.windowSeconds, rule.enabled ? 1 : 0],
    );
  }

  async listAllowlist(): Promise<AllowlistRow[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT ip, note, create_time FROM rate_limit_allowlist ORDER BY create_time DESC',
    );
    return rows.map((r: any) => ({
      ip: r.ip,
      note: r.note ?? undefined,
      createTime: new Date(r.create_time),
    }));
  }

  async addAllowlist(ip: string, note?: string): Promise<void> {
    await this.db().query(
      `INSERT INTO rate_limit_allowlist (ip, note) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE note = VALUES(note)`,
      [ip, note ?? null],
    );
  }

  async removeAllowlist(ip: string): Promise<void> {
    await this.db().query('DELETE FROM rate_limit_allowlist WHERE ip = ?', [ip]);
  }
}
