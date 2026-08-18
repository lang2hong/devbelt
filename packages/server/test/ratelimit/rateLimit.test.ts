import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * 限流的端到端行为（真实插件 + 真实路由 + 真实 errorHandler）。
 *
 * 重点验四件事：
 *  1. 429 的响应体和头是完整的（errorHandler 不能把 message 吃掉）
 *  2. 桶之间互不影响（key 里带桶名）
 *  3. IP 之间互不影响（分桶键是 IP）
 *  4. 三种豁免都生效（路由豁免 / 桶停用 / IP 白名单）
 */

/** 用小阈值快速打穿，省得循环几百次 */
const TIGHT = {
  'auth-strict': { maxRequests: 3, windowSeconds: 60 },
  'sync-write': { maxRequests: 4, windowSeconds: 60 },
  admin: { maxRequests: 5, windowSeconds: 60 },
  default: { maxRequests: 6, windowSeconds: 60 },
};

const from = (ip: string) => ({ 'x-forwarded-for': ip });

describe('429 响应', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp({ rateLimit: true, rateLimitOverrides: TIGHT });
  });
  afterEach(async () => { await t.close(); });

  it('超出阈值后返回 429', async () => {
    const body = { email: 'a@example.com', password: 'password123' };
    for (let i = 0; i < 3; i++) {
      const res = await t.app.inject({
        method: 'POST', url: '/api/auth/login', payload: body, headers: from('1.1.1.1'),
      });
      expect(res.statusCode).not.toBe(429);
    }
    const blocked = await t.app.inject({
      method: 'POST', url: '/api/auth/login', payload: body, headers: from('1.1.1.1'),
    });
    expect(blocked.statusCode).toBe(429);
  });

  /**
   * 这条是 errorHandler 集成的回归防线。
   *
   * @fastify/rate-limit 是 `throw errorResponseBuilder(...)`，抛出的 Error 带
   * statusCode 429，会落到全局 errorHandler。那里如果只有通用 4xx 分支，
   * message 会被改写成 'Bad request' —— 客户端就不知道该等多久了。
   */
  it('响应体保留「多久后可重试」和 RATE_LIMITED 码', async () => {
    const body = { email: 'a@example.com', password: 'password123' };
    let blocked: any;
    for (let i = 0; i < 6; i++) {
      blocked = await t.app.inject({
        method: 'POST', url: '/api/auth/login', payload: body, headers: from('2.2.2.2'),
      });
      if (blocked.statusCode === 429) break;
    }
    expect(blocked.statusCode).toBe(429);
    const json = blocked.json();
    expect(json.code).toBe('RATE_LIMITED');
    expect(json.message).toMatch(/retry in/i);
    // 绝不能被通用 4xx 分支改写
    expect(json.message).not.toBe('Bad request');
  });

  it('带 retry-after 与 x-ratelimit-* 头', async () => {
    const body = { email: 'a@example.com', password: 'password123' };
    let blocked: any;
    for (let i = 0; i < 6; i++) {
      blocked = await t.app.inject({
        method: 'POST', url: '/api/auth/login', payload: body, headers: from('3.3.3.3'),
      });
      if (blocked.statusCode === 429) break;
    }
    // 头值是字符串（HTTP 头本来就没有数字类型）
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(String(blocked.headers['x-ratelimit-limit'])).toBe('3');
    expect(String(blocked.headers['x-ratelimit-remaining'])).toBe('0');
  });
});

