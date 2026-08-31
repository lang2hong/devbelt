import type { ISyncResetTokenRepo } from '../interfaces.js';
import type { SyncResetToken } from '../../domain/entities.js';
import type { Queryable } from './db.js';

function mapToken(r: any): SyncResetToken {
  return {
    id: r.id,
    userId: r.user_id,
    tokenHash: r.token_hash,
    expiresTime: new Date(r.expires_time),
    consumedTime: r.consumed_time ? new Date(r.consumed_time) : null,
    revokedTime: r.revoked_time ? new Date(r.revoked_time) : null,
    createTime: new Date(r.create_time),
  };
}

export class MysqlSyncResetTokenRepo implements ISyncResetTokenRepo {
  async create(exec: Queryable, input: { userId: number; tokenHash: Buffer; expiresTime: Date }): Promise<SyncResetToken> {
    const [result] = await exec.query<any>(
      'INSERT INTO personal_sync_reset_tokens (user_id, token_hash, expires_time) VALUES (?, ?, ?)',
      [input.userId, input.tokenHash, input.expiresTime],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM personal_sync_reset_tokens WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('personal_sync_reset_tokens insert failed');
    return mapToken(rows[0]);
  }

  async revokePendingByUser(exec: Queryable, userId: number, now: Date): Promise<void> {
    await exec.query(
      'UPDATE personal_sync_reset_tokens SET revoked_time = ? WHERE user_id = ? AND consumed_time IS NULL AND revoked_time IS NULL',
      [now, userId],
    );
  }

  async findUsableForUpdate(exec: Queryable, tokenHash: Buffer): Promise<SyncResetToken | undefined> {
    const [rows] = await exec.query<any[]>(
      `SELECT * FROM personal_sync_reset_tokens
       WHERE token_hash = ? AND consumed_time IS NULL AND revoked_time IS NULL AND expires_time > NOW(3)
       FOR UPDATE`,
      [tokenHash],
    );
    return rows[0] ? mapToken(rows[0]) : undefined;
  }

  async consume(exec: Queryable, id: number, now: Date): Promise<boolean> {
    const [result] = await exec.query<any>(
      'UPDATE personal_sync_reset_tokens SET consumed_time = ? WHERE id = ? AND consumed_time IS NULL AND revoked_time IS NULL',
      [now, id],
    );
    return Number(result.affectedRows) === 1;
  }
}