import type { IRefreshTokenRepo } from '../interfaces.js';
import type { RefreshToken } from '../../domain/entities.js';
import type { MysqlDb, Queryable } from './db.js';

/**
 * Refresh token 仓储：family 复用检测 + 轮换链 replaced_by_token_id。
 *
 * 事务方法（带 exec 参数）支持 refresh 的原子轮换：`FOR UPDATE` 锁定 +
 * 消费旧 + 写新都在同一事务连接上，避免并发复用下签出两条活跃会话。
 */
export class MysqlRefreshTokenRepo implements IRefreshTokenRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(exec: Queryable, input: {
    userId: number;
    deviceId: number | null;
    tokenHash: string;
    familyId: string;
    replacedByTokenId: number | null;
    expiresTime: Date;
  }): Promise<RefreshToken> {
    const [result] = await exec.query<any>(
      `INSERT INTO refresh_tokens (user_id, device_id, token_hash, family_id, replaced_by_token_id, expires_time, last_used_time)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [input.userId, input.deviceId, input.tokenHash, input.familyId, input.replacedByTokenId, input.expiresTime],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM refresh_tokens WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('refresh_token insert failed');
    return mapRefreshToken(rows[0]);
  }

  async findByHash(tokenHash: string): Promise<RefreshToken | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM refresh_tokens WHERE token_hash = ?',
      [tokenHash],
    );
    return rows[0] ? mapRefreshToken(rows[0]) : undefined;
  }

  async findByHashForUpdate(exec: Queryable, tokenHash: string): Promise<RefreshToken | undefined> {
    const [rows] = await exec.query<any[]>(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? FOR UPDATE',
      [tokenHash],
    );
    return rows[0] ? mapRefreshToken(rows[0]) : undefined;
  }

  async findById(id: number): Promise<RefreshToken | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM refresh_tokens WHERE id = ?', [id]);
    return rows[0] ? mapRefreshToken(rows[0]) : undefined;
  }

  /**
   * 原子消费：仅当尚未撤销时置 revoked_time，返回是否由本次调用完成。
   * 在 refresh 事务内于 `FOR UPDATE` 锁之后调用，返回值必为 true（已持有锁）。
   */
  async consume(exec: Queryable, id: number, now: Date): Promise<boolean> {
    const [result] = await exec.query<any>(
      'UPDATE refresh_tokens SET revoked_time = ?, last_used_time = ? WHERE id = ? AND revoked_time IS NULL',
      [now, now, id],
    );
    return result.affectedRows === 1;
  }

  async revokeFamily(exec: Queryable, familyId: string, now: Date): Promise<void> {
    await exec.query(
      'UPDATE refresh_tokens SET revoked_time = ? WHERE family_id = ? AND revoked_time IS NULL',
      [now, familyId],
    );
  }

  async revokeByDevice(exec: Queryable, deviceId: number, now: Date): Promise<void> {
    await exec.query(
      'UPDATE refresh_tokens SET revoked_time = ? WHERE device_id = ? AND revoked_time IS NULL',
      [now, deviceId],
    );
  }

  async revokeAllForUser(exec: Queryable, userId: number, now: Date): Promise<void> {
    await exec.query(
      'UPDATE refresh_tokens SET revoked_time = ? WHERE user_id = ? AND revoked_time IS NULL',
      [now, userId],
    );
  }
}

function mapRefreshToken(r: any): RefreshToken {
  return {
    id: r.id,
    userId: r.user_id,
    deviceId: r.device_id ?? null,
    tokenHash: r.token_hash,
    familyId: r.family_id,
    replacedByTokenId: r.replaced_by_token_id ?? null,
    expiresTime: new Date(r.expires_time),
    revokedTime: r.revoked_time ? new Date(r.revoked_time) : null,
    lastUsedTime: r.last_used_time ? new Date(r.last_used_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