describe('分桶隔离', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp({ rateLimit: true, rateLimitOverrides: TIGHT });
  });
  afterEach(async () => { await t.close(); });

  /**
   * 桶名拼进了 key，所以打满 auth-strict 不应该影响其他端点。
   * 如果 key 只有 IP，登录失败几次就会连 /api/me 都进不去。
   */
  it('打满 auth-strict 不影响 default 桶', async () => {
    const ip = '4.4.4.4';
    for (let i = 0; i < 6; i++) {
      await t.app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: 'a@example.com', password: 'password123' },
        headers: from(ip),
      });
    }
    const { token } = await t.makeUser();
    const res = await t.app.inject({
      method: 'GET', url: '/api/me', headers: { ...t.auth(token), ...from(ip) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('打满 admin 桶不影响同 IP 的 auth 端点', async () => {
    const ip = '5.5.5.5';
    const { token } = await t.makeUser({ role: 'admin' });
    for (let i = 0; i < 8; i++) {
      await t.app.inject({
        method: 'GET', url: '/admin/plans', headers: { ...t.auth(token), ...from(ip) },
      });
    }
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: 'password123' },
      headers: from(ip),
    });
    expect(res.statusCode).not.toBe(429);
  });

  it('login 与 register 共桶（都是 auth-strict）', async () => {
    const ip = '6.6.6.6';
    for (let i = 0; i < 3; i++) {
      await t.app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: 'a@example.com', password: 'password123' },
        headers: from(ip),
      });
    }
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'new@example.com', password: 'password123' },
      headers: from(ip),
    });
    expect(res.statusCode).toBe(429);
  });

  /**
   * 端到端确认 sync-write 桶真的会命中。
   *
   * 第一版的 ROUTE_BUCKETS 写的是不存在的 `/api/sync/:section`，于是同步写入
   * 全部落到 default 桶 —— 而两个桶的默认阈值凑巧相同，所以没有任何症状。
   * 这条用 TIGHT 里刻意不同的阈值（sync-write 4 / default 6）把差异暴露出来：
   * 打 5 次 PUT 必须被挡，若又退化到 default 就要 7 次才挡。
   */
  it('PUT /api/sync 命中 sync-write 桶（不是 default）', async () => {
    const ip = '17.17.17.17';
    const { token } = await t.makeUser();
    const h = { ...t.auth(token), ...from(ip) };
    const payload = { section: 'connections', encryptedData: '{}', baseVersion: 0 };

    for (let i = 0; i < 4; i++) {
      const res = await t.app.inject({ method: 'PUT', url: '/api/sync', payload, headers: h });
      expect(res.statusCode, `第 ${i + 1} 次不该被挡`).not.toBe(429);
    }
    const blocked = await t.app.inject({ method: 'PUT', url: '/api/sync', payload, headers: h });
    expect(blocked.statusCode).toBe(429);
  });

  /**
   * 同一路由模板上读写必须走不同计数器。
   * 打满写入配额之后，读取还应该能用 —— 否则一次同步风暴会连带把界面刷不出来。
   */
  it('打满 sync-write 不影响同 IP 的 GET /api/sync', async () => {
    const ip = '18.18.18.18';
    const { token } = await t.makeUser();
    const h = { ...t.auth(token), ...from(ip) };
    const payload = { section: 'connections', encryptedData: '{}', baseVersion: 0 };

    for (let i = 0; i < 6; i++) {
      await t.app.inject({ method: 'PUT', url: '/api/sync', payload, headers: h });
    }
    const read = await t.app.inject({ method: 'GET', url: '/api/sync', headers: h });
    expect(read.statusCode).not.toBe(429);
  });
});

describe('IP 隔离', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp({ rateLimit: true, rateLimitOverrides: TIGHT });
  });
  afterEach(async () => { await t.close(); });

  it('一个 IP 被挡不影响另一个 IP', async () => {
    const body = { email: 'a@example.com', password: 'password123' };
    for (let i = 0; i < 6; i++) {
      await t.app.inject({
        method: 'POST', url: '/api/auth/login', payload: body, headers: from('7.7.7.7'),
      });
    }
    const other = await t.app.inject({
      method: 'POST', url: '/api/auth/login', payload: body, headers: from('8.8.8.8'),
    });
    expect(other.statusCode).not.toBe(429);
  });

  /**
   * trustProxy: 1 下 req.ip 取的是 XFF 右边第 1 跳。
   * 客户端在左边塞伪造值不该改变分桶 —— 否则每个请求换个伪造 IP 就绕过了。
   */
  it('客户端伪造 XFF 左段无法换桶', async () => {
    const body = { email: 'a@example.com', password: 'password123' };
    for (let i = 0; i < 4; i++) {
      await t.app.inject({
        method: 'POST', url: '/api/auth/login', payload: body,
        headers: { 'x-forwarded-for': `9.9.9.${i}, 10.10.10.10` },
      });
    }
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/login', payload: body,
      headers: { 'x-forwarded-for': '99.99.99.99, 10.10.10.10' },
    });
    expect(res.statusCode).toBe(429);
  });
});

