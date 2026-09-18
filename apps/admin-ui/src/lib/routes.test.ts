import { describe, expect, it } from 'vitest';
import { matchRoute } from './router';
import { ADMIN_DEFAULT_PATH, ADMIN_ROUTES } from '../routes';

describe('admin 路由表', () => {
  it('根路径 `/` 落到默认页（修复 /admin/ 显示「页面不存在」）', () => {
    expect(matchRoute('/', ADMIN_ROUTES)).toEqual({ name: 'admin-users', params: {} });
  });

  it('默认落地路径本身可匹配', () => {
    expect(matchRoute(ADMIN_DEFAULT_PATH, ADMIN_ROUTES)?.name).toBe('admin-users');
  });

  it('每个后台页面都有对应路由', () => {
    const names = ADMIN_ROUTES.map((r) => r.name);
    for (const expected of [
      'admin-users',
      'admin-organizations',
      'admin-orders',
      'admin-invoices',
      'admin-audit',
      'admin-plans',
      'admin-version',
    ]) {
      expect(names).toContain(expected);
    }
  });
});