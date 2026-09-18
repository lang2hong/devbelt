import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => ({
  version: '1.90.0',
  env: { machineId: 'test-machine', appName: 'VSCode', language: 'zh-cn', remoteName: undefined },
  window: { showErrorMessage: () => {}, showInformationMessage: () => {} },
  ConfigurationTarget: { Global: 1 },
}));

import { AuthService } from '../../src/sync/authService';
import { syncFetch } from '@devkit/db-host/sync/syncClient';

// db-host 在测试包之外，vi.mock('undici') 无法拦截其内部 import；
// 用 syncFetch seam 把请求导向 globalThis.fetch，使安装的桩生效。
const realSyncFetch = syncFetch.impl;

// 让所有用例（含直接替换 globalThis.fetch 的飞行中请求用例）都经 seam 走桩。
beforeEach(() => {
  syncFetch.impl = ((url: any, init?: any) => globalThis.fetch(url, init)) as any;
});

const ACCESS_KEY = 'devbelt.auth.accessToken';
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
    installFetch(() => ({ status: 200, body: meResponse(proSub) }));

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await auth.refreshEntitlement();

    const expected = { planCode: 'pro', allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'], maxDevices: 5, maxSavedConnections: 100, allowConnectionImport: true, maxConcurrentConnections: 0, allowConnectionExport: true, allowErDiagram: true, allowDataSync: true };
    expect(auth.getCachedEntitlement()).toEqual(expected);
    expect(memento.values.get(ENTITLEMENT_KEY)).toEqual(expected);
  });

  it('无订阅时降级到 Free（mysql/sqlite）', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
    installFetch(() => ({ status: 200, body: meResponse(null) }));

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await auth.refreshEntitlement();

    expect(auth.getCachedEntitlement()).toEqual({ planCode: 'free', allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 0, maxSavedConnections: 10, allowConnectionImport: false, maxConcurrentConnections: 0, allowConnectionExport: true, allowErDiagram: true, allowDataSync: true });
  });

  it('getMe 失败静默降级：不抛、不写缓存', async () => {
    const secrets = makeSecrets();
    const memento = makeMemento();
    await secrets.store(ACCESS_KEY, 'A1');
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
    installFetch(() => ({ status: 200, body: meResponse(proSub) }));

    const auth = new AuthService(secrets as any, 'http://localhost:3000', memento as any);
    await auth.init();
    await vi.waitFor(() => {
      expect(auth.getCachedEntitlement()).toEqual({ planCode: 'pro', allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'], maxDevices: 5, maxSavedConnections: 100, allowConnectionImport: true, maxConcurrentConnections: 0, allowConnectionExport: true, allowErDiagram: true, allowDataSync: true });
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
});