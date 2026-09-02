import { describe, expect, it, vi } from 'vitest';
import { DEK_BYTES, DekStore, deriveSyncSignKeyPair, generateDek } from '../../../src/sync/crypto/keyStore';

function makeSecretStorage(seed?: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
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
    const kp = deriveSyncSignKeyPair(new Uint8Array(DEK_BYTES).fill(3));
    expect(kp.seed.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
  });

  it('跨 userId 隔离', async () => {
    const store = new DekStore(makeSecretStorage());
    await store.store('user-a', 1n, new Uint8Array(DEK_BYTES).fill(1));
    await store.store('user-b', 1n, new Uint8Array(DEK_BYTES).fill(2));
    expect((await store.load('user-a', 1n))![0]).toBe(1);
    expect((await store.load('user-b', 1n))![0]).toBe(2);
  });

  it('跨 keyEpoch 隔离（十进制无前导零 key）', async () => {
    const store = new DekStore(makeSecretStorage());
    await store.store('user-a', 1n, new Uint8Array(DEK_BYTES).fill(1));
    await store.store('user-a', 10n, new Uint8Array(DEK_BYTES).fill(2));
    expect((await store.load('user-a', 1n))![0]).toBe(1);
    expect((await store.load('user-a', 10n))![0]).toBe(2);
  });

  it('delete 只删对应 user/epoch', async () => {
    const store = new DekStore(makeSecretStorage());
    await store.store('user-a', 1n, new Uint8Array(DEK_BYTES).fill(1));
    await store.store('user-a', 2n, new Uint8Array(DEK_BYTES).fill(2));
    await store.delete('user-a', 1n);
    expect(await store.load('user-a', 1n)).toBeUndefined();
    expect((await store.load('user-a', 2n))![0]).toBe(2);
  });

  it('SecretStorage 值缺失 → undefined', async () => {
    const store = new DekStore(makeSecretStorage());
    expect(await store.load('user-a', 1n)).toBeUndefined();
  });

  it('SecretStorage 非法 base64url → fail-closed', async () => {
    const store = new DekStore(makeSecretStorage({ 'dbclient.sync.dek.user-a.1': '!!!not-base64url!!!' }));
    await expect(store.load('user-a', 1n)).rejects.toThrowError(/corrupt DEK/);
  });

  it('SecretStorage 解码后非 32B → fail-closed', async () => {
    const store = new DekStore(makeSecretStorage({ 'dbclient.sync.dek.user-a.1': 'c2hvcnQ' }));
    await expect(store.load('user-a', 1n)).rejects.toThrowError(/corrupt DEK/);
  });

  it('store 校验 DEK 长度', async () => {
    const store = new DekStore(makeSecretStorage());
    await expect(store.store('user-a', 1n, new Uint8Array(16))).rejects.toThrowError(/32 bytes/);
  });
});
