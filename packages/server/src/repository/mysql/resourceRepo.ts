import type { IResourceRepo, ResourceSummaryDto } from '../interfaces.js';
import type { Resource } from '../../domain/entities.js';
import type { ResourceType } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/**
 * 组织资源仓储。表名 `organization_resources`。
 *
 * content 列是 JSON（mysql2 以字符串返回，读写时 JSON.parse / JSON.stringify）。
 * 字节配额不在 SQL 内 `SUM(LENGTH(content))`（§6.2 要求 canonical JSON 逐字节精确），
 * 而是锁内读回 content 由服务层 `canonicalJson()` 求和 —— 见 listActiveContent。
 */
export class MysqlResourceRepo implements IResourceRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(exec: Queryable, input: {
    organizationId: number;
    folderId: number | null;
    resourceType: ResourceType;
    name: string;
    content: Record<string, unknown>;
    version: number;
    createdByMembershipId: number;
  }): Promise<Resource> {
    const [result] = await exec.query<any>(
      `INSERT INTO organization_resources (organization_id, folder_id, resource_type, name, content, version, created_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.organizationId,
        input.folderId,
        input.resourceType,
        input.name,
        JSON.stringify(input.content),
        input.version,
        input.createdByMembershipId,
      ],
    );
    const [rows] = await exec.query<any[]>('SELECT * FROM organization_resources WHERE id = ?', [result.insertId]);
    if (!rows[0]) throw new Error('organization_resource insert failed');
    return mapResource(rows[0]);
  }

  async findById(organizationId: number, id: number): Promise<Resource | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM organization_resources WHERE id = ? AND organization_id = ?', [id, organizationId]);
    return rows[0] ? mapResource(rows[0]) : undefined;
  }

  async findByIdForUpdate(exec: Queryable, organizationId: number, id: number): Promise<Resource | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM organization_resources WHERE id = ? AND organization_id = ? FOR UPDATE', [id, organizationId]);
    return rows[0] ? mapResource(rows[0]) : undefined;
  }

  async listActiveByOrganization(organizationId: number): Promise<ResourceSummaryDto[]> {
    const [rows] = await this.db().query<any[]>(
      `SELECT id, organization_id, folder_id, resource_type, name, version, created_by_membership_id, updated_by_membership_id
       FROM organization_resources
       WHERE organization_id = ? AND delete_time IS NULL
       ORDER BY id`,
      [organizationId],
    );
    return rows.map(mapSummary);
  }

  async listActiveContent(exec: Queryable, organizationId: number): Promise<Record<string, unknown>[]> {
    const [rows] = await exec.query<any[]>(
      'SELECT content FROM organization_resources WHERE organization_id = ? AND delete_time IS NULL',
      [organizationId],
    );
    return rows.map((r: any) => (typeof r.content === 'string' ? JSON.parse(r.content) : r.content) as Record<string, unknown>);
  }

  async update(exec: Queryable, input: {
    id: number;
    organizationId: number;
    name: string;
    folderId: number | null;
    content: Record<string, unknown>;
    baseVersion: number;
    updatedByMembershipId: number;
  }): Promise<boolean> {
    const [result] = await exec.query<any>(
      `UPDATE organization_resources
       SET name = ?, folder_id = ?, content = ?, version = ?, updated_by_membership_id = ?
       WHERE id = ? AND organization_id = ? AND version = ? AND delete_time IS NULL`,
      [
        input.name,
        input.folderId,
        JSON.stringify(input.content),
        input.baseVersion + 1,
        input.updatedByMembershipId,
        input.id,
        input.organizationId,
        input.baseVersion,
      ],
    );
    return result.affectedRows > 0;
  }

  async softDelete(exec: Queryable, id: number, organizationId: number, now: Date, deletedByMembershipId: number): Promise<void> {
    await exec.query(
      'UPDATE organization_resources SET delete_time = ?, updated_by_membership_id = ? WHERE id = ? AND organization_id = ? AND delete_time IS NULL',
      [now, deletedByMembershipId, id, organizationId],
    );
  }
}

function mapResource(r: any): Resource {
  return {
    id: r.id,
    organizationId: r.organization_id,
    folderId: r.folder_id ?? null,
    resourceType: r.resource_type as ResourceType,
    name: r.name,
    content: (typeof r.content === 'string' ? JSON.parse(r.content) : r.content) as Record<string, unknown>,
    version: r.version,
    createdByMembershipId: r.created_by_membership_id,
    updatedByMembershipId: r.updated_by_membership_id ?? null,
    deleteTime: r.delete_time ? new Date(r.delete_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}

function mapSummary(r: any): ResourceSummaryDto {
  return {
    resourceId: r.id,
    resourceType: r.resource_type as ResourceType,
    name: r.name,
    folderId: r.folder_id ?? null,
    version: r.version,
    createdByMembershipId: r.created_by_membership_id,
    updatedByMembershipId: r.updated_by_membership_id ?? null,
  };
}
