import { describe, it, expect, vi } from 'vitest';
import { CredentialVault } from '../../src/org/credentialVault';

function fakeSecrets() {
  const store = new Map<string, string>();
  return {
    store,
    secrets: {
      get: async (key: string) => store.get(key),
      store: async (key: string, value: string) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
    } as any,
  };
}

function fakeIndex() {
  const map = new Map<string, any>();
  return {
    map,
    get: (key: string, def?: any) => (map.has(key) ? map.get(key) : def),
    update: vi.fn(async (key: string, value: any) => { map.set(key, value); }),
  } as any;
}

describe('CredentialVault', () => {
  it('roundtrips credentials', async () => {
    const { secrets } = fakeSecrets();
    const vault = new CredentialVault(secrets, fakeIndex());
    await vault.set('org1', 'res1', { password: 'p', username: 'u' });
    await expect(vault.get('org1', 'res1')).resolves.toEqual({ password: 'p', username: 'u' });
  });

  it('keys by organizationId + resourceId (no cross-contamination)', async () => {
    const { secrets } = fakeSecrets();
    const vault = new CredentialVault(secrets, fakeIndex());
    await vault.set('org1', 'res1', { password: 'p1' });
    await vault.set('org1', 'res2', { password: 'p2' });
    await vault.set('org2', 'res1', { password: 'p3' });

    expect((await vault.get('org1', 'res1'))?.password).toBe('p1');
    expect((await vault.get('org1', 'res2'))?.password).toBe('p2');
    expect((await vault.get('org2', 'res1'))?.password).toBe('p3');
  });

  it('uses a dedicated SecretStorage namespace (never the personal connection store)', async () => {
    const { secrets, store } = fakeSecrets();
    const vault = new CredentialVault(secrets, fakeIndex());
    await vault.set('org1', 'res1', { password: 'p' });

    for (const key of store.keys()) {
      expect(key.startsWith('dbclient.org.credential.')).toBe(true);
      expect(key).not.toContain('dbclient.connections');
    }
    expect(CredentialVault.key('org1', 'res1')).toBe('dbclient.org.credential.org1.res1');
  });

  it('returns undefined for missing credentials and deletes them', async () => {
    const { secrets } = fakeSecrets();
    const vault = new CredentialVault(secrets, fakeIndex());
    expect(await vault.get('org1', 'nope')).toBeUndefined();

    await vault.set('org1', 'res1', { password: 'p' });
    await vault.delete('org1', 'res1');
    expect(await vault.get('org1', 'res1')).toBeUndefined();
  });

  it('survives malformed stored JSON', async () => {
    const { secrets, store } = fakeSecrets();
    store.set(CredentialVault.key('org1', 'res1'), '{bad json');
    const vault = new CredentialVault(secrets, fakeIndex());
    expect(await vault.get('org1', 'res1')).toBeUndefined();
  });

  it('set 登记 key、delete 移除 key（globalState 清单，不存凭据内容）', async () => {
    const { secrets } = fakeSecrets();
    const index = fakeIndex();
    const vault = new CredentialVault(secrets, index);
    await vault.set('org1', 'res1', { password: 'p1' });
    await vault.set('org2', 'res2', { password: 'p2' });

    const keys = index.get('dbclient.org.credential.index');
    expect(keys).toContain('dbclient.org.credential.org1.res1');
    expect(keys).toContain('dbclient.org.credential.org2.res2');

    await vault.delete('org1', 'res1');
    const afterDelete = index.get('dbclient.org.credential.index');
    expect(afterDelete).not.toContain('dbclient.org.credential.org1.res1');
    expect(afterDelete).toContain('dbclient.org.credential.org2.res2');
  });

  it('clearAll 删除全部凭据并清空 index', async () => {
    const { secrets, store } = fakeSecrets();
    const index = fakeIndex();
    const vault = new CredentialVault(secrets, index);
    await vault.set('org1', 'res1', { password: 'p1' });
    await vault.set('org2', 'res2', { password: 'p2' });

    await vault.clearAll();

    expect(store.size).toBe(0);
    expect(index.get('dbclient.org.credential.index')).toEqual([]);
  });

  it('clearAll 删除失败时保留失败 key', async () => {
    const store = new Map<string, string>();
    const secrets = {
      get: async (key: string) => store.get(key),
      store: async (key: string, value: string) => { store.set(key, value); },
      delete: async (key: string) => {
        if (key.includes('org2')) throw new Error('delete failed');
        store.delete(key);
      },
    } as any;
    const index = fakeIndex();
    const vault = new CredentialVault(secrets, index);
    await vault.set('org1', 'res1', { password: 'p1' });
    await vault.set('org2', 'res2', { password: 'p2' });

    await vault.clearAll();

    // org1 删除成功；org2 失败，其 key 保留在 index 中供后续重试。
    expect(store.has('dbclient.org.credential.org1.res1')).toBe(false);
    expect(store.has('dbclient.org.credential.org2.res2')).toBe(true);
    expect(index.get('dbclient.org.credential.index')).toEqual(['dbclient.org.credential.org2.res2']);
  });
});