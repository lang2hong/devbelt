import type { IMembershipRepo, MemberDto, OrganizationSummary } from '../../../repository/interfaces.js';
import type { OrganizationMembership } from '../../../domain/entities.js';
import type { OrganizationRole, OrganizationMembershipStatus } from '../../../domain/enums.js';
import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';

/** 组织成员关系仓储。写方法在事务（exec）内执行。 */
export class MysqlMembershipRepo implements IMembershipRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(exec: Queryable, input: {
    organizationId: number;
    userId: number;
    role: OrganizationRole;
    status: OrganizationMembershipStatus;
    invitedByUserId: number | null;
    joinedTime: Date | null;
    removedTime: Date | null;
  }): Promise<OrganizationMembership> {
    const [result] = await exec.query<any>(
      `INSERT INTO organization_memberships (organization_id, user_id, role, status, invited_by_user_id, joined_time, removed_time)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.organizationId, input.userId, input.role, input.status, input.invitedByUserId, input.joinedTime, input.removedTime],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM organization_memberships WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('membership insert failed');
    return mapMembership(rows[0]);
  }

  async listByOrganization(organizationId: number): Promise<MemberDto[]> {
    const [rows] = await this.db().query<any[]>(
      `SELECT m.id, m.user_id, m.role, m.status, m.joined_time, u.display_name
       FROM organization_memberships m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = ? AND m.status IN ('active', 'invited')
       ORDER BY m.id`,
      [organizationId],
    );
    return rows.map((r: any) => ({
      membershipId: r.id,
      userId: r.user_id,
      displayName: r.display_name ?? undefined,
      role: r.role as OrganizationRole,
      status: r.status as OrganizationMembershipStatus,
      joinedTime: r.joined_time ? new Date(r.joined_time) : null,
    }));
  }

  async listActiveByUser(userId: number): Promise<OrganizationMembership[]> {
    const [rows] = await this.db().query<any[]>(
      "SELECT * FROM organization_memberships WHERE user_id = ? AND status = 'active'",
      [userId],
    );
    return rows.map(mapMembership);
  }

  async listActiveByUserWithOrg(userId: number): Promise<OrganizationSummary[]> {
    const [rows] = await this.db().query<any[]>(
      // 组织生命周期现为 status('active','closed') + closed_time。
      `SELECT o.id, o.name, o.status, o.closed_time, m.role
       FROM organization_memberships m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = ? AND m.status = 'active' AND o.status = 'active'
       ORDER BY o.id`,
      [userId],
    );
    return rows.map((r: any) => ({
      organizationId: r.id,
      name: r.name,
      status: r.status,
      closedTime: r.closed_time ? new Date(r.closed_time) : null,
      role: r.role as OrganizationRole,
    }));
  }

  async findByOrgAndUser(organizationId: number, userId: number): Promise<OrganizationMembership | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM organization_memberships WHERE organization_id = ? AND user_id = ?',
      [organizationId, userId],
    );
    return rows[0] ? mapMembership(rows[0]) : undefined;
  }

  async findByOrgAndUserForUpdate(exec: Queryable, organizationId: number, userId: number): Promise<OrganizationMembership | undefined> {
    const [rows] = await exec.query<any[]>(
      'SELECT * FROM organization_memberships WHERE organization_id = ? AND user_id = ? FOR UPDATE',
      [organizationId, userId],
    );
    return rows[0] ? mapMembership(rows[0]) : undefined;
  }

  async findByIdForUpdate(exec: Queryable, id: number): Promise<OrganizationMembership | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM organization_memberships WHERE id = ? FOR UPDATE', [id]);
    return rows[0] ? mapMembership(rows[0]) : undefined;
  }

  async updateRole(exec: Queryable, id: number, role: OrganizationRole): Promise<void> {
    await exec.query('UPDATE organization_memberships SET role = ? WHERE id = ?', [role, id]);
  }

  async remove(exec: Queryable, id: number, now: Date): Promise<void> {
    await exec.query("UPDATE organization_memberships SET status = 'removed', removed_time = ? WHERE id = ?", [now, id]);
  }

  async removeInvitedByOrganization(exec: Queryable, organizationId: number, now: Date): Promise<void> {
    await exec.query(
      "UPDATE organization_memberships SET status = 'removed', removed_time = ? WHERE organization_id = ? AND status = 'invited'",
      [now, organizationId],
    );
  }

  async upsertInvited(exec: Queryable, input: {
    organizationId: number;
    userId: number;
    role: OrganizationRole;
    invitedByUserId: number;
  }): Promise<OrganizationMembership> {
    await exec.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role, status, invited_by_user_id, joined_time, removed_time)
       VALUES (?, ?, ?, 'invited', ?, NULL, NULL)
       ON DUPLICATE KEY UPDATE
         role = VALUES(role),
         status = 'invited',
         invited_by_user_id = VALUES(invited_by_user_id),
         joined_time = NULL,
         removed_time = NULL`,
      [input.organizationId, input.userId, input.role, input.invitedByUserId],
    );
    const [rows] = await exec.query<any[]>(
      'SELECT * FROM organization_memberships WHERE organization_id = ? AND user_id = ?',
      [input.organizationId, input.userId],
    );
    if (!rows[0]) throw new Error('membership upsert failed');
    return mapMembership(rows[0]);
  }

  async activate(exec: Queryable, id: number, now: Date): Promise<void> {
    await exec.query(
      "UPDATE organization_memberships SET status = 'active', joined_time = ?, removed_time = NULL WHERE id = ?",
      [now, id],
    );
  }

  async countActive(exec: Queryable, organizationId: number): Promise<number> {
    const [rows] = await exec.query<any[]>(
      "SELECT COUNT(*) AS cnt FROM organization_memberships WHERE organization_id = ? AND status = 'active'",
      [organizationId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async countValidInvited(exec: Queryable, organizationId: number, now: Date): Promise<number> {
    const [rows] = await exec.query<any[]>(
      `SELECT COUNT(*) AS cnt
       FROM organization_memberships m
       JOIN organization_invitations i ON i.membership_id = m.id AND i.organization_id = m.organization_id
       WHERE m.organization_id = ? AND m.status = 'invited'
         AND i.accepted_time IS NULL AND i.revoked_time IS NULL AND i.expires_time > ?`,
      [organizationId, now],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async countActiveAdmins(exec: Queryable, organizationId: number): Promise<number> {
    const [rows] = await exec.query<any[]>(
      "SELECT COUNT(*) AS cnt FROM organization_memberships WHERE organization_id = ? AND role = 'admin' AND status = 'active'",
      [organizationId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }
}

function mapMembership(r: any): OrganizationMembership {
  return {
    id: r.id,
    organizationId: r.organization_id,
    userId: r.user_id,
    role: r.role as OrganizationRole,
    status: r.status as OrganizationMembershipStatus,
    invitedByUserId: r.invited_by_user_id ?? null,
    joinedTime: r.joined_time ? new Date(r.joined_time) : null,
    removedTime: r.removed_time ? new Date(r.removed_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}