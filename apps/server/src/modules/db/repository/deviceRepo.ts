import type { IDeviceRepo } from '../../../repository/interfaces.js';
import type { Device } from '../../../domain/entities.js';
import type { DeviceStatus } from '../../../domain/enums.js';
import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';

/**
 * 设备仓储。device_key 为客户端生成的稳定随机标识，UNIQUE(user_id, device_key)。
 *
 * 事务方法（带 exec 参数）在调用方事务上执行，用于：
 * - 设备配额（countActive + upsert + 用户行锁）的并发正确性
 * - 设备撤销与 session 撤销的同一事务
 */
export class MysqlDeviceRepo implements IDeviceRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async upsert(exec: Queryable, device: Omit<Device, 'id' | 'createTime' | 'updateTime'>): Promise<Device> {
    await exec.query(
      `INSERT INTO devices (user_id, device_key, device_platform, device_name, client_version, status, last_used_time)
       VALUES (?, ?, ?, ?, ?, 'active', ?)
       ON DUPLICATE KEY UPDATE
         device_platform = VALUES(device_platform),
         device_name = VALUES(device_name),
         client_version = VALUES(client_version),
         status = 'active',
         last_used_time = VALUES(last_used_time)`,
      [device.userId, device.deviceKey, device.devicePlatform, device.deviceName, device.clientVersion, device.lastUsedTime ?? null],
    );
    const fresh = await this.findByUserAndKeyExec(exec, device.userId, device.deviceKey);
    if (!fresh) throw new Error('device upsert failed');
    return fresh;
  }

  async findByUserAndKey(exec: Queryable, userId: number, deviceKey: string): Promise<Device | undefined> {
    return this.findByUserAndKeyExec(exec, userId, deviceKey);
  }

  async findByIdForUpdate(exec: Queryable, id: number): Promise<Device | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM devices WHERE id = ? FOR UPDATE', [id]);
    return rows[0] ? mapDevice(rows[0]) : undefined;
  }

  async listByUser(userId: number): Promise<Device[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM devices WHERE user_id = ? ORDER BY last_used_time DESC',
      [userId],
    );
    return rows.map(mapDevice);
  }

  async countActive(exec: Queryable, userId: number): Promise<number> {
    const [rows] = await exec.query<any[]>(
      "SELECT COUNT(*) AS cnt FROM devices WHERE user_id = ? AND status = 'active' AND device_platform <> 'web'",
      [userId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async revoke(exec: Queryable, id: number, now: Date): Promise<void> {
    await exec.query("UPDATE devices SET status = 'revoked', last_used_time = ? WHERE id = ?", [now, id]);
  }

  async touch(exec: Queryable, id: number, now: Date): Promise<void> {
    await exec.query('UPDATE devices SET last_used_time = ? WHERE id = ?', [now, id]);
  }

  async findActiveByUserAndPlatform(exec: Queryable, userId: number, platform: string): Promise<Device | undefined> {
    const [rows] = await exec.query<any[]>(
      "SELECT * FROM devices WHERE user_id = ? AND device_platform = ? AND status = 'active' ORDER BY id ASC LIMIT 1",
      [userId, platform],
    );
    return rows[0] ? mapDevice(rows[0]) : undefined;
  }

  private async findByUserAndKeyExec(exec: Queryable, userId: number, deviceKey: string): Promise<Device | undefined> {
    const [rows] = await exec.query<any[]>(
      'SELECT * FROM devices WHERE user_id = ? AND device_key = ?',
      [userId, deviceKey],
    );
    return rows[0] ? mapDevice(rows[0]) : undefined;
  }
}

function mapDevice(r: any): Device {
  return {
    id: r.id,
    userId: r.user_id,
    deviceKey: r.device_key,
    devicePlatform: r.device_platform ?? '',
    deviceName: r.device_name ?? '',
    clientVersion: r.client_version ?? '',
    status: r.status as DeviceStatus,
    lastUsedTime: r.last_used_time ? new Date(r.last_used_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
