import { describe, it, expect, vi, afterEach } from 'vitest';
import { SyncClient } from '../../src/sync/syncClient';

/**
 * SyncClient 的 401 刷新路径。
 *
 * 这块的正确性不体现在功能上（刷新成功了就没人注意），而体现在**并发**和
 * **重试**两处踩雷时的后果：服务端的 refresh token 是一次性的，重复使用会被
 * 判定为凭据泄露并 `revokeAllForUser` —— 用户在所有设备上被登出。所以：
 *
 *  1. 并发的 401 只能触发一次 refresh（单飞）
 *  2. refresh 请求本身绝不能进入 5xx/网络重试
 *
 * 全部用 mock fetch，不起真实网络。
 */

/** 记录每次请求，便于断言调用序列 */
interface Call {
  url: string;
  method: string;
  auth?: string;
  body?: any;
}

function jsonRes(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/**
 * 造一个 client + 可编程的 fetch。
 * token 存在闭包里，模拟 AuthService 的 getter/setter 行为。
 */
function setup(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  let access: string | undefined = 'access-1';
  let refreshTok: string | undefined = 'refresh-1';

  const fetchMock = vi.fn(async (url: any, init: any) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      auth: headers.Authorization,
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length);
  });

  const client = new SyncClient(
    'http://x',
    () => access,
    () => refreshTok,
    (a, r) => { access = a; refreshTok = r; },
    undefined,
    fetchMock as any,
  );

  return {
    client,
    calls,
    fetchMock,
    get access() { return access; },
    get refreshToken() { return refreshTok; },
    setAccess: (v: string | undefined) => { access = v; },
  };
}

