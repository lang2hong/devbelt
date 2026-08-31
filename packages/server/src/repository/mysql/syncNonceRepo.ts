import type { ISyncNonceRepo } from '../interfaces.js';
import type { Queryable } from './db.js';

export class MysqlSyncNonceRepo implements ISyncNonceRepo {
  async insert(exec: Queryable, userId: number, keyEpoch: number, nonce: Buffer): Promise<boolean> {
    try {
      await exec.query(
        'INSERT INTO personal_sync_nonces (user_id, key_epoch, nonce) VALUES (?, ?, ?)',
        [userId, keyEpoch, nonce],
      );
      return true;
    } catch (err: any) {
      // 唯一键冲突（PRIMARY KEY(user_id, key_epoch, nonce)）→ nonce 已复用。
      if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) return false;
      throw err;
    }
  }
}