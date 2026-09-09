import type { IOrganizationRepo, AdminOrgFilter, AdminOrgRow } from '../interfaces.js';
import type { Organization } from '../../domain/entities.js';
import type { OrganizationStatus } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/** 组织仓储。成员变更 / 关闭通过 `lockById` 锁组织行串行化。 */
export class MysqlOrganizationRepo implements IOrganizationRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findById(id: number): Promise<Organization | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM organizations WHERE id = ?', [id]);
    return rows[0] ? mapOrganization(rows[0]) : undefined;
  }

  async lockById(exec: Queryable, id: number): Promise<Organization | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM organizations WHERE id = ? FOR UPDATE', [id]);
    return rows[0] ? mapOrganization(rows[0]) : undefined;
  }

  async create(exec: Queryable, input: { name: string }): Promise<Organization> {
    const [result] = await exec.query<any>(
      'INSERT INTO organizations (name) VALUES (?)',
      [input.name],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM organizations WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('organization insert failed');
    return mapOrganization(rows[0]);
  }

  async updateName(exec: Queryable, id: number, name: string): Promise<void> {
    await exec.query('UPDATE organizations SET name = ? WHERE id = ?', [name, id]);
  }

  /** 关闭组织 = 软删除。只写 delete_time；status/closedTime 由 mapper 派生。 */
  async close(exec: Queryable, id: number, closedTime: Date): Promise<void> {
    await exec.query('UPDATE organizations SET delete_time = ? WHERE id = ? AND delete_time IS NULL', [closedTime, id]);
  }

  async listForAdmin(input: AdminOrgFilter): Promise<AdminOrgRow[]> {
    const { sql, params } = buildAdminOrgFilter(input, false);
    const [rows] = await this.db().query<any[]>(sql, params);
    return rows.map(mapAdminOrgRow);
  }

  async countForAdmin(input: Omit<AdminOrgFilter, 'cursor' | 'limit'>): Promise<number> {
    const { sql, params } = buildAdminOrgFilter(input, true);
    const [rows] = await this.db().query<any[]>(sql, params);
    return Number(rows[0]?.cnt ?? 0);
  }
}

/**
 * 行 → 实体。`status` / `closedTime` 是**派生**字段：库里只有 delete_time 一列，
 * 这样不可能出现两列互相矛盾。领域层与 API 的形状保持不变。
 */
function mapOrganization(r: any): Organization {
  const deleteTime = r.delete_time ? new Date(r.delete_time) : null;
  return {
    id: r.id,
    name: r.name,
    status: (deleteTime ? 'closed' : 'active') as OrganizationStatus,
    closedTime: deleteTime,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}

function mapAdminOrgRow(r: any): AdminOrgRow {
  const closed = r.delete_time != null;
  return {
    organizationId: r.id,
    name: r.name,
    status: (closed ? 'closed' : 'active') as OrganizationStatus,
    planCode: r.plan_code ?? null,
    seatLimit: r.seat_limit == null ? null : Number(r.seat_limit),
    activeMemberCount: Number(r.active_members ?? 0),
    invitedCount: Number(r.invited_count ?? 0),
    createTime: new Date(r.create_time),
    subscriptionVersion: r.subscription_version == null ? null : Number(r.subscription_version),
    periodEndTime: r.period_end_time ? new Date(r.period_end_time) : null,
  };
}

function buildAdminOrgFilter(input: Omit<AdminOrgFilter, 'cursor' | 'limit'> & { cursor?: number; limit?: number }, countOnly: boolean): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (input.namePrefix) {
    where.push('o.name LIKE ?');
    params.push(`${input.namePrefix}%`);
  }
  if (input.status === 'active') where.push('o.delete_time IS NULL');
  else if (input.status === 'closed') where.push('o.delete_time IS NOT NULL');
  if (input.planCode) {
    where.push('o.id IN (SELECT os.organization_id FROM organization_subscriptions os JOIN organization_plans op ON op.id = os.plan_id WHERE op.code = ?)');
    params.push(input.planCode);
  }
  if (input.cursor !== undefined) {
    where.push('o.id < ?');
    params.push(input.cursor);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  if (countOnly) {
    return { sql: `SELECT COUNT(*) AS cnt FROM organizations o ${whereSql}`, params };
  }

  const sql = `
    SELECT o.id, o.name, o.delete_time, o.create_time, op.code AS plan_code, os.seat_limit,
           os.version AS subscription_version, os.period_end_time AS period_end_time,
           (SELECT COUNT(*) FROM organization_memberships m WHERE m.organization_id = o.id AND m.status = 'active') AS active_members,
           (SELECT COUNT(*) FROM organization_memberships m WHERE m.organization_id = o.id AND m.status = 'invited') AS invited_count
    FROM organizations o
    LEFT JOIN organization_subscriptions os ON os.organization_id = o.id
    LEFT JOIN organization_plans op ON op.id = os.plan_id
    ${whereSql}
    ORDER BY o.id DESC
    LIMIT ${Number(input.limit ?? 50)}
  `;
  return { sql, params };
}