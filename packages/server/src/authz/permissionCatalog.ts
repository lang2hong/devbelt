import type { OrganizationRole } from '../domain/enums.js';

/**
 * 静态权限目录。
 *
 * 当前没有角色权限表、委派或角色管理 UI：`admin` 拥有全部组织
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

/** admin 的全部权限。 */
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

/** member 的固定只读权限。 */
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
  // 未知角色（数据异常/未来新增角色）一律 deny，不抛错：抛错会把 500 暴露成一个探测面。
  const permissions = ROLE_PERMISSIONS[role] as readonly PermissionCode[] | undefined;
  return permissions ? permissions.includes(permission) : false;
}
