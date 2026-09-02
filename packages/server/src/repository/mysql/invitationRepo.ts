import type { IOrganizationInvitationRepo, InvitationDto } from '../interfaces.js';
import type { OrganizationInvitation } from '../../domain/entities.js';
import type { OrganizationRole } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/**
 * 组织邀请仓储。
 *
 * 写方法在事务 `exec` 内执行。过期清理由 OrganizationService 按组织维度协调
 * （锁组织 + 订阅后调用 `expireByOrganization`），本仓储不自行发起事务。
 * token_hash 只存 SHA-256，明文不进 DB。
 */
export class MysqlOrganizationInvitationRepo implements IOrganizationInvitationRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(exec: Queryable, input: {
    organizationId: number;
    membershipId: number;
    email: string;
    tokenHash: string;
    expiresTime: Date;
  }): Promise<OrganizationInvitation> {
    const [result] = await exec.query<any>(
      `INSERT INTO organization_invitations (organization_id, membership_id, email, token_hash, expires_time)
       VALUES (?, ?, ?, ?, ?)`,
      [input.organizationId, input.membershipId, input.email, input.tokenHash, input.expiresTime],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM organization_invitations WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('organization_invitation insert failed');
    return mapInvitation(rows[0]);
  }

  async findByTokenHash(tokenHash: string): Promise<OrganizationInvitation | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM organization_invitations WHERE token_hash = ?', [tokenHash]);
    return rows[0] ? mapInvitation(rows[0]) : undefined;
  }

  async findById(id: number): Promise<OrganizationInvitation | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM organization_invitations WHERE id = ?', [id]);
    return rows[0] ? mapInvitation(rows[0]) : undefined;
  }

  async findByIdForUpdate(exec: Queryable, id: number): Promise<OrganizationInvitation | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM organization_invitations WHERE id = ? FOR UPDATE', [id]);
    return rows[0] ? mapInvitation(rows[0]) : undefined;
  }

  async findByTokenHashForUpdate(exec: Queryable, tokenHash: string): Promise<OrganizationInvitation | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM organization_invitations WHERE token_hash = ? FOR UPDATE', [tokenHash]);
    return rows[0] ? mapInvitation(rows[0]) : undefined;
  }

  async revokeByMembership(exec: Queryable, membershipId: number, now: Date): Promise<void> {
    await exec.query(
      'UPDATE organization_invitations SET revoked_time = ? WHERE membership_id = ? AND accepted_time IS NULL AND revoked_time IS NULL',
      [now, membershipId],
    );
  }

  async revokeByOrganization(exec: Queryable, organizationId: number, now: Date): Promise<void> {
    await exec.query(
      'UPDATE organization_invitations SET revoked_time = ? WHERE organization_id = ? AND accepted_time IS NULL AND revoked_time IS NULL',
      [now, organizationId],
    );
  }

  async markAccepted(exec: Queryable, id: number, now: Date): Promise<void> {
    await exec.query('UPDATE organization_invitations SET accepted_time = ? WHERE id = ?', [now, id]);
  }

  async markRevoked(exec: Queryable, id: number, now: Date): Promise<void> {
    await exec.query('UPDATE organization_invitations SET revoked_time = ? WHERE id = ?', [now, id]);
  }

  async listActiveByOrganization(organizationId: number, now: Date): Promise<InvitationDto[]> {
    const [rows] = await this.db().query<any[]>(
      `SELECT i.id, i.email, i.expires_time, i.create_time, m.role
       FROM organization_invitations i
       JOIN organization_memberships m ON m.id = i.membership_id AND m.organization_id = i.organization_id
       WHERE i.organization_id = ? AND i.accepted_time IS NULL AND i.revoked_time IS NULL AND i.expires_time > ?
       ORDER BY i.id`,
      [organizationId, now],
    );
    return rows.map((r: any) => ({
      invitationId: r.id,
      email: r.email,
      role: r.role as OrganizationRole,
      expiresTime: new Date(r.expires_time),
      invitedTime: new Date(r.create_time),
    }));
  }

  async hasValidInvitation(exec: Queryable, membershipId: number, now: Date): Promise<boolean> {
    const [rows] = await exec.query<any[]>(
      'SELECT id FROM organization_invitations WHERE membership_id = ? AND accepted_time IS NULL AND revoked_time IS NULL AND expires_time > ? LIMIT 1',
      [membershipId, now],
    );
    return rows.length > 0;
  }

  async findExpiredOrganizationIds(now: Date): Promise<number[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT DISTINCT organization_id FROM organization_invitations WHERE expires_time <= ? AND accepted_time IS NULL AND revoked_time IS NULL',
      [now],
    );
    return rows.map((r: any) => r.organization_id as number);
  }

  async expireByOrganization(exec: Queryable, organizationId: number, now: Date): Promise<void> {
    await exec.query(
      `UPDATE organization_invitations i
       JOIN organization_memberships m ON m.id = i.membership_id AND m.organization_id = i.organization_id
       SET i.revoked_time = ?, m.status = 'removed', m.removed_time = ?
       WHERE i.organization_id = ? AND i.expires_time <= ? AND i.accepted_time IS NULL AND i.revoked_time IS NULL`,
      [now, now, organizationId, now],
    );
  }
}

function mapInvitation(r: any): OrganizationInvitation {
  return {
    id: r.id,
    organizationId: r.organization_id,
    membershipId: r.membership_id,
    email: r.email,
    tokenHash: r.token_hash,
    expiresTime: new Date(r.expires_time),
    acceptedTime: r.accepted_time ? new Date(r.accepted_time) : null,
    revokedTime: r.revoked_time ? new Date(r.revoked_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