const isRefresh = (c: Call) => c.url.endsWith('/api/auth/refresh');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('401 自动刷新', () => {
  it('单个 401 触发一次刷新并重试原请求', async () => {
    const t = setup((c) => {
      if (isRefresh(c)) return jsonRes(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      // 第一次带旧 token → 401；带新 token → 200
      return c.auth === 'Bearer access-1' ? jsonRes(401) : jsonRes(200, { user: {} });
    });

    await t.client.getMe();

    expect(t.calls.filter(isRefresh)).toHaveLength(1);
    expect(t.access).toBe('access-2');
    // 重试用的是新 token
    const last = t.calls[t.calls.length - 1];
    expect(last.auth).toBe('Bearer access-2');
  });

  it('刷新失败时不重试原请求，401 冒泡给调用方', async () => {
    const t = setup((c) => (isRefresh(c) ? jsonRes(401) : jsonRes(401)));

    await expect(t.client.getMe()).rejects.toThrow(/401/);
    expect(t.calls.filter(isRefresh)).toHaveLength(1);
    // 业务请求只发了一次（没有拿旧 token 白重试）
    expect(t.calls.filter((c) => !isRefresh(c))).toHaveLength(1);
  });
});

describe('刷新单飞', () => {
  /**
   * 这是核心用例。
   *
   * 一次自动同步是 7 个请求，token 过期时它们会先后拿到 401。若各自去刷新，
   * 就是多个请求带着**同一个** refresh token 打服务端 —— 服务端的
   * 「查→撤销→签发」非原子，后到的那个会读到 revokedTime 已置位，
   * 判定为 token 泄露并撤销该用户全部会话。
   */
  it('并发的多个 401 只触发一次刷新', async () => {
    let refreshCount = 0;
    const t = setup(async (c) => {
      if (isRefresh(c)) {
        refreshCount++;
        // 刷新慢一点，确保其他请求的 401 在它完成前就到了
        await new Promise((r) => setTimeout(r, 20));
        return jsonRes(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      }
      return c.auth === 'Bearer access-1' ? jsonRes(401) : jsonRes(200, { user: {} });
    });

    await Promise.all([
      t.client.getMe(),
      t.client.getMe(),
      t.client.getMe(),
      t.client.fetchSections(),
      t.client.listDevices().catch(() => undefined),
    ]);

    expect(refreshCount).toBe(1);
    expect(t.calls.filter(isRefresh)).toHaveLength(1);
  });

  it('并发刷新时每个请求都用刷新后的新 token 重试', async () => {
    const t = setup(async (c) => {
      if (isRefresh(c)) {
        await new Promise((r) => setTimeout(r, 20));
        return jsonRes(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      }
      return c.auth === 'Bearer access-1' ? jsonRes(401) : jsonRes(200, { user: {} });
    });

    await Promise.all([t.client.getMe(), t.client.getMe(), t.client.getMe()]);

    const retries = t.calls.filter((c) => !isRefresh(c) && c.auth === 'Bearer access-2');
    expect(retries).toHaveLength(3);
  });

  /**
   * 单飞的 promise 必须在 finally 里清掉。
   * 少了这一步，第一次刷新之后 refreshInFlight 永远留着旧结果，
   * 后续所有刷新都会拿到那个陈旧的 true/false。
   */
  it('刷新完成后可以再次刷新（in-flight 已清理）', async () => {
    // 业务请求第 1、3 次返回 401 → 各逼出一次刷新；第 2、4 次成功
    let biz = 0;
    let round = 1;
    const t = setup((c) => {
      if (isRefresh(c)) {
        round++;
        return jsonRes(200, { accessToken: `access-${round}`, refreshToken: `refresh-${round}` });
      }
      biz++;
      return biz % 2 === 1 ? jsonRes(401) : jsonRes(200, { user: {} });
    });

    await t.client.getMe();
    await t.client.getMe();

    expect(t.calls.filter(isRefresh)).toHaveLength(2);
    expect(t.access).toBe('access-3');
  });

  it('刷新失败后仍可再次尝试（失败不会锁死刷新能力）', async () => {
    let failFirst = true;
    const t = setup((c) => {
      if (isRefresh(c)) {
        if (failFirst) { failFirst = false; return jsonRes(401); }
        return jsonRes(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      }
      return c.auth === 'Bearer access-1' ? jsonRes(401) : jsonRes(200, { user: {} });
    });

    await expect(t.client.getMe()).rejects.toThrow();
    // 第二次调用应当能重新发起刷新
    await t.client.getMe();
    expect(t.calls.filter(isRefresh)).toHaveLength(2);
  });

  /**
   * 请求 A 触发刷新并完成后，请求 B 才拿着**旧** token 的 401 回来。
   * 这时不该再刷一次 —— 直接用已经更新好的 token 重试即可。
   */
  /**
   * 慢请求的 401 在别人刷新**完成之后**才回来。
   *
   * 这时单飞已经清空（refreshInFlight 是 undefined），光靠单飞挡不住第二次刷新。
   * 挡住它的是 tokenBefore 比对：发请求时用的是 access-1，而当前已经是 access-2，
   * 说明这个 401 只是因为拿了旧 token，直接用新的重试即可。
   *
   * 少了这个比对，同步末尾的慢请求会在刷新刚完成时再刷一次 —— 而它手里的
   * refresh token 已经被上一次刷新消费掉了，正好触发服务端的重用检测。
   */
  it('刷新已由他人完成时不再重复刷新，直接用新 token 重试', async () => {
    let biz = 0;
    const t = setup(async (c) => {
      if (isRefresh(c)) {
        return jsonRes(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      }
      biz++;
      if (c.auth === 'Bearer access-1') {
        // 第 2 个业务请求的 401 故意迟到，落在刷新完成之后
        if (biz === 2) await new Promise((r) => setTimeout(r, 50));
        return jsonRes(401);
      }
      return jsonRes(200, { user: {} });
    });

    await Promise.all([t.client.getMe(), t.client.getMe()]);

    expect(t.calls.filter(isRefresh)).toHaveLength(1);
    expect(t.access).toBe('access-2');
    // 两个请求最终都用新 token 成功了
    expect(t.calls.filter((c) => c.auth === 'Bearer access-2')).toHaveLength(2);
  });
});

describe('refresh 请求不进重试通道', () => {
  /**
   * refresh token 是一次性的：服务端收到就撤销旧的。5xx 尤其危险 ——
   * 服务端很可能已经撤销了才失败，重发必然命中重用检测 → 撤销全部会话。
   *
   * 所以 refresh 只能发一次，失败就失败。
   */
  it('refresh 遇 5xx 不重发（避免重用检测撤销全部会话）', async () => {
    const t = setup((c) => (isRefresh(c) ? jsonRes(500) : jsonRes(401)));

    await expect(t.client.getMe()).rejects.toThrow();
    expect(t.calls.filter(isRefresh)).toHaveLength(1);
  });

  it('refresh 遇网络异常不重发', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: any) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/auth/refresh')) throw new Error('ECONNRESET');
      return jsonRes(401);
    });
    const client = new SyncClient('http://x', () => 'a', () => 'r', () => {}, undefined, fetchMock as any);

    await expect(client.refresh()).rejects.toThrow(/ECONNRESET/);
    expect(calls.filter((u) => u.endsWith('/api/auth/refresh'))).toHaveLength(1);
  });

  it('业务请求仍然享受 5xx 重试（重试通道没被一起砍掉）', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n < 3 ? jsonRes(500) : jsonRes(200, { user: {} });
    });
    vi.useFakeTimers();
    const client = new SyncClient('http://x', () => 'a', () => 'r', () => {}, undefined, fetchMock as any);
    const p = client.getMe();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeDefined();
    expect(n).toBe(3);
    vi.useRealTimers();
  });

  it('没有 refresh token 时直接抛错，不发请求', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: any) => { calls.push(String(url)); return jsonRes(200); });
    const client = new SyncClient('http://x', () => 'a', () => undefined, () => {}, undefined, fetchMock as any);

    await expect(client.refresh()).rejects.toThrow(/no refresh token/);
    expect(calls).toHaveLength(0);
  });
});

