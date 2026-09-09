import type { IIdempotencyReceiptRepo } from '../interfaces.js';
import type { IdempotencyReceipt } from '../../domain/entities.js';
import type { MysqlDb, Queryable } from './db.js';

/**
 * 幂等回执仓储（P3 §6.1）。
 *
 * 写方法在调用方事务（exec）内执行：receipt 与业务写、审计同事务提交/回滚，
 * 保证「重放不重复业务写/审计、回滚同滚、唯一键并发去重」。
 * `findByKey`（预检）走连接池，事务外快速短路重放/冲突。
 */
export class MysqlIdempotencyReceiptRepo implements IIdempotencyReceiptRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async createProcessing(exec: Queryable, input: {
    actorUserId: number;
    sessionId: string;
    method: string;
    normalizedPath: string;
    idempotencyKey: string;
    requestDigest: Buffer;
    expiresTime: Date;
  }): Promise<IdempotencyReceipt> {
    const [result] = await exec.query<any>(
      `INSERT INTO idempotency_receipts
        (actor_user_id, session_id, method, normalized_path, idempotency_key,
         request_digest, status, expires_time)
       VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)`,
      [input.actorUserId, input.sessionId, input.method, input.normalizedPath, input.idempotencyKey, input.requestDigest, input.expiresTime],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM idempotency_receipts WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('idempotency receipt insert failed');
    return mapReceipt(rows[0]);
  }

  async findByKey(actorUserId: number, sessionId: string, method: string, normalizedPath: string, idempotencyKey: string): Promise<IdempotencyReceipt | undefined> {
    const [rows] = await this.db().query<any[]>(
      `SELECT * FROM idempotency_receipts
       WHERE actor_user_id = ? AND session_id = ? AND method = ? AND normalized_path = ? AND idempotency_key = ?`,
      [actorUserId, sessionId, method, normalizedPath, idempotencyKey],
    );
    return rows[0] ? mapReceipt(rows[0]) : undefined;
  }

  async complete(exec: Queryable, id: number, httpStatus: number, responseBody: string): Promise<void> {
    await exec.query(
      'UPDATE idempotency_receipts SET status = \'completed\', http_status = ?, response_body = ? WHERE id = ?',
      [httpStatus, responseBody, id],
    );
  }

  async prune(exec: Queryable, before: Date, limit: number): Promise<number> {
    const [r] = await exec.query<any>('DELETE FROM idempotency_receipts WHERE expires_time < ? LIMIT ?', [before, limit]);
    return Number(r?.affectedRows ?? 0);
  }
}

function mapReceipt(r: any): IdempotencyReceipt {
  return {
    id: r.id,
    actorUserId: Number(r.actor_user_id),
    sessionId: r.session_id,
    method: r.method,
    normalizedPath: r.normalized_path,
    idempotencyKey: r.idempotency_key,
    requestDigest: r.request_digest as Buffer,
    status: r.status as IdempotencyReceipt['status'],
    httpStatus: r.http_status == null ? null : Number(r.http_status),
    responseBody: r.response_body == null ? null : String(r.response_body),
    expiresTime: new Date(r.expires_time),
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}