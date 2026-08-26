import type { IDeviceRepo } from '../interfaces.js';
import type { Device } from '../../domain/entities.js';
import type { MysqlDb } from './db.js';

/**
 * 设备实体仓储：devices 表（设备固有信息，独立于易变的 refresh_tokens）。
 * 唯一键 (user_id, device_id)，同设备重登时 upsert 刷新固有信息 + last_seen_time。
 */
export class MysqlDeviceRepo implements IDeviceRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async upsert(device: Omit<Device, 'id' | 'createTime' | 'updateTime'>): Promise<Device> {
    await this.db().query(
      `INSERT INTO devices (user_id, device_id, hostname, os, arch, os_version, app_name, app_version, remote_name, vs_machine_id, language, timezone, revoke_time, last_seen_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE
         hostname = VALUES(hostname), os = VALUES(os), arch = VALUES(arch),
         os_version = VALUES(os_version), app_name = VALUES(app_name), app_version = VALUES(app_version),
         remote_name = VALUES(remote_name), vs_machine_id = VALUES(vs_machine_id),
         language = VALUES(language), timezone = VALUES(timezone), last_seen_time = VALUES(last_seen_time)`,
      [
        device.userId, device.deviceId,
        device.hostname ?? null, device.os ?? null, device.arch ?? null,
        device.osVersion ?? null, device.appName ?? null, device.appVersion ?? null,
        device.remoteName ?? null, device.vsMachineId ?? null,
        device.language ?? null, device.timezone ?? null, device.lastSeenTime ?? null,
      ],
    );

    const fresh = await this.findByUserAndDevice(device.userId, device.deviceId);
    if (!fresh) throw new Error('device upsert failed');

    return fresh;
  }

  async listByUser(userId: number): Promise<Device[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_time DESC',
      [userId],
    );
    return rows.map(mapDevice);
  }


  async bind(userId: number, deviceId: string): Promise<void> {
    await this.db().query(
      'UPDATE devices SET revoke_time = NULL WHERE user_id = ? AND device_id = ?',
      [userId, deviceId],
    );
  }

  async revoke(userId: number, deviceId: string): Promise<void> {
    await this.db().query(
      'UPDATE devices SET revoke_time = NOW() WHERE user_id = ? AND device_id = ?',
      [userId, deviceId],
    );
  }

  async isBound(userId: number, deviceId: string): Promise<boolean> {
    const d = await this.findByUserAndDevice(userId, deviceId);
    return !!(d && d.revokedTime == null);
  }

  async countBound(userId: number): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      'SELECT COUNT(*) AS cnt FROM devices WHERE user_id = ? AND revoke_time IS NULL',
      [userId],
    );
    return rows[0]?.cnt ?? 0;
  }

  private async findByUserAndDevice(userId: number, deviceId: string): Promise<Device | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM devices WHERE user_id = ? AND device_id = ?',
      [userId, deviceId],
    );
    return rows[0] ? mapDevice(rows[0]) : undefined;
  }

}

function mapDevice(r: any): Device {
  return {
    id: r.id,
    userId: r.user_id,
    deviceId: r.device_id,
    hostname: r.hostname ?? undefined,
    os: r.os ?? undefined,
    arch: r.arch ?? undefined,
    osVersion: r.os_version ?? undefined,
    appName: r.app_name ?? undefined,
    appVersion: r.app_version ?? undefined,
    remoteName: r.remote_name ?? undefined,
    vsMachineId: r.vs_machine_id ?? undefined,
    language: r.language ?? undefined,
    timezone: r.timezone ?? undefined,
    revokedTime: r.revoke_time ? new Date(r.revoke_time) : undefined,
    lastSeenTime: r.last_seen_time ? new Date(r.last_seen_time) : undefined,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
