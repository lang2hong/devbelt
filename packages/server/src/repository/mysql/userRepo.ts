import type { IUserRepo } from '../interfaces.js';
import type { User } from '../../domain/entities.js';
import type { Role, PlanCode, UserStatus } from '../../domain/enums.js';
import type { MysqlDb } from './db.js';

export class MysqlUserRepo implements IUserRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findById(id: number): Promise<User | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM users WHERE id = ?', [id]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM users WHERE email = ?', [email]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async create(email: string, passwordHash: string, role: Role, planCode: PlanCode): Promise<User> {
    const [result] = await this.db().query<any>(
      'INSERT INTO users (email, password_hash, role, status, plan_code) VALUES (?, ?, ?, ?, ?)',
      [email, passwordHash, role, 'active', planCode],
    );
    const u = await this.findById(result.insertId);
    if (!u) throw new Error('user insert failed');
    return u;
  }

  async updateLastLogin(id: number, time: Date): Promise<void> {
    await this.db().query('UPDATE users SET last_login_time = ? WHERE id = ?', [time, id]);
  }

  async updatePlan(id: number, planCode: PlanCode): Promise<void> {
    await this.db().query('UPDATE users SET plan_code = ? WHERE id = ?', [planCode, id]);
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
    const [rows] = await this.db().query<any[]>('SELECT * FROM users ORDER BY id LIMIT ? OFFSET ?', [limit, offset]);
    return rows.map(mapUser);
  }
}

function mapUser(r: any): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    role: r.role as Role,
    status: r.status as UserStatus,
    planCode: r.plan_code as PlanCode,
    lastLoginTime: r.last_login_time ? new Date(r.last_login_time) : undefined,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
