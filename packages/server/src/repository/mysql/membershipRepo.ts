import type { IMembershipRepo, MembershipInput } from '../interfaces.js';
import type { Membership } from '../../domain/entities.js';
import type { MemberRole, MemberStatus } from '../../domain/enums.js';
import type { MysqlDb } from './db.js';

/**
 * 成员仓储（成员对席位的占用由此表表达）（已接入运行时）。
 *
 * 列名与 001_initial_schema.ts 的 memberships 表逐列对齐。
 * 软删除走 `delete_time`；活跃判定 = status='active' AND delete_time IS NULL。
 */
export class MysqlMembershipRepo implements IMembershipRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findById(id: number): Promise<Membership | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM memberships WHERE id = ? AND delete_time IS NULL', [id]);
    return rows[0] ? mapMembership(rows[0]) : undefined;
  }

  async findByOrgAndUser(organizationId: number, userId: number): Promise<Membership | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM memberships WHERE organization_id = ? AND user_id = ? AND delete_time IS NULL',
      [organizationId, userId],
    );
    return rows[0] ? mapMembership(rows[0]) : undefined;
  }

  async listByOrganization(organizationId: number): Promise<Membership[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM memberships WHERE organization_id = ? AND delete_time IS NULL ORDER BY id',
      [organizationId],
    );
    return rows.map(mapMembership);
  }

  async listByUser(userId: number): Promise<Membership[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM memberships WHERE user_id = ? AND delete_time IS NULL ORDER BY id',
      [userId],
    );
    return rows.map(mapMembership);
  }

  async create(input: MembershipInput): Promise<Membership> {
    const [result] = await this.db().query<any>(
      'INSERT INTO memberships (organization_id, user_id, role, status) VALUES (?, ?, ?, ?)',
      [input.organizationId, input.userId, input.role, 'active'],
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('membership insert failed');
    return created;
  }

  async updateRole(id: number, role: MemberRole): Promise<void> {
    await this.db().query('UPDATE memberships SET role = ? WHERE id = ?', [role, id]);
  }

  async updateStatus(id: number, status: MemberStatus): Promise<void> {
    await this.db().query('UPDATE memberships SET status = ? WHERE id = ?', [status, id]);
  }

  async softDelete(id: number): Promise<void> {
    await this.db().query('UPDATE memberships SET delete_time = NOW() WHERE id = ? AND delete_time IS NULL', [id]);
  }

  async countActiveByOrganization(organizationId: number): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      `SELECT COUNT(*) AS cnt FROM memberships
       WHERE organization_id = ? AND status = 'active' AND delete_time IS NULL`,
      [organizationId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async countActiveByUser(userId: number): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      `SELECT COUNT(*) AS cnt FROM memberships
       WHERE user_id = ? AND status = 'active' AND delete_time IS NULL`,
      [userId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }
}

function mapMembership(r: any): Membership {
  return {
    id: r.id,
    organizationId: r.organization_id,
    userId: r.user_id,
    role: r.role as MemberRole,
    status: r.status as MemberStatus,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
    deleteTime: r.delete_time ? new Date(r.delete_time) : undefined,
  };
}
