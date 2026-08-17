import type { ISyncEventRepo } from '../interfaces.js';
import type { SyncEvent } from '../../domain/entities.js';
import type { MysqlDb } from './db.js';

/** 同步事件留痕仓储：sync_events 表（每次 pull/push 的明文元数据） */
export class MysqlSyncEventRepo implements ISyncEventRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async record(event: Omit<SyncEvent, 'id' | 'createTime'>): Promise<void> {
    await this.db().query(
      'INSERT INTO sync_events (user_id, device_id, direction, section, bytes, item_count) VALUES (?, ?, ?, ?, ?, ?)',
      [event.userId, event.deviceId ?? null, event.direction, event.section, event.bytes, event.itemCount],
    );
  }

  async listByUser(userId: number, limit = 100): Promise<SyncEvent[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM sync_events WHERE user_id = ? ORDER BY create_time DESC, id DESC LIMIT ?',
      [userId, limit],
    );
    return rows.map(mapEvent);
  }
}

function mapEvent(r: any): SyncEvent {
  return {
    id: r.id,
    userId: r.user_id,
    deviceId: r.device_id ?? undefined,
    direction: r.direction as SyncEvent['direction'],
    section: r.section,
    bytes: r.bytes,
    itemCount: r.item_count,
    createTime: new Date(r.create_time),
  };
}