import type { OrganizationRole } from '../domain/enums.js';

/**
 * Phase 1 静态权限目录（实施规格 §3.2）。
 *
 * Phase 1 没有角色权限表 / 委派 / 角色管理 UI：`admin` 拥有 Phase 1 全部组织
 * 权限，`member` 仅拥有固定只读子集。这是服务端唯一的授权权威，业务处理器不得
 * 散落 admin/member 判断。
 */
export const PERMISSION_CODES = [
  'organization.read',
  'organization.update',
  'organization.close',
  'member.read',
  'member.invite',
  'member.remove',
  'member.role.assign',
  'folder.read',
  'folder.manage',
  'resource.read',
  'resource.write',
  'resource.delete',
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

/** Phase 1 的 admin 全量权限（§3.2 表 Phase=1 的 admin 列）。 */
export const ADMIN_PERMISSIONS: readonly PermissionCode[] = [
  'organization.read',
  'organization.update',
  'organization.close',
  'member.read',
  'member.invite',
  'member.remove',
  'member.role.assign',
  'folder.read',
  'folder.manage',
  'resource.read',
  'resource.write',
  'resource.delete',
];

/** Phase 1 的 member 固定只读权限（§3.2 表述：仅 4 项）。 */
export const MEMBER_PERMISSIONS: readonly PermissionCode[] = [
  'organization.read',
  'member.read',
  'folder.read',
  'resource.read',
];

const ROLE_PERMISSIONS: Record<OrganizationRole, readonly PermissionCode[]> = {
  admin: ADMIN_PERMISSIONS,
  member: MEMBER_PERMISSIONS,
};

export function roleHasPermission(role: OrganizationRole, permission: PermissionCode): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}