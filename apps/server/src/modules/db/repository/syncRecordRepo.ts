import type { ISyncRecordRepo } from '../../../repository/interfaces.js';
import type { PersonalConnectionMeta } from '../../../domain/entities.js';
import type { Queryable } from '../../../repository/mysql/db.js';

// u64 协议字段（key_epoch/version/change_sequence）CAST AS CHAR 返回十进制字符串（§7.1）。
const SELECT_COLS = `
  id, user_id,
  CAST(key_epoch AS CHAR) AS key_epoch,
  record_id, cipher_suite, format_version, nonce, ciphertext, tag,
  CAST(version AS CHAR) AS version,
  CAST(change_sequence AS CHAR) AS change_sequence,
  update_time, delete_time
`;

function mapMeta(r: any): PersonalConnectionMeta {
  return {
    id: r.id,
    userId: r.user_id,
    keyEpoch: String(r.key_epoch),
    recordId: r.record_id,
    cipherSuite: r.cipher_suite,
    formatVersion: r.format_version,
    nonce: r.nonce,
    ciphertext: r.ciphertext != null ? (Buffer.isBuffer(r.ciphertext) ? r.ciphertext : Buffer.from(r.ciphertext)) : null,
    tag: r.tag != null ? (Buffer.isBuffer(r.tag) ? r.tag : Buffer.from(r.tag)) : null,
    version: String(r.version),
    changeSequence: String(r.change_sequence),
    updateTime: new Date(r.update_time),
    deleteTime: r.delete_time ? new Date(r.delete_time) : null,
  };
}

