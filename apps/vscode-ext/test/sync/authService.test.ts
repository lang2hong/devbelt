import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => ({
  version: '1.90.0',
  env: { machineId: 'test-machine', appName: 'VSCode', language: 'zh-cn', remoteName: undefined },
  window: { showErrorMessage: () => {}, showInformationMessage: () => {} },
  ConfigurationTarget: { Global: 1 },
}));

import { AuthService } from '../../src/sync/authService';
import { syncFetch } from '@devbelt/db-host/sync/syncClient';

// db-host 在测试包之外，vi.mock('undici') 无法拦截其内部 import；
// 用 syncFetch seam 把请求导向 globalThis.fetch，使安装的桩生效。
const realSyncFetch = syncFetch.impl;

// 让所有用例（含直接替换 globalThis.fetch 的飞行中请求用例）都经 seam 走桩。
beforeEach(() => {
  syncFetch.impl = ((url: any, init?: any) => globalThis.fetch(url, init)) as any;
});

const ACCESS_KEY = 'devbelt.auth.accessToken';
const REFRESH_KEY = 'devbelt.auth.refreshToken';
const USER_ID_KEY = 'devbelt.auth.userId';
const ENTITLEMENT_KEY = 'devbelt.sync.cachedEntitlement';

function makeSecrets() {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string): Promise<string | undefined> { return values.get(key); },
    async store(key: string, value: string): Promise<void> { values.set(key, value); },
    async delete(key: string): Promise<void> { values.delete(key); },
    onDidChange() { return { dispose: () => {} }; },
  };
}

