import type { IUserRepo, AdminUserFilter, AdminUserRow } from '../interfaces.js';
import type { User } from '../../domain/entities.js';
import type { UserStatus, UserRole } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/** 用户仓储。邮箱验证由 email_verified_time 表达。 */
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

  async findByIdInTx(exec: Queryable, id: number): Promise<User | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM users WHERE id = ?', [id]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async findByEmailInTx(exec: Queryable, email: string): Promise<User | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM users WHERE email = ?', [email]);
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

  async updateStatusInTx(exec: Queryable, id: number, status: UserStatus): Promise<void> {
    await exec.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  }

  async setRole(id: number, role: UserRole): Promise<void> {
    await this.db().query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  }

  async markEmailVerified(exec: Queryable, id: number, time: Date): Promise<void> {
    await exec.query('UPDATE users SET email_verified_time = ? WHERE id = ?', [time, id]);
  }

  async incrementSessionVersion(exec: Queryable, id: number): Promise<void> {
    await exec.query('UPDATE users SET session_version = session_version + 1 WHERE id = ?', [id]);
  }

  async updateDisplayName(id: number, displayName: string): Promise<void> {
    await this.db().query('UPDATE users SET display_name = ? WHERE id = ?', [displayName, id]);
  }

  async updateDisplayNameInTx(exec: Queryable, id: number, displayName: string): Promise<void> {
    await exec.query('UPDATE users SET display_name = ? WHERE id = ?', [displayName, id]);
  }

  async listUsers(input: AdminUserFilter): Promise<AdminUserRow[]> {
    const { sql, params } = buildUserFilter(input, false);
    const [rows] = await this.db().query<any[]>(sql, params);
    return rows.map(mapAdminUserRow);
  }

  async countUsers(input: Omit<AdminUserFilter, 'cursor' | 'limit'>): Promise<number> {
    const { sql, params } = buildUserFilter(input, true);
    const [rows] = await this.db().query<any[]>(sql, params);
    return Number(rows[0]?.cnt ?? 0);
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
    role: (r.role as UserRole) ?? 'user',
    lastLoginTime: r.last_login_time ? new Date(r.last_login_time) : null,
    sessionVersion: Number(r.session_version ?? 0),
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}

function mapAdminUserRow(r: any): AdminUserRow {
  return {
    userId: r.id,
    email: r.email,
    emailVerifiedTime: r.email_verified_time ? new Date(r.email_verified_time) : null,
    displayName: r.display_name ?? undefined,
    status: r.status as UserStatus,
    role: (r.role as UserRole) ?? 'user',
    lastLoginTime: r.last_login_time ? new Date(r.last_login_time) : null,
    createTime: new Date(r.create_time),
    planCode: r.plan_code ?? null,
    deviceCount: Number(r.device_count ?? 0),
    subscriptionVersion: r.subscription_version == null ? null : Number(r.subscription_version),
    periodEndTime: r.period_end_time ? new Date(r.period_end_time) : null,
  };
}

/** 构建平台用户查询：子查询取 plan code 与 active 设备数；keyset cursor 按 id DESC。 */
function buildUserFilter(input: Omit<AdminUserFilter, 'cursor' | 'limit'> & { cursor?: number; limit?: number }, countOnly: boolean): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (input.userId !== undefined) {
    where.push('u.id = ?');
    params.push(input.userId);
  }
  if (input.emailExact) {
    where.push('u.email = ?');
    params.push(input.emailExact.toLowerCase());
  }
  if (input.status !== undefined) {
    where.push('u.status = ?');
    params.push(input.status);
  }
  if (input.createdFrom) {
    where.push('u.create_time >= ?');
    params.push(input.createdFrom);
  }
  if (input.createdTo) {
    where.push('u.create_time <= ?');
    params.push(input.createdTo);
  }
  if (input.planCode) {
    where.push('u.id IN (SELECT ps.user_id FROM personal_subscriptions ps JOIN plans pp ON pp.id = ps.plan_id WHERE pp.code = ?)');
    params.push(input.planCode);
  }
  if (input.cursor !== undefined) {
    where.push('u.id < ?');
    params.push(input.cursor);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  if (countOnly) {
    return { sql: `SELECT COUNT(*) AS cnt FROM users u ${whereSql}`, params };
  }

  const sql = `
    SELECT u.id, u.email, u.email_verified_time, u.display_name, u.status, u.role,
           u.last_login_time, u.create_time, pp.code AS plan_code,
           ps.version AS subscription_version, ps.period_end_time AS period_end_time,
           (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.status = 'active') AS device_count
    FROM users u
    LEFT JOIN personal_subscriptions ps ON ps.user_id = u.id
    LEFT JOIN plans pp ON pp.id = ps.plan_id
    ${whereSql}
    ORDER BY u.id DESC
    LIMIT ${Number(input.limit ?? 50)}
  `;
  return { sql, params };
}