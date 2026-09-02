import { describe, it, expect } from 'vitest';
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

describe('CredentialVault', () => {
  it('roundtrips credentials', async () => {
    const { secrets } = fakeSecrets();
    const vault = new CredentialVault(secrets);
    await vault.set('org1', 'res1', { password: 'p', username: 'u' });
    await expect(vault.get('org1', 'res1')).resolves.toEqual({ password: 'p', username: 'u' });
  });

  it('keys by organizationId + resourceId (no cross-contamination)', async () => {
    const { secrets } = fakeSecrets();
    const vault = new CredentialVault(secrets);
    await vault.set('org1', 'res1', { password: 'p1' });
    await vault.set('org1', 'res2', { password: 'p2' });
    await vault.set('org2', 'res1', { password: 'p3' });

    expect((await vault.get('org1', 'res1'))?.password).toBe('p1');
    expect((await vault.get('org1', 'res2'))?.password).toBe('p2');
    expect((await vault.get('org2', 'res1'))?.password).toBe('p3');
  });

  it('uses a dedicated SecretStorage namespace (never the personal connection store)', async () => {
    const { secrets, store } = fakeSecrets();
    const vault = new CredentialVault(secrets);
    await vault.set('org1', 'res1', { password: 'p' });

    for (const key of store.keys()) {
      expect(key.startsWith('dbclient.org.credential.')).toBe(true);
      expect(key).not.toContain('dbclient.connections');
    }
    expect(CredentialVault.key('org1', 'res1')).toBe('dbclient.org.credential.org1.res1');
  });

  it('returns undefined for missing credentials and deletes them', async () => {
    const { secrets } = fakeSecrets();
    const vault = new CredentialVault(secrets);
    expect(await vault.get('org1', 'nope')).toBeUndefined();

    await vault.set('org1', 'res1', { password: 'p' });
    await vault.delete('org1', 'res1');
    expect(await vault.get('org1', 'res1')).toBeUndefined();
  });

  it('survives malformed stored JSON', async () => {
    const { secrets, store } = fakeSecrets();
    store.set(CredentialVault.key('org1', 'res1'), '{bad json');
    const vault = new CredentialVault(secrets);
    expect(await vault.get('org1', 'res1')).toBeUndefined();
  });
});
