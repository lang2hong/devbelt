import type { IUserRepo } from '../interfaces.js';
import type { User } from '../../domain/entities.js';
import type { Role, UserStatus } from '../../domain/enums.js';
import type { MysqlDb } from './db.js';

/**
 * 用户仓储。v2：users 表无 plan_code，新增 display_name 与软删除 delete_time。
 * 个人额度由「有效席位套餐最高值」在 policy 层推导，不在此反范式存储。
 */
export class MysqlUserRepo implements IUserRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findById(id: number): Promise<User | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM users WHERE id = ? AND delete_time IS NULL', [id]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM users WHERE email = ? AND delete_time IS NULL', [email]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async create(email: string, passwordHash: string, role: Role, displayName?: string): Promise<User> {
    const [result] = await this.db().query<any>(
      'INSERT INTO users (email, password_hash, display_name, role, status) VALUES (?, ?, ?, ?, ?)',
      [email, passwordHash, displayName ?? null, role, 'active'],
    );
    const u = await this.findById(result.insertId);
    if (!u) throw new Error('user insert failed');
    return u;
  }

  async updateLastLogin(id: number, time: Date): Promise<void> {
    await this.db().query('UPDATE users SET last_login_time = ? WHERE id = ?', [time, id]);
  }

  async updateRole(id: number, role: Role): Promise<void> {
    await this.db().query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  }

  async updatePassword(id: number, passwordHash: string): Promise<void> {
    await this.db().query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  }

  async updateStatus(id: number, status: UserStatus): Promise<void> {
    await this.db().query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  }

  async listAll(limit: number, offset: number): Promise<User[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM users WHERE delete_time IS NULL ORDER BY id LIMIT ? OFFSET ?',
      [limit, offset],
    );
    return rows.map(mapUser);
  }

  async count(): Promise<number> {
    const [rows] = await this.db().query<any[]>('SELECT COUNT(*) AS cnt FROM users WHERE delete_time IS NULL');
    return Number(rows[0]?.cnt ?? 0);
  }

  /**
   * 仍能登录的 admin 数量。
   *
   * status 必须一起过滤：被禁用的 admin 登不进来，把它算进去会让
   * 「最后一个 admin」保护在「一个 active + 一个 disabled」时误放行，
   * 降级掉那个 active 的之后就没人能进后台了。
   */
  async countAdmins(): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      `SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND status = 'active' AND delete_time IS NULL`,
    );
    return Number(rows[0]?.cnt ?? 0);
  }
}

function mapUser(r: any): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    displayName: r.display_name ?? undefined,
    role: r.role as Role,
    status: r.status as UserStatus,
    lastLoginTime: r.last_login_time ? new Date(r.last_login_time) : undefined,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
    deleteTime: r.delete_time ? new Date(r.delete_time) : undefined,
  };
}