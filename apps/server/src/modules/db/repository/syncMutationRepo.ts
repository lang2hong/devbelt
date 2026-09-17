import type { ISyncMutationRepo } from '../../../repository/interfaces.js';
import type { SyncMutation } from '../../../domain/entities.js';
import type { SyncAction, SyncMutationStatus } from '../../../domain/enums.js';
import type { Queryable } from '../../../repository/mysql/db.js';

const SELECT_COLS = `
  user_id,
  CAST(key_epoch AS CHAR) AS key_epoch,
  mutation_id, request_digest, action,
  CAST(result_version AS CHAR) AS result_version,
  CAST(result_change_sequence AS CHAR) AS result_change_sequence,
  result_recovery_code_set_time,
  status, expires_time, create_time
`;

function mapMutation(r: any): SyncMutation {
  return {
    userId: r.user_id,
    keyEpoch: String(r.key_epoch),
    mutationId: r.mutation_id,
    requestDigest: r.request_digest,
    action: r.action as SyncAction,
    resultVersion: r.result_version != null ? String(r.result_version) : null,
    resultChangeSequence: r.result_change_sequence != null ? String(r.result_change_sequence) : null,
    resultRecoveryCodeSetTime: r.result_recovery_code_set_time ? new Date(r.result_recovery_code_set_time) : null,
    status: r.status as SyncMutationStatus,
    expiresTime: new Date(r.expires_time),
    createTime: new Date(r.create_time),
  };
}

export class MysqlSyncMutationRepo implements ISyncMutationRepo {
  async findByMutationId(exec: Queryable, userId: number, keyEpoch: string, mutationId: Buffer): Promise<SyncMutation | undefined> {
    const [rows] = await exec.query<any[]>(
      `SELECT ${SELECT_COLS} FROM personal_sync_mutations WHERE user_id = ? AND key_epoch = ? AND mutation_id = ?`,
      [userId, keyEpoch, mutationId],
    );
    return rows[0] ? mapMutation(rows[0]) : undefined;
  }

  async record(exec: Queryable, input: {
    userId: number;
    keyEpoch: string;
    mutationId: Buffer;
    requestDigest: Buffer;
    action: SyncAction;
    resultVersion: string | null;
    resultChangeSequence: string | null;
    resultRecoveryCodeSetTime: Date | null;
    status: SyncMutation['status'];
    expiresTime: Date;
  }): Promise<void> {
    await exec.query(
      `INSERT INTO personal_sync_mutations
         (user_id, key_epoch, mutation_id, request_digest, action, result_version, result_change_sequence, result_recovery_code_set_time, status, expires_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         request_digest = VALUES(request_digest),
         action = VALUES(action),
         result_version = VALUES(result_version),
         result_change_sequence = VALUES(result_change_sequence),
         result_recovery_code_set_time = VALUES(result_recovery_code_set_time),
         status = VALUES(status),
         expires_time = VALUES(expires_time)`,
      [
        input.userId, input.keyEpoch, input.mutationId, input.requestDigest, input.action,
        input.resultVersion, input.resultChangeSequence, input.resultRecoveryCodeSetTime, input.status, input.expiresTime,
      ],
    );
  }

  /**
   * 清理过期 receipt。`expires_time` 本就是为此设计（24h 保留期），
   * 但此前没有任何任务消费它，于是每条 mutation 都永久留一行。
   * 本仓储无状态，exec 由调用方传入。
   */
  async prune(exec: Queryable, before: Date, limit: number): Promise<number> {
    const [result] = await exec.query<any>(
      'DELETE FROM personal_sync_mutations WHERE expires_time < ? LIMIT ?',
      [before, limit],
    );
    return Number(result?.affectedRows ?? 0);
  }
}