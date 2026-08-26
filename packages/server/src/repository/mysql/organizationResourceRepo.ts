import type {
  IOrganizationResourceRepo,
  OrganizationResourceInput,
  OrganizationResourceEditableFields,
} from '../interfaces.js';
import type { OrganizationResource, OrganizationResourcePermission } from '../../domain/entities.js';
import type { ResourceType, AccessScope, ResourcePermission } from '../../domain/enums.js';
import type { MysqlDb } from './db.js';

/**
 * 组织共享资源仓储（含 restricted 资源授权）（已接入运行时）。
 *
 * 列名与 001_initial_schema.ts 的 organization_resources /
 * organization_resource_permissions 表逐列对齐。
 *
 * - 资源软删除走 `delete_time`；权限行靠复合外键 CASCADE 跟随资源删除，
 *   但 softDelete 是软删（置 delete_time），不会触发 FK CASCADE —— 真正删除
 *   资源（硬删）时权限行才级联消失。softDelete 后权限行仍指向软删资源，
 *   listPermissions 调用方应在资源未软删时使用。
 * - 权限 UPSERT：同 (resource_id, membership_id) 覆盖 permission，靠唯一键兜底。
 */
export class MysqlOrganizationResourceRepo implements IOrganizationResourceRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findById(id: number): Promise<OrganizationResource | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM organization_resources WHERE id = ? AND delete_time IS NULL',
      [id],
    );
    return rows[0] ? mapResource(rows[0]) : undefined;
  }

  async listByOrganization(organizationId: number, type?: ResourceType): Promise<OrganizationResource[]> {
    if (type) {
      const [rows] = await this.db().query<any[]>(
        'SELECT * FROM organization_resources WHERE organization_id = ? AND resource_type = ? AND delete_time IS NULL ORDER BY id',
        [organizationId, type],
      );
      return rows.map(mapResource);
    }
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM organization_resources WHERE organization_id = ? AND delete_time IS NULL ORDER BY id',
      [organizationId],
    );
    return rows.map(mapResource);
  }

  async create(input: OrganizationResourceInput): Promise<OrganizationResource> {
    const [result] = await this.db().query<any>(
      `INSERT INTO organization_resources
         (organization_id, resource_type, name, access_scope, encrypted_data, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.organizationId,
        input.resourceType,
        input.name,
        input.accessScope,
        input.encryptedData,
        input.createdByUserId,
      ],
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('organization_resource insert failed');
    return created;
  }

  async update(id: number, fields: OrganizationResourceEditableFields): Promise<void> {
    // 动态拼 SET：只更新入参出现的字段，避免把未提供字段写成 NULL。
    const sets: string[] = [];
    const params: any[] = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      params.push(fields.name);
    }
    if (fields.accessScope !== undefined) {
      sets.push('access_scope = ?');
      params.push(fields.accessScope);
    }
    if (fields.encryptedData !== undefined) {
      sets.push('encrypted_data = ?');
      params.push(fields.encryptedData);
    }
    if (fields.updatedByUserId !== undefined) {
      sets.push('updated_by_user_id = ?');
      params.push(fields.updatedByUserId);
    }
    if (sets.length === 0) return;
    params.push(id);
    await this.db().query(`UPDATE organization_resources SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async softDelete(id: number): Promise<void> {
    await this.db().query(
      'UPDATE organization_resources SET delete_time = NOW() WHERE id = ? AND delete_time IS NULL',
      [id],
    );
  }

  async grantPermission(
    organizationId: number,
    resourceId: number,
    membershipId: number,
    permission: ResourcePermission,
  ): Promise<OrganizationResourcePermission> {
    // UPSERT：同 (resource_id, membership_id) 覆盖 permission。
    await this.db().query(
      `INSERT INTO organization_resource_permissions
         (organization_id, resource_id, membership_id, permission)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE permission = VALUES(permission)`,
      [organizationId, resourceId, membershipId, permission],
    );
    const found = await this.findPermission(resourceId, membershipId);
    if (!found) throw new Error('organization_resource_permission upsert failed');
    return found;
  }

  async revokePermission(resourceId: number, membershipId: number): Promise<void> {
    await this.db().query(
      'DELETE FROM organization_resource_permissions WHERE resource_id = ? AND membership_id = ?',
      [resourceId, membershipId],
    );
  }

  async listPermissions(resourceId: number): Promise<OrganizationResourcePermission[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM organization_resource_permissions WHERE resource_id = ? ORDER BY id',
      [resourceId],
    );
    return rows.map(mapPermission);
  }

  async listPermissionsForMembership(membershipId: number): Promise<OrganizationResourcePermission[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM organization_resource_permissions WHERE membership_id = ? ORDER BY id',
      [membershipId],
    );
    return rows.map(mapPermission);
  }

  async findPermission(resourceId: number, membershipId: number): Promise<OrganizationResourcePermission | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM organization_resource_permissions WHERE resource_id = ? AND membership_id = ?',
      [resourceId, membershipId],
    );
    return rows[0] ? mapPermission(rows[0]) : undefined;
  }
}

function mapResource(r: any): OrganizationResource {
  return {
    id: r.id,
    organizationId: r.organization_id,
    resourceType: r.resource_type as ResourceType,
    name: r.name,
    accessScope: r.access_scope as AccessScope,
    encryptedData: r.encrypted_data,
    createdByUserId: r.created_by_user_id,
    updatedByUserId: r.updated_by_user_id ?? undefined,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
    deleteTime: r.delete_time ? new Date(r.delete_time) : undefined,
  };
}

function mapPermission(r: any): OrganizationResourcePermission {
  return {
    id: r.id,
    organizationId: r.organization_id,
    resourceId: r.resource_id,
    membershipId: r.membership_id,
    permission: r.permission as ResourcePermission,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
