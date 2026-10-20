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

  it('只有 access、没有 refresh 不算登录态', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    expect(auth.isLoggedIn()).toBe(false);
  });
});