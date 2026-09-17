import type { IOrganizationRepo, AdminOrgFilter, AdminOrgRow } from '../../../repository/interfaces.js';
import type { Organization } from '../../../domain/entities.js';
import type { OrganizationStatus } from '../../../domain/enums.js';
import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';

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

  /** 关闭组织（终态、不可逆）：status='closed' + closed_time。 */
  async close(exec: Queryable, id: number, closedTime: Date): Promise<void> {
    await exec.query("UPDATE organizations SET status = 'closed', closed_time = ? WHERE id = ? AND status = 'active'", [closedTime, id]);
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

/** 行 → 实体。状态直接来自 `status` / `closed_time`（CHECK 保证二者一致）。 */
function mapOrganization(r: any): Organization {
  return {
    id: r.id,
    name: r.name,
    status: r.status as OrganizationStatus,
    closedTime: r.closed_time ? new Date(r.closed_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}

function mapAdminOrgRow(r: any): AdminOrgRow {
  return {
    organizationId: r.id,
    name: r.name,
    status: r.status as OrganizationStatus,
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
  if (input.status === 'active') where.push("o.status = 'active'");
  else if (input.status === 'closed') where.push("o.status = 'closed'");
  if (input.planCode) {
    where.push('o.id IN (SELECT os.organization_id FROM organization_subscriptions os JOIN plans pl ON pl.id = os.plan_id WHERE pl.code = ?)');
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
    SELECT o.id, o.name, o.status, o.closed_time, o.create_time, pl.code AS plan_code, os.seat_limit,
           os.version AS subscription_version, os.period_end_time AS period_end_time,
           (SELECT COUNT(*) FROM organization_memberships m WHERE m.organization_id = o.id AND m.status = 'active') AS active_members,
           (SELECT COUNT(*) FROM organization_memberships m WHERE m.organization_id = o.id AND m.status = 'invited') AS invited_count
    FROM organizations o
    LEFT JOIN organization_subscriptions os ON os.organization_id = o.id
    LEFT JOIN plans pl ON pl.id = os.plan_id
    ${whereSql}
    ORDER BY o.id DESC
    LIMIT ${Number(input.limit ?? 50)}
  `;
  return { sql, params };
}