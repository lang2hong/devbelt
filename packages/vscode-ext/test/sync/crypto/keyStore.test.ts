import { describe, expect, it, vi } from 'vitest';
import { DEK_BYTES, DekStore, deriveSyncSignKeyPair, generateDek } from '../../../src/sync/crypto/keyStore';

function makeSecretStorage() {
  const m = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => m.get(k)),
    store: vi.fn(async (k: string, v: string) => { m.set(k, v); }),
    delete: vi.fn(async (k: string) => { m.delete(k); }),
    onDidChange: () => ({ dispose() {} }),
  } as any;
}

describe('keyStore', () => {
  it('generateDek 32B', () => {
    expect(generateDek().length).toBe(DEK_BYTES);
  });

  it('deriveSyncSignKeyPair 派生 32B seed + 32B 公钥', () => {
    const dek = new Uint8Array(DEK_BYTES).fill(3);
    const kp = deriveSyncSignKeyPair(dek);
    expect(kp.seed.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
  });

  it('DekStore roundtrip（SecretStorage）', async () => {
    const ss = makeSecretStorage();
    const store = new DekStore(ss);
    const dek = new Uint8Array(DEK_BYTES).fill(42);
    await store.store(dek);
    expect(await store.get()).toEqual(dek);
    await store.clear();
    expect(await store.get()).toBeUndefined();
  });

  it('DekStore 写/读校验 DEK 长度', async () => {
    const store = new DekStore(makeSecretStorage());
    await expect(store.store(new Uint8Array(16))).rejects.toThrowError(/32 bytes/);
  });
});