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
    const now = new Date();
    const [result] = await this.db().query<any>(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_name, device_id, user_agent, ip, expires_time, last_used_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [token.userId, token.tokenHash, token.deviceName ?? null, token.deviceId ?? null, token.userAgent ?? null, token.ip ?? null, token.expiresTime, now],
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('refresh_token insert failed');
    return created;
  }

  async revoke(id: number): Promise<void> {
    await this.db().query('UPDATE refresh_tokens SET revoke_time = ? WHERE id = ?', [new Date(), id]);
  }

  /**
   * 原子消费一条 refresh token：返回本次调用是否是撤销它的那一个。
   *
   * 这是 refresh 轮换正确性的唯一判据。原来的流程是「查 → 判 revokedTime →
   * revoke」，三步之间有 await（事件循环让出点），而 `revoke` 用的是
   * `WHERE id = ?` 且不看 affectedRows —— 于是两个请求带同一个 token 并发到达时
   * 双方都能通过检查、各自签出新会话，refresh token 的「一次性」保证失效，
   * 重用检测在最需要它的场景下静默失灵。
   *
   * 条件更新 `AND revoke_time IS NULL` 把裁决交给数据库：无论并发多少个，
   * `affectedRows === 1` 的只可能有一个。输的那个不必区分「并发」还是「重放」，
   * 一律按重用处理即可 —— 两者在安全语义上本来就该同等对待。
   */
  async consume(id: number, now: Date): Promise<boolean> {
    const [result] = await this.db().query<any>(
      'UPDATE refresh_tokens SET revoke_time = ?, last_used_time = ? WHERE id = ? AND revoke_time IS NULL',
      [now, now, id],
    );
    return result.affectedRows === 1;
  }

  async revokeAllForUser(userId: number): Promise<void> {
    await this.db().query('UPDATE refresh_tokens SET revoke_time = ? WHERE user_id = ? AND revoke_time IS NULL', [new Date(), userId]);
  }

  async revokeByDevice(userId: number, deviceId: string): Promise<void> {
    await this.db().query(
      'UPDATE refresh_tokens SET revoke_time = ? WHERE user_id = ? AND device_id = ? AND revoke_time IS NULL',
      [new Date(), userId, deviceId],
    );
  }

  async listActiveForUser(userId: number, now: Date): Promise<SessionInfo[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT id, device_name, ip, create_time, COALESCE(last_used_time, create_time) AS last_used_time FROM refresh_tokens WHERE user_id = ? AND revoke_time IS NULL AND expires_time > ? ORDER BY create_time DESC',
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
    deviceId: r.device_id ?? undefined,
    userAgent: r.user_agent ?? undefined,
    ip: r.ip ?? undefined,
    expiresTime: new Date(r.expires_time),
    revokedTime: r.revoke_time ? new Date(r.revoke_time) : undefined,
    lastUsedTime: r.last_used_time ? new Date(r.last_used_time) : undefined,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