describe('豁免', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp({ rateLimit: true, rateLimitOverrides: TIGHT });
  });
  afterEach(async () => { await t.close(); });

  it('/health 无论打多少次都不限流', async () => {
    for (let i = 0; i < 30; i++) {
      const res = await t.app.inject({ method: 'GET', url: '/health', headers: from('1.2.3.4') });
      expect(res.statusCode).toBe(200);
    }
  });

  it('桶被停用后该桶完全放行', async () => {
    await t.rateLimitConfig.update('auth-strict', { enabled: false });
    const body = { email: 'a@example.com', password: 'password123' };
    for (let i = 0; i < 10; i++) {
      const res = await t.app.inject({
        method: 'POST', url: '/api/auth/login', payload: body, headers: from('11.11.11.11'),
      });
      expect(res.statusCode).not.toBe(429);
    }
  });

  it('白名单 IP 不受限流（共用出口 IP 的逃生阀）', async () => {
    await t.rateLimitConfig.addAllowlist('12.12.12.12', 'HQ');
    const body = { email: 'a@example.com', password: 'password123' };
    for (let i = 0; i < 10; i++) {
      const res = await t.app.inject({
        method: 'POST', url: '/api/auth/login', payload: body, headers: from('12.12.12.12'),
      });
      expect(res.statusCode).not.toBe(429);
    }
  });

  it('阈值调高后立即生效（无需重启）', async () => {
    const body = { email: 'a@example.com', password: 'password123' };
    const ip = '13.13.13.13';
    for (let i = 0; i < 4; i++) {
      await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: body, headers: from(ip) });
    }
    // 已经被挡了
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: body, headers: from(ip) }))
        .statusCode,
    ).toBe(429);

    // 放宽阈值 → 同一个 IP 立刻能继续
    await t.rateLimitConfig.update('auth-strict', { maxRequests: 100 });
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: body, headers: from(ip) }))
        .statusCode,
    ).not.toBe(429);
  });
});

describe('总闸', () => {
  it('rateLimit=false 时完全不限流', async () => {
    const t = await buildTestApp({ rateLimit: false, rateLimitOverrides: TIGHT });
    const body = { email: 'a@example.com', password: 'password123' };
    for (let i = 0; i < 12; i++) {
      const res = await t.app.inject({
        method: 'POST', url: '/api/auth/login', payload: body, headers: from('14.14.14.14'),
      });
      expect(res.statusCode).not.toBe(429);
    }
    await t.close();
  });
});

describe('429 记录到 traffic_blocked', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp({ rateLimit: true, rateLimitOverrides: TIGHT });
  });
  afterEach(async () => { await t.close(); });

  it('被挡的请求带 IP / 路由模板 / 桶名落库', async () => {
    const body = { email: 'a@example.com', password: 'password123' };
    for (let i = 0; i < 6; i++) {
      await t.app.inject({
        method: 'POST', url: '/api/auth/login', payload: body, headers: from('15.15.15.15'),
      });
    }
    await t.app.flushTraffic();
    const rows = t.repos.trafficRepo.blocked;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].ip).toBe('15.15.15.15');
    expect(rows[0].route).toBe('/api/auth/login');
    expect(rows[0].bucket).toBe('auth-strict');
  });

  it('未被挡的请求不进 blocked 表', async () => {
    await t.app.inject({ method: 'GET', url: '/health', headers: from('16.16.16.16') });
    await t.app.flushTraffic();
    expect(t.repos.trafficRepo.blocked).toHaveLength(0);
  });
});
