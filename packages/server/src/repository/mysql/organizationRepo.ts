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