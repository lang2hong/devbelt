import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp';
import { ROUTE_BUCKET_KEYS, bucketForRoute, RATE_LIMIT_BUCKETS } from '../../src/ratelimit/rules.js';

/**
 * 限流分桶与**实际注册路由**的一致性。
 *
 * 为什么需要这个文件：rules.ts 里的 ROUTE_BUCKETS 是一张手写的字符串表，
 * 而它的键必须精确等于 Fastify 的路由模板。这两者之间没有任何编译期约束 ——
 * 拼错一个键不会报错，只会让那个桶恒不命中，静默退化到 default。
 *
 * 这正是第一版犯的错：表里写的是 `/api/sync/:section` 和
 * `/api/sync/:section/rollback`，而真实路由是 `PUT /api/sync` 和
 * `POST /api/sync/rollback` —— 那两个路径根本不存在。sync-write 桶从来没生效过。
 * 更糟的是当时的单测直接断言 `bucketForRoute('/api/sync/:section') === 'sync-write'`，
 * 测试和实现共享同一个错误前提，于是自证通过。
 *
 * 所以这里不手写任何路径字面量，而是用 onRoute 钩子从 app 实例里**抓**出真实
 * 路由表来比对。表写错就红，路由改名也红。
 */

interface RegisteredRoute {
  method: string;
  url: string;
}

let app: TestApp;
let registered: RegisteredRoute[] = [];

beforeAll(async () => {
  const collected: RegisteredRoute[] = [];
  app = await buildTestApp({
    onRoute: (r) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) collected.push({ method: m, url: r.url });
    },
  });
  registered = collected;
});

afterAll(async () => {
  await app?.app.close();
});

/** HEAD 是 Fastify 给 GET 自动补的，与 GET 同桶，不单独校验 */
function realRoutes(): RegisteredRoute[] {
  return registered.filter((r) => r.method !== 'HEAD');
}

describe('限流表与真实路由一致', () => {
  it('测试装配确实抓到了路由（否则后面的断言全是空跑）', () => {
    expect(realRoutes().length).toBeGreaterThan(20);
  });

  /**
   * 核心断言：表里的每个键都必须对应一个真实注册的路由。
   *
   * 这一条能独立抓住 `/api/sync/:section` 那个 bug。
   */
  it('ROUTE_BUCKETS 的每个键都对应真实注册的路由', () => {
    const actual = new Set(realRoutes().map((r) => `${r.method} ${r.url}`));
    const orphans = ROUTE_BUCKET_KEYS.filter((k) => !actual.has(k));
    expect(orphans, `这些键在实际路由表里不存在，对应的桶恒不命中：${orphans.join(', ')}`).toEqual([]);
  });

  it('每个真实路由都能归到一个已知桶或被显式豁免', () => {
    for (const r of realRoutes()) {
      const bucket = bucketForRoute(r.method, r.url);
      if (bucket === undefined) continue; // 豁免
      expect(RATE_LIMIT_BUCKETS, `${r.method} ${r.url} 归到了未知桶 ${bucket}`).toContain(bucket);
    }
  });

  /**
   * 同步的读和写共用 `/api/sync` 这一个模板，只有 method 能区分。
   *
   * 这是 method 参数存在的唯一理由 —— 少了它，要么把 GET 也算成写入
   * （读被写的配额挤掉），要么把 PUT 算成读（写入完全不受 sync-write 约束）。
   */
  it('同一路径的读写分到不同桶', () => {
    const paths = new Set(realRoutes().map((r) => r.url));
    expect(paths.has('/api/sync'), '前提变了：/api/sync 不再是读写共用的模板').toBe(true);

    expect(bucketForRoute('PUT', '/api/sync')).toBe('sync-write');
    expect(bucketForRoute('GET', '/api/sync')).toBe('default');
  });

  it('同步写入路由归 sync-write', () => {
    expect(bucketForRoute('PUT', '/api/sync')).toBe('sync-write');
    expect(bucketForRoute('POST', '/api/sync/rollback')).toBe('sync-write');
  });

  it('认证路由归 auth 桶', () => {
    expect(bucketForRoute('POST', '/api/auth/login')).toBe('auth-strict');
    expect(bucketForRoute('POST', '/api/auth/register')).toBe('auth-strict');
    expect(bucketForRoute('POST', '/api/auth/change-password')).toBe('auth-strict');
    expect(bucketForRoute('POST', '/api/auth/refresh')).toBe('auth-refresh');
  });

  /**
   * 客户端一次自动同步的实际请求数，是 sync-write 阈值的推导依据。
   * 路由改名会让这个推导失效，所以在这里钉住。
   */
  it('自动同步用到的两个路由都存在（阈值推导的前提）', () => {
    const actual = new Set(realRoutes().map((r) => `${r.method} ${r.url}`));
    expect(actual.has('GET /api/sync'), 'pull').toBe(true);
    expect(actual.has('PUT /api/sync'), 'push（5 个 section 各一次）').toBe(true);
  });
});
