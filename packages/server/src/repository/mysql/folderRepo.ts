import type { IFolderRepo } from '../interfaces.js';
import type { Folder } from '../../domain/entities.js';
import type { MysqlDb, Queryable } from './db.js';

/**
 * 组织目录仓储（切片 4）。表规范名 `organization_resource_folders`（§4.1）。
 *
 * 所有写方法在事务 `exec` 内执行；软删除置 delete_time。移动/环检测的祖先链锁定
 * 由 ResourceService 在组织行锁之后按 id 升序获取，本仓储只提供所需查询。
 */
export class MysqlFolderRepo implements IFolderRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(exec: Queryable, input: { organizationId: number; parentId: number | null; name: string }): Promise<Folder> {
    const [result] = await exec.query<any>(
      `INSERT INTO organization_resource_folders (organization_id, parent_id, name)
       VALUES (?, ?, ?)`,
      [input.organizationId, input.parentId, input.name],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM organization_resource_folders WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('organization_resource_folder insert failed');
    return mapFolder(rows[0]);
  }

  async findByIdForUpdate(exec: Queryable, organizationId: number, id: number): Promise<Folder | undefined> {
    const [rows] = await exec.query<any[]>(
      'SELECT * FROM organization_resource_folders WHERE id = ? AND organization_id = ? FOR UPDATE',
      [id, organizationId],
    );
    return rows[0] ? mapFolder(rows[0]) : undefined;
  }

  async listActive(organizationId: number): Promise<Folder[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM organization_resource_folders WHERE organization_id = ? AND delete_time IS NULL ORDER BY id',
      [organizationId],
    );
    return rows.map(mapFolder);
  }

  async countActiveChildren(exec: Queryable, organizationId: number, parentId: number): Promise<number> {
    const [rows] = await exec.query<any[]>(
      'SELECT COUNT(*) AS cnt FROM organization_resource_folders WHERE organization_id = ? AND parent_id = ? AND delete_time IS NULL',
      [organizationId, parentId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async countActiveResources(exec: Queryable, organizationId: number, folderId: number): Promise<number> {
    const [rows] = await exec.query<any[]>(
      'SELECT COUNT(*) AS cnt FROM organization_resources WHERE organization_id = ? AND folder_id = ? AND delete_time IS NULL',
      [organizationId, folderId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async updateName(exec: Queryable, id: number, name: string, organizationId: number): Promise<void> {
    await exec.query('UPDATE organization_resource_folders SET name = ? WHERE id = ? AND organization_id = ?', [name, id, organizationId]);
  }

  async updateParent(exec: Queryable, id: number, parentId: number | null, organizationId: number): Promise<void> {
    await exec.query('UPDATE organization_resource_folders SET parent_id = ? WHERE id = ? AND organization_id = ?', [parentId, id, organizationId]);
  }

  async softDelete(exec: Queryable, id: number, organizationId: number, now: Date): Promise<void> {
    await exec.query(
      'UPDATE organization_resource_folders SET delete_time = ? WHERE id = ? AND organization_id = ? AND delete_time IS NULL',
      [now, id, organizationId],
    );
  }

  async collectDescendantIds(exec: Queryable, organizationId: number, folderId: number): Promise<number[]> {
    const [rows] = await exec.query<any[]>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM organization_resource_folders WHERE organization_id = ? AND id = ? AND delete_time IS NULL
         UNION ALL
         SELECT f.id FROM organization_resource_folders f
         JOIN tree t ON f.parent_id = t.id
         WHERE f.organization_id = ? AND f.delete_time IS NULL
       )
       SELECT id FROM tree`,
      [organizationId, folderId, organizationId],
    );
    return rows.map((r: any) => r.id as number);
  }
}

function mapFolder(r: any): Folder {
  return {
    id: r.id,
    organizationId: r.organization_id,
    parentId: r.parent_id ?? null,
    name: r.name,
    deleteTime: r.delete_time ? new Date(r.delete_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}