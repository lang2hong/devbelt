import type { ISyncMutationRepo } from '../interfaces.js';
import type { SyncMutation } from '../../domain/entities.js';
import type { SyncAction, SyncMutationStatus } from '../../domain/enums.js';
import type { Queryable } from './db.js';

function mapMutation(r: any): SyncMutation {
  return {
    userId: r.user_id,
    keyEpoch: r.key_epoch,
    mutationId: r.mutation_id,
    requestDigest: r.request_digest,
    action: r.action as SyncAction,
    resultVersion: r.result_version != null ? Number(r.result_version) : null,
    resultChangeSequence: r.result_change_sequence != null ? Number(r.result_change_sequence) : null,
    status: r.status as SyncMutationStatus,
    expiresTime: new Date(r.expires_time),
    createTime: new Date(r.create_time),
  };
}

export class MysqlSyncMutationRepo implements ISyncMutationRepo {
  async findByMutationId(exec: Queryable, userId: number, keyEpoch: number, mutationId: Buffer): Promise<SyncMutation | undefined> {
    const [rows] = await exec.query<any[]>(
      'SELECT * FROM personal_sync_mutations WHERE user_id = ? AND key_epoch = ? AND mutation_id = ?',
      [userId, keyEpoch, mutationId],
    );
    return rows[0] ? mapMutation(rows[0]) : undefined;
  }

  async record(exec: Queryable, input: {
    userId: number;
    keyEpoch: number;
    mutationId: Buffer;
    requestDigest: Buffer;
    action: SyncAction;
    resultVersion: number | null;
    resultChangeSequence: number | null;
    status: SyncMutation['status'];
    expiresTime: Date;
  }): Promise<void> {
    await exec.query(
      `INSERT INTO personal_sync_mutations
         (user_id, key_epoch, mutation_id, request_digest, action, result_version, result_change_sequence, status, expires_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         request_digest = VALUES(request_digest),
         action = VALUES(action),
         result_version = VALUES(result_version),
         result_change_sequence = VALUES(result_change_sequence),
         status = VALUES(status),
         expires_time = VALUES(expires_time)`,
      [
        input.userId, input.keyEpoch, input.mutationId, input.requestDigest, input.action,
        input.resultVersion, input.resultChangeSequence, input.status, input.expiresTime,
      ],
    );
  }
}