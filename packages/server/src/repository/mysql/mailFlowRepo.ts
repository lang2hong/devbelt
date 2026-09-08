import type { IMailFlowRepo } from '../interfaces.js';
import type { MailFlow } from '../../domain/entities.js';
import type { MailFlowStatus, MailFlowType } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/** 邮件流仓储：只存 hash。写方法在事务（exec）内执行；只读查询走连接池。 */
export class MysqlMailFlowRepo implements IMailFlowRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(input: {
    type: MailFlowType;
    targetTokenHash: Buffer;
    targetRecordId: number | null;
    userId: number | null;
    nonceHash: Buffer;
    expiresTime: Date;
  }): Promise<MailFlow> {
    const [result] = await this.db().query<any>(
      `INSERT INTO mail_flows
        (type, target_token_hash, target_record_id, user_id, nonce_hash, status, expires_time)
       VALUES (?, ?, ?, ?, ?, 'issued', ?)`,
      [input.type, input.targetTokenHash, input.targetRecordId, input.userId, input.nonceHash, input.expiresTime],
    );
    const [rows] = await this.db().query<any[]>('SELECT * FROM mail_flows WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('mail_flow insert failed');
    return mapMailFlow(rows[0]);
  }

  async findByNonceHash(nonceHash: Buffer): Promise<MailFlow | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM mail_flows WHERE nonce_hash = ?', [nonceHash]);
    return rows[0] ? mapMailFlow(rows[0]) : undefined;
  }

  async findByNonceHashForUpdate(exec: Queryable, nonceHash: Buffer): Promise<MailFlow | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM mail_flows WHERE nonce_hash = ? FOR UPDATE', [nonceHash]);
    return rows[0] ? mapMailFlow(rows[0]) : undefined;
  }

  async markConsumed(exec: Queryable, id: number, now: Date): Promise<void> {
    await exec.query('UPDATE mail_flows SET status = ?, consumed_time = ? WHERE id = ?', ['consumed', now, id]);
  }

  async prune(before: Date, limit: number): Promise<number> {
    // 两条各自走索引（idx_mail_flows_expires / idx_mail_flows_consumed），
    // 避免单个 OR 条件退化成全表扫描。分批上限：先删到期，再删已消费，均 LIMIT。
    const [r1] = await this.db().query<any>(
      'DELETE FROM mail_flows WHERE expires_time < ? LIMIT ?',
      [before, limit],
    );
    const removed = Number(r1?.affectedRows ?? 0);
    const remaining = limit - removed;
    if (remaining <= 0) return removed;

    const [r2] = await this.db().query<any>(
      'DELETE FROM mail_flows WHERE consumed_time IS NOT NULL AND consumed_time < ? LIMIT ?',
      [before, remaining],
    );
    return removed + Number(r2?.affectedRows ?? 0);
  }
}

function mapMailFlow(r: any): MailFlow {
  return {
    id: r.id,
    type: r.type as MailFlowType,
    targetTokenHash: r.target_token_hash as Buffer,
    targetRecordId: r.target_record_id == null ? null : Number(r.target_record_id),
    userId: r.user_id == null ? null : Number(r.user_id),
    nonceHash: r.nonce_hash as Buffer,
    status: r.status as MailFlowStatus,
    expiresTime: new Date(r.expires_time),
    consumedTime: r.consumed_time ? new Date(r.consumed_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}