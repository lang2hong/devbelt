import { describe, expect, it } from 'vitest';
import { DekStore, generateDek } from '../src/sync/crypto/keyStore.js';
import { allowedEngines, type CachedEntitlement } from '../src/sync/entitlementGate.js';
import type { SecureStorageLike } from '../src/hostTypes.js';

function memorySecrets(): SecureStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(k) { return map.get(k); },
    async store(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
  };
}

describe('db-host 端口注入', () => {
  it('SecureStorageLike 端口可驱动 DekStore 存取/删除', async () => {
    const secrets = memorySecrets();
    const store = new DekStore(secrets);
    expect(await store.load('u1', 1n)).toBeUndefined();

    const dek = generateDek();
    await store.store('u1', 1n, dek);
    expect(await store.load('u1', 1n)).toEqual(dek);

    await store.delete('u1', 1n);
    expect(await store.load('u1', 1n)).toBeUndefined();
  });

  it('权益门禁 fail-closed（无权益仅放行 free 引擎）', () => {
    expect(allowedEngines(undefined)).toEqual(['mysql', 'sqlite']);
    const pro: CachedEntitlement = {
      planCode: 'pro',
      allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'],
      maxDevices: 5,
      maxSavedConnections: 100,
      allowConnectionImport: true,
    };
    expect(allowedEngines(pro)).toEqual(['mysql', 'postgresql', 'sqlite']);
  });
});