describe('刷新成功后回写 token', () => {
  it('onTokensRefreshed 收到新的 access + refresh', async () => {
    const seen: Array<[string, string]> = [];
    const fetchMock = vi.fn(async () =>
      jsonRes(200, { accessToken: 'A2', refreshToken: 'R2' }),
    );
    const client = new SyncClient('http://x', () => 'A1', () => 'R1', (a, r) => { seen.push([a, r]); }, undefined, fetchMock as any);

    await client.refresh();
    expect(seen).toEqual([['A2', 'R2']]);
  });
});

describe('V3 login/refresh 请求体必带 DeviceFields（§4.6）', () => {
  const device = {
    deviceName: 'test-host · linux/x64',
    deviceId: 'abcdef0123456789abcdef0123456789',
    machineId: 'fedcba9876543210fedcba9876543210',
    hostname: 'test-host',
    os: 'linux',
    arch: 'x64',
    osVersion: '6.0',
    appName: 'VSCode',
    appVersion: '1.90.0',
    language: 'en',
    timezone: 'UTC',
  };

  function makeClient(dev: unknown = device) {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      bodies.push(init?.body ? JSON.parse(init.body) : undefined);
      return jsonRes(200, { accessToken: 'A', refreshToken: 'R' });
    });
    const client = new SyncClient('http://x', () => 'access-1', () => 'refresh-1', () => {}, dev as any, fetchMock as any);
    return { client, bodies };
  }

  it('login 请求体含 4 个设备字段', async () => {
    const { client, bodies } = makeClient();
    await client.login('a@b.c', 'password-1234');

    const body = bodies[0] as Record<string, unknown>;
    expect(body.email).toBe('a@b.c');
    expect(body.password).toBe('password-1234');
    expect(body.deviceKey).toBe('abcdef0123456789abcdef0123456789');
    expect(body.devicePlatform).toBe('linux');
    expect(body.deviceName).toBe('test-host · linux/x64');
    expect(body.clientVersion).toBe('1.90.0');
  });

  it('refresh 请求体含 4 个设备字段', async () => {
    const { client, bodies } = makeClient();
    await client.refresh();

    const body = bodies[0] as Record<string, unknown>;
    expect(body.refreshToken).toBe('refresh-1');
    expect(body.deviceKey).toBe('abcdef0123456789abcdef0123456789');
    expect(body.devicePlatform).toBe('linux');
    expect(body.deviceName).toBe('test-host · linux/x64');
    expect(body.clientVersion).toBe('1.90.0');
  });

  it('deviceKey 清洗为 [A-Za-z0-9_-] 且长度收敛到 16..128', async () => {
    const { client, bodies } = makeClient({
      ...device,
      deviceId: '', // 空 → 回退 machineId
      machineId: 'bad id with spaces!', // 含非法字符，需清洗
    });
    await client.refresh();

    const key = (bodies[0] as Record<string, unknown>).deviceKey as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });
});

