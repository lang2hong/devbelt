/**
 * 组织 Workspace 类型定义（纯类型 + 窄化守卫，无 vscode 依赖）。
 *
 * 契约来源：docs/同步协议.md 与服务端 route/organizations.ts。
 * 所有 ID 在 DTO 中均为十进制字符串（§2）。
 */

export type OrganizationRole = 'admin' | 'member';
export type ResourceType = 'connection_template' | 'query';

/** GET /api/organizations 返回的组织摘要（含调用者角色）。 */
export interface OrganizationSummaryDto {
  organizationId: string;
  name: string;
  status: 'active' | 'closed';
  closedTime: string | null;
  role: OrganizationRole;
}

/** GET /api/organizations/:orgId/folders 返回的目录项。 */
export interface FolderDto {
  folderId: string;
  name: string;
  parentId: string | null;
}

/** 资源列表项（不含 content）。 */
export interface ResourceSummaryDto {
  resourceId: string;
  resourceType: ResourceType;
  name: string;
  folderId: string | null;
  version: number;
  createdByMembershipId: string;
  updatedByMembershipId: string | null;
}

/** connection_template 内容（§6.3 严格闭合 schema）。 */
export interface ConnectionTemplateContent {
  databaseType: 'mysql';
  host: string;
  port: number;
  database: string;
  username?: string;
  ssl?: {
    mode: 'disable' | 'require' | 'verify-ca' | 'verify-full';
    rejectUnauthorized?: boolean;
  };
}

/** query 内容（§6.3 严格闭合 schema）。 */
export interface QueryContent {
  sql: string;
  dialect?: 'mysql' | 'postgresql' | 'sqlite';
}

export type ResourceContent = ConnectionTemplateContent | QueryContent;

/** 资源详情（含 content，仅 GET :resourceId 返回）。 */
export interface ResourceDetailDto extends ResourceSummaryDto {
  content: ResourceContent;
}

/** 判型守卫：服务端资源类型为其子集（§6.3 仅 MySQL 模板）。 */
export function isConnectionTemplate(c: ResourceContent): c is ConnectionTemplateContent {
  return (c as ConnectionTemplateContent).databaseType !== undefined
    && (c as ConnectionTemplateContent).host !== undefined;
}
