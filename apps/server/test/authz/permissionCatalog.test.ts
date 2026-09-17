import { describe, expect, it } from 'vitest';
import { roleHasPermission, type PermissionCode } from '../../src/authz/permissionCatalog.js';
import type { OrganizationRole } from '../../src/domain/enums.js';

describe('roleHasPermission', () => {
  it('admin has write permissions, member only read', () => {
    expect(roleHasPermission('admin', 'resource.write')).toBe(true);
    expect(roleHasPermission('admin', 'resource.delete')).toBe(true);
    expect(roleHasPermission('member', 'resource.write')).toBe(false);
    expect(roleHasPermission('member', 'resource.read')).toBe(true);
  });

  it('denies an unknown role instead of throwing', () => {
    expect(roleHasPermission('ghost' as OrganizationRole, 'resource.read' as PermissionCode)).toBe(false);
  });
});