import { describe, expect, it, vi } from 'vitest';
import { toSavedConnection, isSupportedTemplateType, classifyOrgError } from '../../src/commands/org';
import { OrgApiError } from '../../src/org/client';
import type { ConnectionTemplateContent } from '../../src/org/types';
import type { OrgLocalCredential } from '../../src/org/credentialVault';
import { ORG_CONNECTION_ID_PREFIX } from '../../src/sync/entitlementGate';

// org.ts 顶层 `import * as vscode` 会连同 orgTreeDataProvider 一起被加载，
// 而后者 `extends vscode.TreeItem` 在类定义期就需要 TreeItem。这里的 mock 与
// menuWhen.test.ts 保持一致：仅覆盖导入期被求值的符号（纯 helper 不触及其余）。
vi.mock('vscode', () => ({
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {},
  ThemeColor: class {},
  TreeItem: class {
    label: string;
    collapsibleState: number;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
}));

const template = (over: Partial<ConnectionTemplateContent> = {}): ConnectionTemplateContent => ({
  databaseType: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  database: 'db',
  ...over,
});

describe('toSavedConnection (组织连接模板 → 临时 SavedConnection)', () => {
  const cred: OrgLocalCredential = { username: 'u', password: 'p' };

  it('构造临时组织连接 id 与基础字段', () => {
    const conn = toSavedConnection('o1', 'r1', 'n', template(), cred);
    expect(conn.id).toBe(`${ORG_CONNECTION_ID_PREFIX}o1:r1`);
    expect(conn.dbType).toBe('MYSQL');
    expect(conn.user).toBe('u');
    expect(conn.password).toBe('p');
    expect(conn.database).toBe('db');
  });

  it('模板用户名缺失时回退本地凭据用户名', () => {
    const conn = toSavedConnection('o1', 'r1', 'n', template({ username: 'tpl' }), { password: 'p' });
    expect(conn.user).toBe('tpl');
  });

  it('databaseType 决定引擎；未知值 fail-closed', () => {
    expect(toSavedConnection('o', 'r', 'n', template({ databaseType: 'postgresql' }), { password: 'p' }).dbType).toBe('PG');
    expect(toSavedConnection('o', 'r', 'n', template({ databaseType: 'sqlite' }), { password: 'p' }).dbType).toBe('SQLITE');
    expect(() => toSavedConnection('o', 'r', 'n', template({ databaseType: 'oracle' }), { password: 'p' }))
      .toThrow(/Unsupported databaseType/);
  });

  it('SSL disable / 无 ssl 字段 → 不启用 SSL、无 rejectUnauthorized', () => {
    for (const c of [template({ ssl: { mode: 'disable' } }), template()]) {
      const conn = toSavedConnection('o1', 'r1', 'n', c, cred);
      expect(conn.useSSL).toBe(false);
      expect(conn.rejectUnauthorized).toBeUndefined();
    }
  });

  it('SSL require → useSSL=true、rejectUnauthorized=false', () => {
    const conn = toSavedConnection('o1', 'r1', 'n', template({ ssl: { mode: 'require' } }), cred);
    expect(conn.useSSL).toBe(true);
    expect(conn.rejectUnauthorized).toBe(false);
  });

  it('SSL verify-ca/verify-full → useSSL=true、rejectUnauthorized=true 且透传 caPath', () => {
    for (const mode of ['verify-ca', 'verify-full'] as const) {
      const conn = toSavedConnection('o1', 'r1', 'n', template({ ssl: { mode } }), { ...cred, caPath: '/ca.pem' });
      expect(conn.useSSL).toBe(true);
      expect(conn.rejectUnauthorized).toBe(true);
      expect(conn.caPath).toBe('/ca.pem');
    }
  });
});

describe('isSupportedTemplateType', () => {
  it('mysql 支持，其余类型不支持', () => {
    expect(isSupportedTemplateType(template())).toBe(true);
    expect(isSupportedTemplateType(template({ databaseType: 'postgresql' }))).toBe(false);
  });
});

describe('classifyOrgError', () => {
  it('401→auth、403→forbidden、409 版本冲突→conflict、其余→generic', () => {
    expect(classifyOrgError(new OrgApiError(401, 'UNAUTHORIZED', 'x'))).toBe('auth');
    expect(classifyOrgError(new OrgApiError(403, 'FORBIDDEN', 'x'))).toBe('forbidden');
    expect(classifyOrgError(new OrgApiError(409, 'RESOURCE_VERSION_CONFLICT', 'x', 9))).toBe('conflict');
    expect(classifyOrgError(new OrgApiError(404, 'NOT_FOUND', 'x'))).toBe('generic');
    expect(classifyOrgError(new Error('boom'))).toBe('generic');
    expect(classifyOrgError(undefined)).toBe('generic');
  });
});
