import type { IOrganizationRepo } from '../interfaces.js';
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
      "INSERT INTO organizations (name, status) VALUES (?, 'active')",
      [input.name],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM organizations WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('organization insert failed');
    return mapOrganization(rows[0]);
  }

  async updateName(exec: Queryable, id: number, name: string): Promise<void> {
    await exec.query('UPDATE organizations SET name = ? WHERE id = ?', [name, id]);
  }

  async close(exec: Queryable, id: number, closedTime: Date): Promise<void> {
    await exec.query("UPDATE organizations SET status = 'closed', closed_time = ? WHERE id = ?", [closedTime, id]);
  }
}

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