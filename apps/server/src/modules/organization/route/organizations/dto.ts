import type { InvitationDto } from '../../../../repository/interfaces.js';
import type { OrganizationRole, ResourceType } from '../../../../domain/enums.js';

/** 组织/成员/邀请/文件夹/资源的对外 DTO 映射（自 organizations.ts 抽出，纯函数）。 */

export function toFolderDto(f: { folderId: number; name: string; parentId: number | null }) {
  return { folderId: String(f.folderId), name: f.name, parentId: f.parentId === null ? null : String(f.parentId) };
}

export function toResourceSummaryDto(r: { resourceId: number; resourceType: ResourceType; name: string; folderId: number | null; version: number; createdByMembershipId: number; updatedByMembershipId: number | null }) {
  return {
    resourceId: String(r.resourceId),
    resourceType: r.resourceType,
    name: r.name,
    folderId: r.folderId === null ? null : String(r.folderId),
    version: r.version,
    createdByMembershipId: String(r.createdByMembershipId),
    updatedByMembershipId: r.updatedByMembershipId === null ? null : String(r.updatedByMembershipId),
  };
}

export function toResourceDetailDto(r: { id: number; organizationId: number; folderId: number | null; resourceType: ResourceType; name: string; content: Record<string, unknown>; version: number; createdByMembershipId: number; updatedByMembershipId: number | null }) {
  return {
    resourceId: String(r.id),
    resourceType: r.resourceType,
    name: r.name,
    folderId: r.folderId === null ? null : String(r.folderId),
    version: r.version,
    content: r.content,
    createdByMembershipId: String(r.createdByMembershipId),
    updatedByMembershipId: r.updatedByMembershipId === null ? null : String(r.updatedByMembershipId),
  };
}

export function toInvitationListItem(d: InvitationDto) {
  return {
    invitationId: String(d.invitationId),
    email: d.email,
    role: d.role,
    expiresTime: d.expiresTime.toISOString(),
    invitedTime: d.invitedTime.toISOString(),
  };
}

export function toInvitationDto(r: { invitationId: number; email: string; role: OrganizationRole; expiresTime: Date }) {
  return {
    invitationId: String(r.invitationId),
    email: r.email,
    role: r.role,
    expiresTime: r.expiresTime.toISOString(),
  };
}

export function toOrgDto(o: { organizationId: number; name: string; status: string; closedTime: Date | null; role: OrganizationRole }) {
  return {
    organizationId: String(o.organizationId),
    name: o.name,
    status: o.status,
    closedTime: o.closedTime ? o.closedTime.toISOString() : null,
    role: o.role,
  };
}

export function orgDto(o: { id: number; name: string; status: string; closedTime: Date | null }, role: OrganizationRole) {
  return {
    organizationId: String(o.id),
    name: o.name,
    status: o.status,
    closedTime: o.closedTime ? o.closedTime.toISOString() : null,
    role,
  };
}