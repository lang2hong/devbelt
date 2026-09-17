import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => ({
  version: '1.90.0',
  env: { machineId: 'test-machine', appName: 'VSCode', language: 'zh-cn', remoteName: undefined },
  window: { showErrorMessage: () => {}, showInformationMessage: () => {} },
  ConfigurationTarget: { Global: 1 },
}));

// SyncClient 静态 import undici 的 fetch，绕过 VS Code 对 globalThis.fetch 的代理。
// 测试里让它委托回 globalThis.fetch，这样 installServerStub 替换 global fetch 即可生效。
vi.mock('undici', () => ({
  Agent: class {},
  fetch: (url: any, init?: any) => globalThis.fetch(url, init),
}));

import { AuthService } from '../../src/sync/authService';

/**
 * 多窗口 refresh token 轮换竞态。
 *
 * 每个 VS Code 窗口是**独立的扩展宿主进程**，各有一份 AuthService 实例，但共享
 * 同一个 SecretStorage。原实现只在 `init()` 时把 refresh token 读进内存字段，
 * 之后 `SyncClient` 的 `getRefreshToken` 闭包一直返回那个内存值。
 *
 * 于是：
 *  1. A 窗口刷新成功 → 服务端撤销 R1、签发 R2 → A 写入 SecretStorage
 *  2. B 窗口内存里仍是 R1（没人通知它）
 *  3. B 下次刷新拿 R1 打 /api/auth/refresh
 *  4. 服务端发现 R1 已被撤销 → 判定 token 泄露 → revokeAllForUser
 *  5. **用户所有设备被登出**
 *
 * `SyncClient.tryRefresh` 的单飞只在进程内有效，挡不住这个跨进程场景。
 *
 * 这也是为什么把 ACCESS_TOKEN_EXPIRES_IN 从 7d 收到 15m 必须以本修复为前置：
 * 刷新频率会从约每周 1 次涨到每天约 96 次，竞态触发概率放大约 672 倍。
 */

/** 共享的 SecretStorage：模拟多个扩展宿主访问同一份底层存储 */
function createSharedSecrets() {
  const values = new Map<string, string>();
  const listeners = new Set<(e: { key: string }) => void>();
  return {
    values,
    async get(key: string): Promise<string | undefined> { return values.get(key); },
    async store(key: string, value: string): Promise<void> {
      values.set(key, value);
      // 真实 SecretStorage 会跨窗口广播变更
      for (const l of listeners) l({ key });
    },
    async delete(key: string): Promise<void> {
      values.delete(key);
      for (const l of listeners) l({ key });
    },
    onDidChange(listener: (e: { key: string }) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

const REFRESH_KEY = 'devbelt.auth.refreshToken';
const ACCESS_KEY = 'devbelt.auth.accessToken';

let fetchCalls: Array<{ url: string; refreshToken?: string }> = [];
const realFetch = globalThis.fetch;

/** 服务端桩：R1 只能用一次，第二次用 R1 即视为重用（返回 401） */
function installServerStub(): { consumed: Set<string>; reuseDetected: () => boolean } {
  const consumed = new Set<string>();
  let reuse = false;
  let seq = 1;

  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ url: u, refreshToken: body?.refreshToken });

    if (u.endsWith('/api/auth/refresh')) {
      const rt = body?.refreshToken;
      if (consumed.has(rt)) {
        // 服务端语义：已撤销的 token 再次出现 = 泄露 → revokeAllForUser
        reuse = true;
        return new Response(JSON.stringify({ message: 'token reuse' }), { status: 401 });
      }
      consumed.add(rt);
      seq += 1;
      return new Response(
        JSON.stringify({ accessToken: `A${seq}`, refreshToken: `R${seq}` }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  return { consumed, reuseDetected: () => reuse };
}

beforeEach(() => { fetchCalls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('多窗口共享 SecretStorage 时的 refresh 轮换', () => {
  it('B 窗口刷新时使用 A 窗口轮换后的最新 token，不触发重用检测', async () => {
    const secrets = createSharedSecrets();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    const server = installServerStub();

    // 两个独立宿主实例，共享同一份 SecretStorage
    const windowA = new AuthService(secrets as any, 'http://localhost:3000');
    const windowB = new AuthService(secrets as any, 'http://localhost:3000');
    await windowA.init();
    await windowB.init();

    // A 先刷新：R1 -> R2
    await windowA.refreshTokens();
    expect(await secrets.get(REFRESH_KEY)).toBe('R2');

    // B 再刷新：必须用 R2，而不是自己内存里的 R1
    await windowB.refreshTokens();

    expect(server.reuseDetected()).toBe(false);
    const sentTokens = fetchCalls
      .filter((c) => c.url.endsWith('/api/auth/refresh'))
      .map((c) => c.refreshToken);
    expect(sentTokens).toEqual(['R1', 'R2']);
  });

  it('A 窗口轮换后，B 窗口的内存态被同步（onDidChange）', async () => {
    const secrets = createSharedSecrets();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    installServerStub();

    const windowA = new AuthService(secrets as any, 'http://localhost:3000');
    const windowB = new AuthService(secrets as any, 'http://localhost:3000');
    await windowA.init();
    await windowB.init();

    expect(windowB.getAccessToken()).toBe('A1');
    await windowA.refreshTokens();

    // B 没有做任何操作，但它的内存态应当已随 SecretStorage 变更而更新
    expect(windowB.getAccessToken()).toBe('A2');
  });

  it('登出时也用最新 token（否则撤销的是一个已失效的旧 token）', async () => {
    const secrets = createSharedSecrets();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    installServerStub();

    const windowA = new AuthService(secrets as any, 'http://localhost:3000');
    const windowB = new AuthService(secrets as any, 'http://localhost:3000');
    await windowA.init();
    await windowB.init();

    await windowA.refreshTokens();
    await windowB.logout();

    const logoutCall = fetchCalls.find((c) => c.url.endsWith('/api/auth/logout'));
    expect(logoutCall?.refreshToken).toBe('R2');
  });

  it('另一个窗口登出后，本窗口不再持有 token', async () => {
    const secrets = createSharedSecrets();
    await secrets.store(ACCESS_KEY, 'A1');
    await secrets.store(REFRESH_KEY, 'R1');
    installServerStub();

    const windowA = new AuthService(secrets as any, 'http://localhost:3000');
    const windowB = new AuthService(secrets as any, 'http://localhost:3000');
    await windowA.init();
    await windowB.init();

    await windowA.logout();

    expect(windowB.isLoggedIn()).toBe(false);
  });

  it('dispose 后不再接收变更（不泄漏监听器）', async () => {
    const secrets = createSharedSecrets();
    await secrets.store(REFRESH_KEY, 'R1');
    const windowA = new AuthService(secrets as any, 'http://localhost:3000');
    await windowA.init();

    windowA.dispose();
    await secrets.store(ACCESS_KEY, 'A-external');

    expect(windowA.getAccessToken()).not.toBe('A-external');
  });
});
