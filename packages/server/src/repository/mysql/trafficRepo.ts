import type { ITrafficRepo, TrafficBlockedRow, TrafficStatRow } from '../interfaces.js';
import type { MysqlDb } from './db.js';

/**
 * 流量统计仓储：traffic_stats（小时聚合）+ traffic_blocked（429 逐条）。
 */
export class MysqlTrafficRepo implements ITrafficRepo {
  constructor(private readonly db: () => MysqlDb) {}

  /**
   * 批量累加。
   *
   * 一条多值 INSERT + ON DUPLICATE KEY UPDATE，把一分钟攒下的桶一次落库。
   * `count = count + VALUES(count)` 而不是覆盖：同一小时桶会被 flush 多次
   * （每分钟一次），覆盖会丢掉前面几十次的计数。
   */
  async upsertStats(rows: TrafficStatRow[]): Promise<void> {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => '(?, ?, ?, ?)').join(', ');
    const params: any[] = [];
    for (const r of rows) {
      params.push(r.bucketTime, r.route, r.statusClass, r.count);
    }
    await this.db().query(
      `INSERT INTO traffic_stats (bucket_time, route, status_class, count)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE count = count + VALUES(count)`,
      params,
    );
  }

  async queryStats(from: Date, to: Date): Promise<TrafficStatRow[]> {
    const [rows] = await this.db().query<any[]>(
      `SELECT bucket_time, route, status_class, count FROM traffic_stats
       WHERE bucket_time >= ? AND bucket_time <= ?
       ORDER BY bucket_time ASC`,
      [from, to],
    );
    return rows.map((r: any) => ({
      bucketTime: new Date(r.bucket_time),
      route: r.route,
      statusClass: Number(r.status_class),
      count: Number(r.count),
    }));
  }

  async insertBlocked(rows: Array<Omit<TrafficBlockedRow, 'createTime'>>): Promise<void> {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => '(?, ?, ?)').join(', ');
    const params: any[] = [];
    for (const r of rows) {
      params.push(r.ip, r.route, r.bucket);
    }
    await this.db().query(
      `INSERT INTO traffic_blocked (ip, route, bucket) VALUES ${placeholders}`,
      params,
    );
  }

  async queryBlocked(from: Date, to: Date, limit: number): Promise<TrafficBlockedRow[]> {
    const [rows] = await this.db().query<any[]>(
      `SELECT ip, route, bucket, create_time FROM traffic_blocked
       WHERE create_time >= ? AND create_time <= ?
       ORDER BY create_time DESC, id DESC LIMIT ?`,
      [from, to, limit],
    );
    return rows.map((r: any) => ({
      ip: r.ip,
      route: r.route,
      bucket: r.bucket,
      createTime: new Date(r.create_time),
    }));
  }
}
