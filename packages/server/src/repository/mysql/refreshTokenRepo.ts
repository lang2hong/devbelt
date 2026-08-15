import type { IRefreshTokenRepo } from '../interfaces.js';
import type { RefreshToken, SessionInfo } from '../../domain/entities.js';
import type { MysqlDb } from './db.js';

export class MysqlRefreshTokenRepo implements IRefreshTokenRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findByHash(hash: string): Promise<RefreshToken | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM refresh_tokens WHERE token_hash = ?', [hash]);
    return rows[0] ? mapRefreshToken(rows[0]) : undefined;
  }

  async create(token: Omit<RefreshToken, 'id' | 'createTime' | 'updateTime'>): Promise<RefreshToken> {
    const [result] = await this.db().query<any>(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_name, user_agent, ip, expires_time)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [token.userId, token.tokenHash, token.deviceName ?? null, token.userAgent ?? null, token.ip ?? null, token.expiresTime],
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('refresh_token insert failed');
    return created;
  }

  async revoke(id: number): Promise<void> {
    await this.db().query('UPDATE refresh_tokens SET revoked_time = ? WHERE id = ?', [new Date(), id]);
  }

  async revokeAllForUser(userId: number): Promise<void> {
    await this.db().query('UPDATE refresh_tokens SET revoked_time = ? WHERE user_id = ? AND revoked_time IS NULL', [new Date(), userId]);
  }

  async countActiveForUser(userId: number, now: Date): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      'SELECT COUNT(*) AS cnt FROM refresh_tokens WHERE user_id = ? AND revoked_time IS NULL AND expires_time > ?',
      [userId, now],
    );
    return rows[0]?.cnt ?? 0;
  }

  async listActiveForUser(userId: number, now: Date): Promise<SessionInfo[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT id, device_name, ip, create_time, last_used_time FROM refresh_tokens WHERE user_id = ? AND revoked_time IS NULL AND expires_time > ? ORDER BY create_time DESC',
      [userId, now],
    );
    return rows.map((r: any) => ({
      id: r.id,
      deviceName: r.device_name ?? undefined,
      ip: r.ip ?? undefined,
      createTime: new Date(r.create_time),
      lastUsedTime: r.last_used_time ? new Date(r.last_used_time) : undefined,
      current: false,
    }));
  }

  async updateLastUsed(id: number, time: Date): Promise<void> {
    await this.db().query('UPDATE refresh_tokens SET last_used_time = ? WHERE id = ?', [time, id]);
  }

  async findById(id: number): Promise<RefreshToken | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM refresh_tokens WHERE id = ?', [id]);
    return rows[0] ? mapRefreshToken(rows[0]) : undefined;
  }
}

function mapRefreshToken(r: any): RefreshToken {
  return {
    id: r.id,
    userId: r.user_id,
    tokenHash: r.token_hash,
    deviceName: r.device_name ?? undefined,
    userAgent: r.user_agent ?? undefined,
    ip: r.ip ?? undefined,
    expiresTime: new Date(r.expires_time),
    revokedTime: r.revoked_time ? new Date(r.revoked_time) : undefined,
    lastUsedTime: r.last_used_time ? new Date(r.last_used_time) : undefined,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
