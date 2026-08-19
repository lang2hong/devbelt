import { describe, expect, it, vi } from 'vitest';
import { Encryption, MasterPasswordError } from '../../src/sync/encryption';
import { SyncManager } from '../../src/sync/syncManager';

/**
 * 主密码错误在自动同步里的处理。
 *
 * `tryAutoSync` 原先把所有失败一律归为 `'error'`，而调用方
 * （AutoSyncService）对 error 的处置是**退避重试直到成功**。
 * 于是一个记错的主密码会让自动同步永久重试失败：
 *  - 每一轮都做完整的 600k 轮 PBKDF2（每 section 约 0.5 秒），白烧 CPU；
 *  - 用户看到的只是"同步提醒"反复弹出，没有任何线索指向主密码；
 *  - 而正确的处置是"密码不对，请重新输入"——那对应 `'no-master'`，
 *    它会提示用户而不是重试。
 *
 * 密码错与网络错必须区分开：网络错重试是对的，密码错重试永远不会成功。
 */

function makeHashStore() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => values.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { values.set(k, v); },
  };
}

const emptyStore = {
  getSyncData: vi.fn(async () => ({ groups: [], connections: [] })),
  getConnectionMeta: vi.fn(() => []),
  replaceAllMerge: vi.fn(async () => {}),
  replaceAll: vi.fn(async () => {}),
  getQueriesForSync: vi.fn(() => ({ queries: [], folders: [] })),
  replaceQueriesForSync: vi.fn(async () => {}),
  replaceQueriesForSyncAll: vi.fn(async () => {}),
};

const emptyHistory = {
  getSyncData: vi.fn(() => []),
  replaceAllMerge: vi.fn(async () => {}),
};

/** 远端有一节用 `right-password` 加密的数据 */
function authWithRemote(encryptedWith: string) {
  return {
    client: {
      async fetchSections() {
        return {
          sections: [{
            section: 'groups',
            encryptedData: Encryption.encrypt([{ id: 'g1', name: 'G', createTime: 1, updateTime: 1, deleted: false }], encryptedWith),
            version: 1,
            updateTime: '',
          }],
        };
      },
      async pushSection() { return { version: 2 }; },
    },
  };
}

/** fetchSections 直接抛错，模拟网络/服务端故障 */
function authThatFails() {
  return {
    client: {
      async fetchSections(): Promise<never> { throw new Error('ECONNRESET'); },
      async pushSection() { return { version: 2 }; },
    },
  };
}

function masterStore(value: string | undefined) {
  const state = { value };
  return {
    async get() { return state.value; },
    async store(v: string) { state.value = v; },
    async clear() { state.value = undefined; },
    state,
  };
}

describe('Encryption 的错误分类', () => {
  it('主密码不对时抛 MasterPasswordError', async () => {
    const blob = Encryption.encrypt({ a: 1 }, 'right');
    await expect(Encryption.decryptAsync(blob, 'wrong')).rejects.toBeInstanceOf(MasterPasswordError);
  });

  it('同步版本的 decrypt 同样分类', () => {
    const blob = Encryption.encrypt({ a: 1 }, 'right');
    expect(() => Encryption.decrypt(blob, 'wrong')).toThrow(MasterPasswordError);
  });

  /**
   * 信封结构错误不是"密码不对"。把两者混为一谈会让用户被反复要求重输
   * 一个其实正确的密码 —— 真正的问题在数据本身（截断、损坏、版本不兼容）。
   */
  it('信封损坏不算主密码错误', async () => {
    await expect(Encryption.decryptAsync('not-a-valid-envelope', 'any'))
      .rejects.not.toBeInstanceOf(MasterPasswordError);
  });

  it('正确密码正常解密', async () => {
    const blob = Encryption.encrypt({ a: 1 }, 'right');
    await expect(Encryption.decryptAsync(blob, 'right')).resolves.toEqual({ a: 1 });
  });
});

describe('SyncManager.tryAutoSync 的失败分类', () => {
  it('主密码不对 → no-master，并清掉记住的错误密码', async () => {
    const store = masterStore('wrong-password');
    const sync = new SyncManager(
      authWithRemote('right-password') as any,
      emptyStore as any, emptyHistory as any, makeHashStore() as any, store as any,
    );

    expect(await sync.tryAutoSync()).toBe('no-master');
    // 关键：不清掉的话，自动同步会拿这个错密码无限退避重试，
    // 每轮都做一次 600k 轮 PBKDF2，而且永远不会成功
    expect(store.state.value).toBeUndefined();
  });

  it('网络故障 → error，保留已记住的密码（重试是对的）', async () => {
    const store = masterStore('right-password');
    const sync = new SyncManager(
      authThatFails() as any,
      emptyStore as any, emptyHistory as any, makeHashStore() as any, store as any,
    );

    expect(await sync.tryAutoSync()).toBe('error');
    expect(store.state.value).toBe('right-password');
  });

  it('没有记住密码 → no-master，不做任何网络请求', async () => {
    const auth = authWithRemote('right-password');
    const spy = vi.spyOn(auth.client, 'fetchSections');
    const sync = new SyncManager(
      auth as any, emptyStore as any, emptyHistory as any, makeHashStore() as any,
      masterStore(undefined) as any,
    );

    expect(await sync.tryAutoSync()).toBe('no-master');
    expect(spy).not.toHaveBeenCalled();
  });

  it('密码正确 → ok，密码保留', async () => {
    const store = masterStore('right-password');
    const sync = new SyncManager(
      authWithRemote('right-password') as any,
      emptyStore as any, emptyHistory as any, makeHashStore() as any, store as any,
    );

    expect(await sync.tryAutoSync()).toBe('ok');
    expect(store.state.value).toBe('right-password');
  });
});
