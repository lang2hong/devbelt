import type { ISyncResetHandoffRepo } from '../interfaces.js';
import type { SyncResetHandoff } from '../../domain/entities.js';
import type { SyncResetHandoffStatus } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/** sync-reset handoff 仓储：只存 ticket 的 SHA-256。写入方法全在调用方事务（exec）内。 */
export class MysqlSyncResetHandoffRepo implements ISyncResetHandoffRepo {
  constructor(private readonly db: () => MysqlDb) {}
  async create(exec: Queryable, input: { userId: number; resetTokenId: number; ticketHash: Buffer; expiresTime: Date }): Promise<SyncResetHandoff> {
    const [result] = await exec.query<any>(
      `INSERT INTO sync_reset_handoffs (user_id, reset_token_id, ticket_hash, status, expires_time)
       VALUES (?, ?, ?, 'issued', ?)`,
      [input.userId, input.resetTokenId, input.ticketHash, input.expiresTime],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM sync_reset_handoffs WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('sync_reset_handoffs insert failed');
    return mapHandoff(rows[0]);
  }

  async findByTicketHash(ticketHash: Buffer): Promise<SyncResetHandoff | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM sync_reset_handoffs WHERE ticket_hash = ?', [ticketHash]);
    return rows[0] ? mapHandoff(rows[0]) : undefined;
  }

  async findByTicketHashForUpdate(exec: Queryable, ticketHash: Buffer): Promise<SyncResetHandoff | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM sync_reset_handoffs WHERE ticket_hash = ? FOR UPDATE', [ticketHash]);
    return rows[0] ? mapHandoff(rows[0]) : undefined;
  }

  async revokePendingByResetToken(exec: Queryable, resetTokenId: number, now: Date): Promise<void> {
    await exec.query(
      `UPDATE sync_reset_handoffs
       SET status = 'revoked', update_time = ?
       WHERE reset_token_id = ? AND status IN ('issued', 'processing')`,
      [now, resetTokenId],
    );
  }

  async markProcessing(exec: Queryable, id: number, requestDigest: Buffer, now: Date): Promise<void> {
    await exec.query(
      `UPDATE sync_reset_handoffs SET status = 'processing', request_digest = ?, update_time = ? WHERE id = ?`,
      [requestDigest, now, id],
    );
  }

  async markCompleted(exec: Queryable, id: number, now: Date, result: { stateDtoJson: string; keyEpoch: string; stateVersion: string; changeSequence: string }): Promise<void> {
    await exec.query(
      `UPDATE sync_reset_handoffs
       SET status = 'completed', consumed_time = ?, update_time = ?,
           result_state_dto_json = ?, result_key_epoch = ?, result_state_version = ?, result_change_sequence = ?
       WHERE id = ?`,
      [now, now, result.stateDtoJson, result.keyEpoch, result.stateVersion, result.changeSequence, id],
    );
  }

  async rollbackProcessing(exec: Queryable, id: number, now: Date): Promise<void> {
    await exec.query(
      `UPDATE sync_reset_handoffs SET status = 'issued', request_digest = NULL, update_time = ? WHERE id = ? AND status = 'processing'`,
      [now, id],
    );
  }

  async expire(exec: Queryable, now: Date, limit: number): Promise<number> {
    const [result] = await exec.query<any>(
      `UPDATE sync_reset_handoffs
       SET status = 'expired', update_time = ?
       WHERE status IN ('issued', 'processing') AND expires_time < ?
       LIMIT ?`,
      [now, now, limit],
    );
    return Number(result?.affectedRows ?? 0);
  }

  async prune(exec: Queryable, before: Date, limit: number): Promise<number> {
    const [result] = await exec.query<any>(
      `DELETE FROM sync_reset_handoffs
       WHERE status IN ('completed', 'revoked', 'expired') AND update_time < ?
       LIMIT ?`,
      [before, limit],
    );
    return Number(result?.affectedRows ?? 0);
  }
}

function mapHandoff(r: any): SyncResetHandoff {
  return {
    id: r.id,
    userId: Number(r.user_id),
    resetTokenId: Number(r.reset_token_id),
    ticketHash: r.ticket_hash as Buffer,
    requestDigest: r.request_digest ? (r.request_digest as Buffer) : null,
    resultStateDtoJson: r.result_state_dto_json == null ? null : String(r.result_state_dto_json),
    resultKeyEpoch: r.result_key_epoch == null ? null : String(r.result_key_epoch),
    resultStateVersion: r.result_state_version == null ? null : String(r.result_state_version),
    resultChangeSequence: r.result_change_sequence == null ? null : String(r.result_change_sequence),
    status: r.status as SyncResetHandoffStatus,
    expiresTime: new Date(r.expires_time),
    consumedTime: r.consumed_time ? new Date(r.consumed_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}