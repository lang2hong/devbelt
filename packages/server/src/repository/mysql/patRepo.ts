import type { IPatRepo } from '../interfaces.js';
import type { Pat } from '../../domain/entities.js';
import type { MysqlDb } from './db.js';

export class MysqlPatRepo implements IPatRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(pat: Omit<Pat, 'id' | 'createTime' | 'updateTime'>): Promise<Pat> {
    const [result] = await this.db().query<any>(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, scopes, expires_time)
       VALUES (?, ?, ?, ?, ?)`,
      [pat.userId, pat.name, pat.tokenHash, pat.scopes, pat.expiresTime ?? null],
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('pat insert failed');
    return created;
  }

  async findByHash(hash: string): Promise<Pat | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM personal_access_tokens WHERE token_hash = ?', [hash]);
    return rows[0] ? mapPat(rows[0]) : undefined;
  }

  async findById(id: number): Promise<Pat | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM personal_access_tokens WHERE id = ?', [id]);
    return rows[0] ? mapPat(rows[0]) : undefined;
  }

  async listByUser(userId: number): Promise<Pat[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM personal_access_tokens WHERE user_id = ? AND revoked_time IS NULL ORDER BY create_time DESC',
      [userId],
    );
    return rows.map(mapPat);
  }

  async revoke(id: number): Promise<void> {
    await this.db().query('UPDATE personal_access_tokens SET revoked_time = ? WHERE id = ?', [new Date(), id]);
  }

  async countActiveForUser(userId: number): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      `SELECT COUNT(*) AS cnt FROM personal_access_tokens
       WHERE user_id = ? AND revoked_time IS NULL AND (expires_time IS NULL OR expires_time > ?)`,
      [userId, new Date()],
    );
    return rows[0]?.cnt ?? 0;
  }

  async updateLastUsed(id: number, time: Date): Promise<void> {
    await this.db().query('UPDATE personal_access_tokens SET last_used_time = ? WHERE id = ?', [time, id]);
  }
}

function mapPat(r: any): Pat {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    tokenHash: r.token_hash,
    scopes: r.scopes,
    lastUsedTime: r.last_used_time ? new Date(r.last_used_time) : undefined,
    expiresTime: r.expires_time ? new Date(r.expires_time) : undefined,
    revokedTime: r.revoked_time ? new Date(r.revoked_time) : undefined,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
