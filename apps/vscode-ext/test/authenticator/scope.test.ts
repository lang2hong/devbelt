import { describe, expect, it, afterEach } from 'vitest';
import { AuthenticatorStore } from '../../src/authenticator/store';
import { ENTRIES_KEY, parseSecretKey, secretKey } from '../../src/authenticator/types';
import { setAccountScope } from '../../src/sync/accountScope';

/** In-memory Memento stub (Map-backed, same shape as vscode.Memento). */
function memento() {
  const store = new Map<string, unknown>();
  return {
    map: store,
    keys: () => Array.from(store.keys()),
    get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
    update: async (k: string, v: unknown) => { store.set(k, v); },
  };
}

function secrets() {
  const map = new Map<string, string>();
  return {
    map,
    async get(k: string) { return map.get(k); },
    async store(k: string, v: string) { map.set(k, v); },
    async delete(k: string) { map.delete(k); },
    onDidChange() { return { dispose() { /* no-op */ } }; },
  };
}

function auth() {
  return { isLoggedIn: () => false, getCachedEntitlement: () => undefined };
}

async function makeStore() {
  const mem = memento();
  const sec = secrets();
  const store = new AuthenticatorStore(mem, sec as never, auth() as never);
  await store.init();
  return { mem, sec, store };
}

afterEach(() => setAccountScope(undefined));

describe('Authenticator 按账号隔离', () => {
  it('secret 键：未登录用旧格式，登录后带作用域', () => {
    expect(secretKey('abc', 'local')).toBe('devbelt.authenticator.abc.secret');
    expect(secretKey('abc', 'u42')).toBe('devbelt.authenticator.u.u42.abc.secret');
  });

  it('parseSecretKey 只匹配当前作用域，不会把其他账号的键当成自己的', () => {
    expect(parseSecretKey('devbelt.authenticator.abc.secret', 'local')).toBe('abc');
    expect(parseSecretKey('devbelt.authenticator.u.u42.abc.secret', 'u42')).toBe('abc');
    // 未登录时不能把带作用域的键误认为 entry id
    expect(parseSecretKey('devbelt.authenticator.u.u42.abc.secret', 'local')).toBeNull();
    // 其他账号的键不算
    expect(parseSecretKey('devbelt.authenticator.u.u42.abc.secret', 'u43')).toBeNull();
    // 非 authenticator 命名空间
    expect(parseSecretKey('devbelt.connection.u.u42.c1.password', 'u42')).toBeNull();
  });

  it('两个账号写同一个 entry id 互不覆盖', async () => {
    const { mem, sec, store } = await makeStore();

    setAccountScope('uA');
    await store.addEntry({ issuer: 'A', account: 'a@x', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 });
    const entryA = store.listEntries()[0];
    expect(entryA).toBeTruthy();

    setAccountScope('uB');
    await store.reload();
    expect(store.listEntries()).toHaveLength(0);

    await store.addEntry({ issuer: 'B', account: 'b@x', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA1', digits: 6, period: 30 });
    const entryB = store.listEntries()[0];
    expect(entryB.issuer).toBe('B');

    // 回到 A：仍是 A 的条目
    setAccountScope('uA');
    await store.reload();
    expect(store.listEntries().map((e) => e.issuer)).toEqual(['A']);

    // Memento 里一个键、两把 SecretStorage 钥匙都还在
    expect(mem.map.has(`${ENTRIES_KEY}::u.uA`)).toBe(true);
    expect(mem.map.has(`${ENTRIES_KEY}::u.uB`)).toBe(true);
    expect(sec.map.has(secretKey(entryA.id, 'uA'))).toBe(true);
    expect(sec.map.has(secretKey(entryB.id, 'uB'))).toBe(true);
    store.dispose();
  });

  it('登录后首次读取会复制旧（未隔离）数据，但不删除旧键', async () => {
    const mem = memento();
    const sec = secrets();
    // 模拟升级前的数据：未隔离键
    await mem.update(ENTRIES_KEY, [
      { id: 'e-legacy', issuer: 'Legacy', account: 'me@x', groupId: undefined, updateTime: 1 },
    ]);
    await sec.store(secretKey('e-legacy', 'local'), 'JBSWY3DPEHPK3PXP');

    setAccountScope('u42');
    const store = new AuthenticatorStore(mem, sec as never, auth() as never);
    await store.init();

    expect(store.listEntries().map((e) => e.id)).toEqual(['e-legacy']);
    // 复制到当前作用域
    expect(mem.map.has(`${ENTRIES_KEY}::u.u42`)).toBe(true);
    expect(sec.map.has(secretKey('e-legacy', 'u42'))).toBe(true);
    // 旧键保留，迁移可回退
    expect(mem.map.has(ENTRIES_KEY)).toBe(true);
    expect(sec.map.has(secretKey('e-legacy', 'local'))).toBe(true);
    store.dispose();
  });
});