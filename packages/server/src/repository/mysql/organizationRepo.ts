import type { IOrganizationRepo, OrganizationInput, OrganizationEditableFields } from '../interfaces.js';
import type { Organization } from '../../domain/entities.js';
import type { MysqlDb } from './db.js';

/**
 * 组织仓储（计费主体）（已接入运行时）。
 *
 * 列名与 001_initial_schema.ts 的 organizations 表逐列对齐。软删除走
 * `delete_time`（NULL=未删）；status 沿用 UserStatus 的 active/disabled 约定。
 */
export class MysqlOrganizationRepo implements IOrganizationRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findById(id: number): Promise<Organization | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM organizations WHERE id = ? AND delete_time IS NULL', [id]);
    return rows[0] ? mapOrganization(rows[0]) : undefined;
  }

  async listByOwner(userId: number): Promise<Organization[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM organizations WHERE owner_user_id = ? AND delete_time IS NULL ORDER BY id',
      [userId],
    );
    return rows.map(mapOrganization);
  }

  async create(input: OrganizationInput): Promise<Organization> {
    const [result] = await this.db().query<any>(
      'INSERT INTO organizations (name, type, owner_user_id, status) VALUES (?, ?, ?, ?)',
      [input.name, input.type, input.ownerUserId, 'active'],
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('organization insert failed');
    return created;
  }

  async update(id: number, fields: OrganizationEditableFields): Promise<void> {
    await this.db().query('UPDATE organizations SET name = ?, status = ? WHERE id = ?', [
      fields.name,
      fields.status,
      id,
    ]);
  }

  async softDelete(id: number): Promise<void> {
    await this.db().query('UPDATE organizations SET delete_time = NOW() WHERE id = ? AND delete_time IS NULL', [id]);
  }

  async listAll(limit: number, offset: number): Promise<Organization[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM organizations WHERE delete_time IS NULL ORDER BY id LIMIT ? OFFSET ?',
      [limit, offset],
    );
    return rows.map(mapOrganization);
  }

  async count(): Promise<number> {
    const [rows] = await this.db().query<any[]>('SELECT COUNT(*) AS cnt FROM organizations WHERE delete_time IS NULL');
    return Number(rows[0]?.cnt ?? 0);
  }
}

function mapOrganization(r: any): Organization {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    ownerUserId: r.owner_user_id,
    status: r.status,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
    deleteTime: r.delete_time ? new Date(r.delete_time) : undefined,
  };
}
