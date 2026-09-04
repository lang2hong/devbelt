import type { IEmailVerificationTokenRepo } from '../interfaces.js';
import type { EmailVerificationToken } from '../../domain/entities.js';
import type { EmailVerificationPurpose } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/** 邮箱验证 token 仓储（只存 hash，单次消费，可作废）。写方法在事务（exec）内执行。 */
export class MysqlEmailVerificationTokenRepo implements IEmailVerificationTokenRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(exec: Queryable, input: {
    userId: number;
    email: string;
    purpose: EmailVerificationPurpose;
    tokenHash: string;
    expiresTime: Date;
  }): Promise<EmailVerificationToken> {
    const [result] = await exec.query<any>(
      `INSERT INTO email_verification_tokens (user_id, email, purpose, token_hash, expires_time)
       VALUES (?, ?, ?, ?, ?)`,
      [input.userId, input.email, input.purpose, input.tokenHash, input.expiresTime],
    );
    return this.requireById(exec, result.insertId);
  }

  async findByHash(tokenHash: string): Promise<EmailVerificationToken | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM email_verification_tokens WHERE token_hash = ?',
      [tokenHash],
    );
    return rows[0] ? mapToken(rows[0]) : undefined;
  }

  async findByHashForUpdate(exec: Queryable, tokenHash: string): Promise<EmailVerificationToken | undefined> {
    const [rows] = await exec.query<any[]>(
      'SELECT * FROM email_verification_tokens WHERE token_hash = ? FOR UPDATE',
      [tokenHash],
    );
    return rows[0] ? mapToken(rows[0]) : undefined;
  }

  /**
   * 原子消费：仅当尚未消费且未过期时置 consumed_time，返回是否由本次调用完成。
   */
  async consume(exec: Queryable, id: number, now: Date): Promise<boolean> {
    const [result] = await exec.query<any>(
      'UPDATE email_verification_tokens SET consumed_time = ? WHERE id = ? AND consumed_time IS NULL AND expires_time > ?',
      [now, id, now],
    );
    return result.affectedRows === 1;
  }

  async invalidate(exec: Queryable, userId: number, email: string, purpose: EmailVerificationPurpose, now: Date): Promise<void> {
    await exec.query(
      `UPDATE email_verification_tokens SET consumed_time = ?
       WHERE user_id = ? AND email = ? AND purpose = ? AND consumed_time IS NULL`,
      [now, userId, email, purpose],
    );
  }

  private async requireById(exec: Queryable, id: number): Promise<EmailVerificationToken> {
    const [rows] = await exec.query<any[]>('SELECT * FROM email_verification_tokens WHERE id = ?', [id]);
    if (!rows[0]) throw new Error('email_verification_token insert failed');
    return mapToken(rows[0]);
  }

  /** 清理已消费或已过期的验证 token（分批）。 */
  async prune(before: Date, limit: number): Promise<number> {
    const [result] = await this.db().query<any>(
      `DELETE FROM email_verification_tokens
       WHERE expires_time < ? OR (consumed_time IS NOT NULL AND consumed_time < ?)
       LIMIT ?`,
      [before, before, limit],
    );
    return Number(result?.affectedRows ?? 0);
  }
}

function mapToken(r: any): EmailVerificationToken {
  return {
    id: r.id,
    userId: r.user_id,
    email: r.email,
    purpose: r.purpose as EmailVerificationPurpose,
    tokenHash: r.token_hash,
    expiresTime: new Date(r.expires_time),
    consumedTime: r.consumed_time ? new Date(r.consumed_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}