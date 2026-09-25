import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn() },
  ViewColumn: { Active: 1 },
}));

import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { decodeConnection, mergeSecretsFromStored } from '../../src/connection/connectionForm';

function conn(overrides: Partial<SavedConnection>): SavedConnection {
  return { id: 'c1', name: 'C', dbType: 'MYSQL' as SavedConnection['dbType'], host: 'h', port: 3306, user: 'u', database: 'd', ...overrides };
}

/**
 * 回归：编辑连接时 webview 对未改动的密钥「留空且不发送」，这不能理解为「清除密码」。
 * 保存路径由 db-host `sanitize` 保证（缺省保留 / '' 删除），此处保证测试连接的补齐语义。
 */
describe('mergeSecretsFromStored', () => {
  it('未提交的密钥回退到已保存值', () => {
    const stored = conn({ password: 'db-secret', sshPassword: 'ssh-secret', sshPassphrase: 'phrase' });
    const merged = mergeSecretsFromStored(conn({ name: 'Renamed' }), stored);
    expect(merged.password).toBe('db-secret');
    expect(merged.sshPassword).toBe('ssh-secret');
    expect(merged.sshPassphrase).toBe('phrase');
    expect(merged.name).toBe('Renamed');
  });

  it('新输入的密钥优先于已保存值', () => {
    const merged = mergeSecretsFromStored(conn({ password: 'new' }), conn({ password: 'old' }));
    expect(merged.password).toBe('new');
  });

  it('显式清除（空串）优先，不被已保存值覆盖', () => {
    const merged = mergeSecretsFromStored(conn({ password: '' }), conn({ password: 'old' }));
    expect(merged.password).toBe('');
  });

  it('无已保存连接（新建）时原样返回', () => {
    const decoded = conn({ password: 'x' });
    expect(mergeSecretsFromStored(decoded, undefined).password).toBe('x');
  });

  it('P7：Redis sentinelPassword 也在敏感字段回退之列', () => {
    const stored = conn({ dbType: 'REDIS' as SavedConnection['dbType'], sentinelPassword: 'sentinel-secret' });
    const merged = mergeSecretsFromStored(conn({ name: 'Renamed' }), stored);
    expect(merged.sentinelPassword).toBe('sentinel-secret');
  });
});

/**
 * 回归：敏感字段的「显式清除」（''）必须在 decode 后存活，否则 db-host sanitize 的
 * 删除分支收不到，清除静默无效。此前 sshPassword/sshPassphrase/sentinelPassword 用了
 * `|| undefined` 把 '' 折叠掉（password 未折叠，故只有 password 的清除生效）。
 */
describe('decodeConnection 敏感字段三态', () => {
  const payload = (over: Record<string, unknown>) => ({ dbType: 'REDIS', host: 'h', port: 6379, ...over });

  it("显式清除（''）原样保留", () => {
    const c = decodeConnection(payload({ password: '', sshPassword: '', sshPassphrase: '', sentinelPassword: '' }));
    expect(c.password).toBe('');
    expect(c.sshPassword).toBe('');
    expect(c.sshPassphrase).toBe('');
    expect(c.sentinelPassword).toBe('');
  });

  it('缺省（未提交）为 undefined，不产生误删', () => {
    const c = decodeConnection(payload({}));
    expect(c.password).toBeUndefined();
    expect(c.sshPassword).toBeUndefined();
    expect(c.sshPassphrase).toBeUndefined();
    expect(c.sentinelPassword).toBeUndefined();
  });

  it('有值为原样', () => {
    const c = decodeConnection(payload({ password: 'p', sshPassword: 's', sshPassphrase: 'k', sentinelPassword: 'sp' }));
    expect([c.password, c.sshPassword, c.sshPassphrase, c.sentinelPassword]).toEqual(['p', 's', 'k', 'sp']);
  });
});