describe('V3 注册/验证流程（register 不回 token）', () => {
  const device = {
    deviceName: 'test-host · linux/x64',
    deviceId: 'abcdef0123456789abcdef0123456789',
    machineId: 'fedcba9876543210fedcba9876543210',
    hostname: 'test-host',
    os: 'linux',
    arch: 'x64',
    osVersion: '6.0',
    appName: 'VSCode',
    appVersion: '1.90.0',
    language: 'en',
    timezone: 'UTC',
  };

  it('register 请求体仅含 email/password，不回 token', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      bodies.push(init?.body ? JSON.parse(init.body) : undefined);
      return jsonRes(201, { ok: true });
    });
    const client = new SyncClient('http://x', () => undefined, () => undefined, undefined, device as any, fetchMock as any);

    const result = await client.register('a@b.c', 'password-1234');
    expect(result).toEqual({ ok: true });
    expect(bodies[0]).toEqual({ email: 'a@b.c', password: 'password-1234' });
  });

  it('confirmEmail / resendVerification 命中对应路径', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetchMock = vi.fn(async (url: unknown, init: any) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
      return jsonRes(200, { ok: true });
    });
    const client = new SyncClient('http://x', () => undefined, () => undefined, undefined, undefined, fetchMock as any);

    await client.confirmEmail('tok_123');
    await client.resendVerification('a@b.c');

    expect(calls[0].url).toBe('http://x/api/auth/email-verifications/tok_123/confirm');
    expect(calls[0].method).toBe('POST');
    expect(calls[1].url).toBe('http://x/api/auth/email-verifications');
    expect(calls[1].body).toEqual({ email: 'a@b.c' });
  });

  it('不再发送 V2 X-Device-* 请求头', async () => {
    let headers: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return jsonRes(200, { accessToken: 'A', refreshToken: 'R' });
    });
    const client = new SyncClient('http://x', () => 'a', () => 'r', () => {}, device as any, fetchMock as any);

    await client.login('a@b.c', 'password-1234');

    expect(Object.keys(headers).filter((k) => k.startsWith('X-Device-'))).toEqual([]);
  });
});

describe('V3 change-password / confirm 单次消费契约', () => {
  it('changePassword 发送 { currentPassword, newPassword }（不用 V2 oldPassword）', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      if (init?.body) bodies.push(JSON.parse(init.body));
      return jsonRes(200, { ok: true });
    });
    const client = new SyncClient('http://x', () => 'access-1', () => 'refresh-1', undefined, undefined, fetchMock as any);

    await client.changePassword('old-123456', 'new-123456');

    expect(bodies[0]).toEqual({ currentPassword: 'old-123456', newPassword: 'new-123456' });
    expect(JSON.stringify(bodies[0])).not.toContain('oldPassword');
  });

  it('confirmEmail 遇 5xx 不重试（单次消费）', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return jsonRes(500, { code: 'INTERNAL', message: 'boom' });
    });
    const client = new SyncClient('http://x', () => undefined, () => undefined, undefined, undefined, fetchMock as any);

    await expect(client.confirmEmail('tok_123')).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('resendVerification 遇 500 不重试（重发会作废旧 token）', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return jsonRes(500, { code: 'INTERNAL', message: 'boom' });
    });
    const client = new SyncClient('http://x', () => undefined, () => undefined, undefined, undefined, fetchMock as any);

    await expect(client.resendVerification('a@b.c')).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