/** 共享 SecretStorage：store/delete 时广播变更（模拟另一 VS Code 窗口的写入）。 */
function makeSharedSecrets() {
  const values = new Map<string, string>();
  const listeners = new Set<(e: { key: string }) => void>();
  return {
    values,
    async get(key: string): Promise<string | undefined> { return values.get(key); },
    async store(key: string, value: string): Promise<void> {
      const changed = values.get(key) !== value;
      values.set(key, value);
      if (changed) for (const l of listeners) l({ key });
    },
    async delete(key: string): Promise<void> {
      if (values.delete(key)) for (const l of listeners) l({ key });
    },
    onDidChange(listener: (e: { key: string }) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

function makeMemento() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(k: string): T | undefined => values.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { values.set(k, v); },
  };
}

const proSub = {
  planCode: 'pro',
  status: 'active',
  entitlement: { allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'], maxDevices: 5, maxSavedConnections: 100, allowConnectionImport: true },
  periodStartTime: null,
  periodEndTime: null,
};

function meResponse(subscription: typeof proSub | null) {
  return {
    user: { userId: '1', email: 'a@b.c', displayName: null, emailVerified: true, status: 'active', lastLoginTime: null },
    subscription,
  };
}

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];

/** 安装 fetch 桩；handler 按 URL 决定响应。 */
function installFetch(handler: (url: string) => { status: number; body: unknown }) {
  fetchCalls = [];
  syncFetch.impl = ((url: any, init?: any) => globalThis.fetch(url, init)) as any;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    fetchCalls.push(u);
    const { status, body } = handler(u);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as any;
}

afterEach(() => { globalThis.fetch = realFetch; syncFetch.impl = realSyncFetch; });

describe('AuthService.refreshEntitlement', () => {
  it('拉取 /api/db/me 并把 Pro 权益写进内存与 globalState', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    installFetch(() => ({ status: 200, body: meResponse(proSub) }));

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await auth.refreshEntitlement();

    const expected = { planCode: 'pro', allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'], maxDevices: 5, maxSavedConnections: 100, allowConnectionImport: true, maxConcurrentConnections: 0, allowConnectionExport: true, allowErDiagram: true, allowDataSync: true, maxAuthenticatorEntries: 10, maxAiTokensMonthly: 0 };
    expect(auth.getCachedEntitlement()).toEqual(expected);
    expect(memento.values.get(ENTITLEMENT_KEY)).toEqual(expected);
  });

  it('服务端提供的 maxAuthenticatorEntries 被透传（非 fail-closed 默认）', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    const subWithQuota = {
      ...proSub,
      entitlement: { ...proSub.entitlement, maxAuthenticatorEntries: 500 },
    };
    installFetch(() => ({ status: 200, body: meResponse(subWithQuota as typeof proSub) }));

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await auth.refreshEntitlement();

    expect(auth.getCachedEntitlement()?.maxAuthenticatorEntries).toBe(500);
  });

  it('服务端提供的 maxAiTokensMonthly 被透传；缺省 fail-closed 0（0 不表示不限）', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    const subWithAi = {
      ...proSub,
      entitlement: { ...proSub.entitlement, maxAiTokensMonthly: 2_000_000 },
    };
    installFetch(() => ({ status: 200, body: meResponse(subWithAi as typeof proSub) }));

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await auth.refreshEntitlement();

    expect(auth.getCachedEntitlement()?.maxAiTokensMonthly).toBe(2_000_000);
  });

  it('无订阅时降级到 Free（mysql/sqlite/redis）', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    installFetch(() => ({ status: 200, body: meResponse(null) }));

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await auth.refreshEntitlement();

    expect(auth.getCachedEntitlement()).toEqual({ planCode: 'free', allowedDatabaseTypes: ['mysql', 'sqlite', 'redis'], maxDevices: 0, maxSavedConnections: 10, allowConnectionImport: false, maxConcurrentConnections: 0, allowConnectionExport: true, allowErDiagram: true, allowDataSync: true, maxAuthenticatorEntries: 10, maxAiTokensMonthly: 0 });
  });

  it('getMe 失败静默降级：不抛、不写缓存', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    installFetch(() => ({ status: 500, body: { message: 'boom' } }));

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await expect(auth.refreshEntitlement()).resolves.toBeUndefined();
    expect(auth.getCachedEntitlement()).toBeUndefined();
  });

  it('未登录时 refreshEntitlement 不写缓存', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    installFetch(() => ({ status: 200, body: meResponse(proSub) }));

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.refreshEntitlement();

    expect(auth.getCachedEntitlement()).toBeUndefined();
  });

  it('init 仅在已登录时拉取权益（未登录不发 /api/db/me）', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    installFetch(() => ({ status: 200, body: meResponse(proSub) }));

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    // 未登录：init 不应触发 refreshEntitlement，因此不应有 /api/db/me 请求
    expect(fetchCalls.filter((u) => u.endsWith('/api/db/me'))).toEqual([]);
  });

  it('已登录 init() 触发一次 /api/db/me 并把权益写进缓存', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    installFetch(() => ({ status: 200, body: meResponse(proSub) }));

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await vi.waitFor(() => {
      expect(auth.getCachedEntitlement()).toEqual({ planCode: 'pro', allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'], maxDevices: 5, maxSavedConnections: 100, allowConnectionImport: true, maxConcurrentConnections: 0, allowConnectionExport: true, allowErDiagram: true, allowDataSync: true, maxAuthenticatorEntries: 10, maxAiTokensMonthly: 0 });
    });
    // init 后台刷新只应触发一次 /api/db/me（无需调用方再显式刷新）
    expect(fetchCalls.filter((u) => u.endsWith('/api/db/me'))).toHaveLength(1);
  });

  it('飞行中的 /api/db/me 在身份变更后丢弃（换号/登出守卫）', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    let pendingMe: ((v: unknown) => void) | undefined;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/api/db/me')) {
        return new Promise<Response>((resolve) => {
          pendingMe = (v) => resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } }));
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    const inflight = auth.getMe();
    await auth.logout(); // 身份变更：generation 递增
    pendingMe!(meResponse(proSub)); // 账户 A 的响应此刻才返回

    await expect(inflight).rejects.toThrow(/session changed/);
    expect(auth.getCachedEntitlement()).toBeUndefined();
    expect(memento.values.get(ENTITLEMENT_KEY)).toBeUndefined();
  });

  it('跨窗口 token 变更（onDidChange）使飞行中 /api/db/me 失效且清除身份缓存', async () => {
    const secrets = makeSharedSecrets();
    const memento = makeMemento();
    let pendingMe: ((v: unknown) => void) | undefined;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/api/db/me')) {
        return new Promise<Response>((resolve) => {
          pendingMe = (v) => resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } }));
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    const inflight = auth.getMe(); // 账户 A 的请求在飞行中
    await secrets.store(ACCESS_KEY, 'B-token'); // 另一窗口登录为账户 B（触发 onDidChange）
    pendingMe!(meResponse(proSub)); // A 的响应此时才返回

    await expect(inflight).rejects.toThrow(/session changed/);
    expect(auth.getCachedEntitlement()).toBeUndefined();
    expect(memento.values.get(ENTITLEMENT_KEY)).toBeUndefined();
  });

  it('refreshAccessToken：成功回传新 access；401 清会话；网络错误保留会话', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    // init 会异步拉一次 /api/db/me；先给一个稳定桩，避免真实网络
    globalThis.fetch = (async () => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as any;
    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    expect(auth.isLoggedIn()).toBe(true);

    // 成功：回传新 access，并落盘轮换后的 refresh
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith('/api/auth/refresh')) {
        return new Response(JSON.stringify({ accessToken: 'A2', refreshToken: 'R2' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;
    await expect(auth.refreshAccessToken()).resolves.toBe('A2');
    expect(secrets.values.get(REFRESH_KEY)).toBe('R2');

    // 401：会话不可恢复 → 清 token，isLoggedIn 立即变 false
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as any;
    await expect(auth.refreshAccessToken()).resolves.toBeUndefined();
    expect(auth.isLoggedIn()).toBe(false);
    expect(secrets.values.has(ACCESS_KEY)).toBe(false);
    expect(secrets.values.has(REFRESH_KEY)).toBe(false);
  });

  it('refreshAccessToken：网络错误不清会话（不误登出）', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    globalThis.fetch = (async () => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as any;
    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();

    globalThis.fetch = (async () => { throw new Error('network down'); }) as any;
    await expect(auth.refreshAccessToken()).resolves.toBeUndefined();
    expect(auth.isLoggedIn()).toBe(true);
    expect(secrets.values.get(REFRESH_KEY)).toBe('R1');
  });

  it('401 时若存储已被另一窗口轮换，不删除新会话', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();

    // 本窗口拿 R1 去刷新，但在响应到达前另一窗口已轮换出 R2
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith('/api/auth/refresh')) {
        await secrets.store(REFRESH_KEY, 'R2');
        return new Response('{}', { status: 401 });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;
    await expect(auth.refreshAccessToken()).resolves.toBeUndefined();

    expect(secrets.values.get(REFRESH_KEY)).toBe('R2');
    expect(auth.isLoggedIn()).toBe(true);
  });

  it('轮换结果先落盘 refresh、再落盘 access（半写态可自愈）', async () => {
    const values = new Map<string, string>([[ACCESS_KEY, 'A1'], [REFRESH_KEY, 'R1']]);
    const storeOrder: string[] = [];
    const secrets = {
      values,
      async get(key: string) { return values.get(key); },
      async store(key: string, value: string) { storeOrder.push(key); values.set(key, value); },
      async delete(key: string) { values.delete(key); },
      onDidChange() { return { dispose: () => {} }; },
    };
    installFetch(() => ({ status: 200, body: { accessToken: 'A2', refreshToken: 'R2' } }));
    const auth = new AuthService(secrets as any, 'http://localhost:3000', makeMemento() as any);
    await auth.init();
    storeOrder.length = 0;

    await expect(auth.refreshAccessToken()).resolves.toBe('A2');
    // 半写态自愈只依赖 refresh 先于 access 落盘；权益哨兵（init 的异步刷新并发写入）
    // 可能穿插其间，不影响轮换语义。
    expect(storeOrder.indexOf(REFRESH_KEY)).toBeGreaterThanOrEqual(0);
    expect(storeOrder.indexOf(ACCESS_KEY)).toBeGreaterThan(storeOrder.indexOf(REFRESH_KEY));
    expect(storeOrder).toContain('devbelt.sync.cachedEntitlement.gen');
  });

  it('refresh 落盘失败时删除已被消费的旧 token，避免后续复用检测', async () => {
    const values = new Map<string, string>([[ACCESS_KEY, 'A1'], [REFRESH_KEY, 'R1']]);
    const secrets = {
      values,
      async get(key: string) { return values.get(key); },
      async store(key: string, value: string) {
        if (key === REFRESH_KEY && value === 'R2') throw new Error('keychain locked');
        values.set(key, value);
      },
      async delete(key: string) { values.delete(key); },
      onDidChange() { return { dispose: () => {} }; },
    };
    installFetch(() => ({ status: 200, body: { accessToken: 'A2', refreshToken: 'R2' } }));
    const auth = new AuthService(secrets as any, 'http://localhost:3000', makeMemento() as any);
    await auth.init();

    await expect(auth.refreshAccessToken()).resolves.toBeUndefined();
    // 旧 R1 已被服务端消费；不能留在存储里让下一次刷新命中 reuse 探测。
    expect(values.has(REFRESH_KEY)).toBe(false);
    // refresh-first：refresh 写失败时没有覆盖 access。
    expect(values.get(ACCESS_KEY)).toBe('A1');
  });

  it('无 refresh token 的 401 回调不删除另一窗口刚登录的新会话', async () => {
    const values = new Map<string, string>([[ACCESS_KEY, 'A2'], [REFRESH_KEY, 'R2']]);
    let refreshReads = 0;
    const secrets = {
      values,
      async get(key: string) {
        if (key === REFRESH_KEY) {
          refreshReads += 1;
          return refreshReads === 1 ? undefined : values.get(key);
        }
        return values.get(key);
      },
      async store(key: string, value: string) { values.set(key, value); },
      async delete(key: string) { values.delete(key); },
      onDidChange() { return { dispose: () => {} }; },
    };
    const auth = new AuthService(secrets as any, 'http://localhost:3000', makeMemento() as any);

    await expect(auth.refreshAccessToken()).resolves.toBeUndefined();
    // 回调（failedRefreshToken=undefined）读到 R2：这是另一窗口刚写入的新会话，必须保留。
    expect(values.get(REFRESH_KEY)).toBe('R2');
    expect(values.get(ACCESS_KEY)).toBe('A2');
    expect(auth.isLoggedIn()).toBe(true);
  });

  it('login 持久化 userId（供重启后离线解锁）', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    installFetch(() => ({
      status: 200,
      body: { accessToken: 'A1', refreshToken: 'R1', user: { userId: '42' } },
    }));
    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);

    await auth.login('a@b.c', 'password-1234');

    expect(secrets.values.get(USER_ID_KEY)).toBe('42');
  });

  describe('跨窗口身份变更（onExternalIdentityChange）', () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));

    async function loggedIn(userId = '1') {
      const secrets = makeSharedSecrets();
      const memento = makeMemento();
      await secrets.store(ACCESS_KEY, 'A1');
      await secrets.store(REFRESH_KEY, 'R1');
      await secrets.store(USER_ID_KEY, userId);
      installFetch(() => ({ status: 200, body: meResponse(null) }));
      const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
      await auth.init();
      const changes: Array<{ from?: string; to?: string }> = [];
      auth.onExternalIdentityChange((c) => changes.push(c));
      return { secrets, auth, changes };
    }

    it('另一窗口把 userId 换成别的账号 → 触发，带 from/to', async () => {
      const { secrets, changes } = await loggedIn('1');
      await secrets.store(USER_ID_KEY, '2'); // 另一窗口登录为账号 2
      await flush();
      expect(changes).toEqual([{ from: '1', to: '2' }]);
    });

    it('另一窗口登出（userId 被删）→ 触发，to 为空', async () => {
      const { secrets, changes } = await loggedIn('1');
      await secrets.delete(USER_ID_KEY);
      await flush();
      expect(changes).toEqual([{ from: '1', to: undefined }]);
    });

    it('同一 userId 重复写入（令牌轮换等）不触发', async () => {
      const { secrets, changes } = await loggedIn('1');
      await secrets.store(USER_ID_KEY, '1');
      await flush();
      expect(changes).toEqual([]);
    });

    it('本窗口自己登录：onDidChange 回声不触发', async () => {
      const secrets = makeSharedSecrets();
      installFetch(() => ({ status: 200, body: { accessToken: 'A1', refreshToken: 'R1', user: { userId: '42' } } }));
      const auth = new AuthService(secrets as any, 'http://localhost:3000', makeMemento() as any);
      await auth.init();
      const changes: unknown[] = [];
      auth.onExternalIdentityChange((c) => changes.push(c));

      await auth.login('a@b.c', 'password-1234');
      await flush();

      expect(secrets.values.get(USER_ID_KEY)).toBe('42');
      expect(changes).toEqual([]);
    });

    it('本窗口自己登出：回声不触发（它走 AuthEvent）', async () => {
      const { secrets, auth, changes } = await loggedIn('1');
      void secrets;
      await auth.logout();
      await flush();
      expect(changes).toEqual([]);
    });

    it('本窗口 getMe 写入 userId：回声不触发', async () => {
      const secrets = makeSharedSecrets();
      await secrets.store(ACCESS_KEY, 'A1');
      await secrets.store(REFRESH_KEY, 'R1');
      installFetch(() => ({ status: 200, body: meResponse(null) }));
      const auth = new AuthService(secrets as any, 'http://localhost:3000', makeMemento() as any);
      await auth.init();
      const changes: unknown[] = [];
      auth.onExternalIdentityChange((c) => changes.push(c));

      await auth.getMe();
      await flush();

      expect(secrets.values.get(USER_ID_KEY)).toBe('1');
      expect(changes).toEqual([]);
    });

    it('取消订阅后不再收到；监听方抛错不影响其他监听方', async () => {
      const { secrets, auth } = await loggedIn('1');
      const got: unknown[] = [];
      auth.onExternalIdentityChange(() => { throw new Error('listener boom'); });
      const sub = auth.onExternalIdentityChange((c) => got.push(c));
      await secrets.store(USER_ID_KEY, '2');
      await flush();
      expect(got).toHaveLength(1);
      sub.dispose();
      await secrets.store(USER_ID_KEY, '3');
      await flush();
      expect(got).toHaveLength(1);
    });
  });

  it('getUserId 优先使用持久化 userId（不联网）', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(USER_ID_KEY, '42');
    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    const fetchSpy = vi.fn(async () => { throw new Error('should not fetch'); });
    globalThis.fetch = fetchSpy as any;

    await expect(auth.getUserId()).resolves.toBe('42');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logout 清除持久化 userId', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    await secrets.store(USER_ID_KEY, '42');
    installFetch(() => ({ status: 200, body: meResponse(proSub) }));
    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();

    await auth.logout();

    expect(secrets.values.has(USER_ID_KEY)).toBe(false);
  });

  it('套餐字段变化时写跨窗口哨兵，字段未变化时不写', async () => {
    const secrets = makeSharedSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    installFetch((url) => {
      if (url.includes('/me')) return { status: 200, body: meResponse(proSub) };
      return { status: 200, body: {} };
    });
    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await expect(auth.refreshEntitlement()).resolves.toBeUndefined();
    // 首次写入（无旧值）→ 哨兵写入
    expect(secrets.values.get('devbelt.sync.cachedEntitlement.gen')).toBe('pro|mysql,postgresql,sqlite');

    // 再次刷新同一套餐 → 哨兵值不变，不再写
    const before = secrets.values.get('devbelt.sync.cachedEntitlement.gen');
    await auth.refreshEntitlement();
    expect(secrets.values.get('devbelt.sync.cachedEntitlement.gen')).toBe(before);
  });

  it('哨兵变化会连 memento 缓存一起清（离线时不回退到旧套餐）', async () => {
    const secrets = makeSharedSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    installFetch(() => ({ status: 200, body: meResponse(proSub) }));
    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await auth.refreshEntitlement();
    expect(memento.values.get('devbelt.sync.cachedEntitlement')).toBeTruthy();

    // 刷新失败（离线）：哨兵必须让本窗口 fail-closed，而不是回退到旧套餐缓存。
    installFetch(() => ({ status: 500, body: { message: 'offline' } }));
    await secrets.store('devbelt.sync.cachedEntitlement.gen', 'pro|mysql,postgresql,sqlite,elasticsearch');
    await new Promise((r) => setTimeout(r, 30));
    expect(memento.values.get('devbelt.sync.cachedEntitlement')).toBeUndefined();
  });

  it('另一窗口哨兵变化 → 本窗口丢弃内存缓存并重拉', async () => {
    const secrets = makeSharedSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    const calls: string[] = [];
    installFetch((url) => {
      calls.push(url);
      if (url.includes('/me')) return { status: 200, body: meResponse(proSub) };
      return { status: 200, body: {} };
    });
    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await expect(auth.refreshEntitlement()).resolves.toBeUndefined();
    const meCallsBefore = calls.filter((u) => u.includes('/me')).length;
    expect(auth.getCachedEntitlement()?.planCode).toBe('pro');

    // 模拟另一窗口升级写哨兵
    await secrets.store('devbelt.sync.cachedEntitlement.gen', 'pro|mysql,postgresql,sqlite,elasticsearch');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((u) => u.includes('/me')).length).toBeGreaterThan(meCallsBefore);
  });

  it('只有 access、没有 refresh 不算登录态', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    expect(auth.isLoggedIn()).toBe(false);
  });
});