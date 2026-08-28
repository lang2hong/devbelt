import type { IUserRepo } from '../interfaces.js';
import type { User } from '../../domain/entities.js';
import type { UserStatus } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/** 用户仓储（V3：无 role / plan_code / delete_time，邮箱验证由 email_verified_time 表达）。 */
export class MysqlUserRepo implements IUserRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findById(id: number): Promise<User | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM users WHERE id = ?', [id]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async lockById(exec: Queryable, id: number): Promise<User | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM users WHERE id = ? FOR UPDATE', [id]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM users WHERE email = ?', [email]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async create(email: string, passwordHash: string, displayName?: string): Promise<User> {
    const [result] = await this.db().query<any>(
      'INSERT INTO users (email, password_hash, display_name, status) VALUES (?, ?, ?, ?)',
      [email, passwordHash, displayName ?? null, 'active'],
    );
    const u = await this.findById(result.insertId);
    if (!u) throw new Error('user insert failed');
    return u;
  }

  async updateLastLogin(id: number, time: Date): Promise<void> {
    await this.db().query('UPDATE users SET last_login_time = ? WHERE id = ?', [time, id]);
  }

  async updatePassword(exec: Queryable, id: number, passwordHash: string): Promise<void> {
    await exec.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  }

  async updateStatus(id: number, status: UserStatus): Promise<void> {
    await this.db().query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  }

  async markEmailVerified(exec: Queryable, id: number, time: Date): Promise<void> {
    await exec.query('UPDATE users SET email_verified_time = ? WHERE id = ?', [time, id]);
  }
}

function mapUser(r: any): User {
  return {
    id: r.id,
    email: r.email,
    emailVerifiedTime: r.email_verified_time ? new Date(r.email_verified_time) : null,
    passwordHash: r.password_hash,
    displayName: r.display_name ?? undefined,
    status: r.status as UserStatus,
    lastLoginTime: r.last_login_time ? new Date(r.last_login_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}