export class MysqlSyncRecordRepo implements ISyncRecordRepo {
  async create(exec: Queryable, input: {
    userId: number;
    keyEpoch: string;
    recordId: Buffer;
    cipherSuite: PersonalConnectionMeta['cipherSuite'];
    formatVersion: PersonalConnectionMeta['formatVersion'];
    nonce: Buffer;
    ciphertext: Buffer;
    tag: Buffer;
    version: string;
    changeSequence: string;
  }): Promise<PersonalConnectionMeta> {
    await exec.query(
      `INSERT INTO personal_connection_meta
         (user_id, key_epoch, record_id, cipher_suite, format_version, nonce, ciphertext, tag, version, change_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.userId, input.keyEpoch, input.recordId, input.cipherSuite, input.formatVersion,
       input.nonce, input.ciphertext, input.tag, input.version, input.changeSequence],
    );
    const created = await this.findById(exec, input.userId, input.keyEpoch, input.recordId);
    if (!created) throw new Error('personal_connection_meta insert failed');
    return created;
  }

  private async findById(exec: Queryable, userId: number, keyEpoch: string, recordId: Buffer): Promise<PersonalConnectionMeta | undefined> {
    const [rows] = await exec.query<any[]>(
      `SELECT ${SELECT_COLS} FROM personal_connection_meta WHERE user_id = ? AND key_epoch = ? AND record_id = ?`,
      [userId, keyEpoch, recordId],
    );
    return rows[0] ? mapMeta(rows[0]) : undefined;
  }

  async findForUpdate(exec: Queryable, userId: number, keyEpoch: string, recordId: Buffer): Promise<PersonalConnectionMeta | undefined> {
    const [rows] = await exec.query<any[]>(
      `SELECT ${SELECT_COLS} FROM personal_connection_meta WHERE user_id = ? AND key_epoch = ? AND record_id = ? FOR UPDATE`,
      [userId, keyEpoch, recordId],
    );
    return rows[0] ? mapMeta(rows[0]) : undefined;
  }

  async update(exec: Queryable, input: {
    userId: number;
    keyEpoch: string;
    recordId: Buffer;
    baseVersion: string;
    cipherSuite: PersonalConnectionMeta['cipherSuite'];
    formatVersion: PersonalConnectionMeta['formatVersion'];
    nonce: Buffer;
    ciphertext: Buffer;
    tag: Buffer;
    newVersion: string;
    changeSequence: string;
  }): Promise<boolean> {
    const [result] = await exec.query<any>(
      `UPDATE personal_connection_meta
       SET cipher_suite = ?, format_version = ?, nonce = ?, ciphertext = ?, tag = ?,
           version = ?, change_sequence = ?
       WHERE user_id = ? AND key_epoch = ? AND record_id = ? AND version = ? AND delete_time IS NULL`,
      [input.cipherSuite, input.formatVersion, input.nonce, input.ciphertext, input.tag,
       input.newVersion, input.changeSequence,
       input.userId, input.keyEpoch, input.recordId, input.baseVersion],
    );
    return Number(result.affectedRows) === 1;
  }

  async softDelete(exec: Queryable, userId: number, keyEpoch: string, recordId: Buffer, baseVersion: string, newVersion: string, changeSequence: string, now: Date): Promise<boolean> {
    const [result] = await exec.query<any>(
      `UPDATE personal_connection_meta
       SET ciphertext = NULL, tag = NULL, version = ?, change_sequence = ?, delete_time = ?
       WHERE user_id = ? AND key_epoch = ? AND record_id = ? AND version = ? AND delete_time IS NULL`,
      [newVersion, changeSequence, now, userId, keyEpoch, recordId, baseVersion],
    );
    return Number(result.affectedRows) === 1;
  }

  async listByFeed(exec: Queryable, userId: number, keyEpoch: string, after: string, snapshotSequence: string, limit: number): Promise<PersonalConnectionMeta[]> {
    const [rows] = await exec.query<any[]>(
      `SELECT ${SELECT_COLS} FROM personal_connection_meta
       WHERE user_id = ? AND key_epoch = ? AND change_sequence > ? AND change_sequence <= ?
       ORDER BY change_sequence + 0 ASC LIMIT ?`,
      [userId, keyEpoch, after, snapshotSequence, limit],
    );
    return rows.map(mapMeta);
  }

  async countActive(exec: Queryable, userId: number, keyEpoch: string): Promise<{ count: number; bytes: number }> {
    const [rows] = await exec.query<any[]>(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(OCTET_LENGTH(ciphertext) + OCTET_LENGTH(tag) + OCTET_LENGTH(nonce)), 0) AS bytes
       FROM personal_connection_meta
       WHERE user_id = ? AND key_epoch = ? AND delete_time IS NULL`,
      [userId, keyEpoch],
    );
    return { count: Number(rows[0]?.cnt ?? 0), bytes: Number(rows[0]?.bytes ?? 0) };
  }

  async overview(exec: Queryable, userId: number, keyEpoch: string): Promise<{ count: number; bytes: number; lastActivityTime: Date | null }> {
    const [rows] = await exec.query<any[]>(
      `SELECT
         COALESCE(SUM(delete_time IS NULL), 0) AS cnt,
         COALESCE(SUM(CASE WHEN delete_time IS NULL THEN OCTET_LENGTH(ciphertext) + OCTET_LENGTH(tag) + OCTET_LENGTH(nonce) ELSE 0 END), 0) AS bytes,
         MAX(update_time) AS last
       FROM personal_connection_meta
       WHERE user_id = ? AND key_epoch = ?`,
      [userId, keyEpoch],
    );
    return {
      count: Number(rows[0]?.cnt ?? 0),
      bytes: Number(rows[0]?.bytes ?? 0),
      lastActivityTime: rows[0]?.last ? new Date(rows[0].last) : null,
    };
  }

  async listActiveByEpoch(exec: Queryable, userId: number, keyEpoch: string): Promise<PersonalConnectionMeta[]> {
    const [rows] = await exec.query<any[]>(
      `SELECT ${SELECT_COLS} FROM personal_connection_meta
       WHERE user_id = ? AND key_epoch = ? AND delete_time IS NULL
       ORDER BY change_sequence + 0 ASC`,
      [userId, keyEpoch],
    );
    return rows.map(mapMeta);
  }
}