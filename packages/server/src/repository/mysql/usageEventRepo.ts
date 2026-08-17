import type { IUsageEventRepo } from '../interfaces.js';
import type { UsageEvent } from '../../domain/entities.js';
import type { MysqlDb } from './db.js';

/** 用量行为仓储：usage_events 表（连接打开/查询执行的累计计数） */
export class MysqlUsageEventRepo implements IUsageEventRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async record(userId: number, deviceId: string | undefined, kind: UsageEvent['kind'], count: number): Promise<void> {
    await this.db().query(
      'INSERT INTO usage_events (user_id, device_id, kind, count) VALUES (?, ?, ?, ?)',
      [userId, deviceId ?? null, kind, count],
    );
  }

  async listByUser(userId: number, limit = 200): Promise<UsageEvent[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM usage_events WHERE user_id = ? ORDER BY create_time DESC, id DESC LIMIT ?',
      [userId, limit],
    );
    return rows.map(mapEvent);
  }
}

function mapEvent(r: any): UsageEvent {
  return {
    id: r.id,
    userId: r.user_id,
    deviceId: r.device_id ?? undefined,
    kind: r.kind as UsageEvent['kind'],
    count: r.count,
    createTime: new Date(r.create_time),
  };
}