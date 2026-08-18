import { describe, expect, it } from 'vitest';
import { RateLimitConfig } from '../../src/ratelimit/rateLimitConfig.js';
import { DEFAULT_RULES, bucketForRoute, RATE_LIMIT_BUCKETS } from '../../src/ratelimit/rules.js';
import { FakeRateLimitRepo } from '../helpers/fakeRepos.js';

/**
 * 配置层的核心承诺：
 *  - DB 为空 / DB 读失败 → 限流按代码默认值工作（不失效，也不报错）
 *  - 后台改动 → 内存立即可见（无 TTL 缓存，无陈旧窗口）
 *  - DB 写失败 → 内存不动（保持与 DB 一致，避免重启后回滚）
 */

/**
 * 这里只测分桶的**判定逻辑**。
 * 路由模板字符串本身是否真实存在，由 routeCoverage.test.ts 从 app 实例抓真值校验
 * —— 那件事在这个文件里做不到，只写字面量的话测试会和实现一起错。
 */
describe('bucketForRoute', () => {
  it('auth 三个写端点归 auth-strict', () => {
    expect(bucketForRoute('POST', '/api/auth/login')).toBe('auth-strict');
    expect(bucketForRoute('POST', '/api/auth/register')).toBe('auth-strict');
    expect(bucketForRoute('POST', '/api/auth/change-password')).toBe('auth-strict');
  });

  it('refresh 单独一桶（比登录宽松）', () => {
    expect(bucketForRoute('POST', '/api/auth/refresh')).toBe('auth-refresh');
    const strict = DEFAULT_RULES['auth-strict'];
    const refresh = DEFAULT_RULES['auth-refresh'];
    // 同窗口下 refresh 的额度必须更大，否则多设备用户会被误伤
    expect(refresh.windowSeconds).toBe(strict.windowSeconds);
    expect(refresh.maxRequests).toBeGreaterThan(strict.maxRequests);
  });

  it('同步写入归 sync-write', () => {
    expect(bucketForRoute('PUT', '/api/sync')).toBe('sync-write');
    expect(bucketForRoute('POST', '/api/sync/rollback')).toBe('sync-write');
  });

  /**
   * `/api/sync` 上 GET 是读、PUT 是写，共用一个路由模板。
   * 只看路径无法区分，这是 method 参数存在的唯一理由。
   */
  it('同一路由模板上读写分桶（method 参与判定）', () => {
    expect(bucketForRoute('GET', '/api/sync')).toBe('default');
    expect(bucketForRoute('PUT', '/api/sync')).toBe('sync-write');
  });

  it('HEAD 与 GET 同桶（Fastify 给每个 GET 自动补 HEAD）', () => {
    expect(bucketForRoute('HEAD', '/api/sync')).toBe(bucketForRoute('GET', '/api/sync'));
  });

  it('method 大小写不敏感', () => {
    expect(bucketForRoute('put', '/api/sync')).toBe('sync-write');
    expect(bucketForRoute('post', '/api/auth/login')).toBe('auth-strict');
  });

  it('/admin 前缀归 admin 桶', () => {
    expect(bucketForRoute('GET', '/admin/users')).toBe('admin');
    expect(bucketForRoute('PATCH', '/admin/users/:id')).toBe('admin');
    expect(bucketForRoute('GET', '/admin/traffic')).toBe('admin');
  });

  it('其余归 default', () => {
    expect(bucketForRoute('GET', '/api/me')).toBe('default');
    expect(bucketForRoute('POST', '/api/usage')).toBe('default');
    expect(bucketForRoute('GET', '/api/sync/versions')).toBe('default');
  });

  /**
   * /health 必须豁免：监控探针会一直打它，挡掉等于把自己的健康检查搞红。
   */
  it('/health 豁免', () => {
    expect(bucketForRoute('GET', '/health')).toBeUndefined();
  });

  it('静态资源通配路由豁免（一次页面加载十几个 chunk）', () => {
    expect(bucketForRoute('GET', '/admin/*')).toBeUndefined();
  });

  it('未匹配路由（undefined）走 default，不会因为没有路由就漏过限流', () => {
    expect(bucketForRoute('GET', undefined)).toBe('default');
    expect(bucketForRoute(undefined, undefined)).toBe('default');
  });
});

describe('DEFAULT_RULES', () => {
  it('每个桶都有定义且启用', () => {
    for (const b of RATE_LIMIT_BUCKETS) {
      const r = DEFAULT_RULES[b];
      expect(r, b).toBeDefined();
      expect(r.enabled, b).toBe(true);
      expect(r.maxRequests, b).toBeGreaterThan(0);
      expect(r.windowSeconds, b).toBeGreaterThan(0);
      // description 会直接显示在后台，空的话管理员得去翻代码
      expect(r.description.length, b).toBeGreaterThan(10);
    }
  });

  /**
   * 阈值必须容得下实测的合法峰值。
   *
   * 单设备一次自动同步 = 7 个请求（1 pull + 5 push + 1 usage），防抖 3 秒，
   * 所以 sync-write 的合法峰值约 140 req/min。阈值低于这个数就是在锁自己人。
   */
  it('sync-write 容得下单设备实测峰值（约 140 req/min）并留有余量', () => {
    const r = DEFAULT_RULES['sync-write'];
    const perMinute = (r.maxRequests / r.windowSeconds) * 60;
    expect(perMinute).toBeGreaterThanOrEqual(140 * 4);
  });

  it('auth-strict 定得紧（一天登录几次，20 次足够）', () => {
    const r = DEFAULT_RULES['auth-strict'];
    expect(r.maxRequests).toBeLessThanOrEqual(30);
    expect(r.windowSeconds).toBeGreaterThanOrEqual(60);
  });
});

describe('RateLimitConfig 默认值', () => {
  it('无 repo 时用代码默认值', () => {
    const cfg = new RateLimitConfig(undefined);
    expect(cfg.get('auth-strict')).toEqual(DEFAULT_RULES['auth-strict']);
  });

  it('repo 为空表时仍是默认值（不需要播种数据）', async () => {
    const cfg = new RateLimitConfig(new FakeRateLimitRepo());
    await cfg.reload();
    for (const b of RATE_LIMIT_BUCKETS) {
      expect(cfg.get(b), b).toEqual(DEFAULT_RULES[b]);
    }
  });

  it('listAll 标出哪些是默认值', () => {
    const cfg = new RateLimitConfig(undefined);
    expect(cfg.listAll().every((r) => r.isDefault)).toBe(true);
  });
});

describe('RateLimitConfig DB 覆盖', () => {
  it('覆盖行生效，未覆盖的桶保持默认', async () => {
    const repo = new FakeRateLimitRepo();
    await repo.upsertRule({
      bucket: 'auth-strict', maxRequests: 3, windowSeconds: 60, enabled: true,
    });
    const cfg = new RateLimitConfig(repo);
    await cfg.reload();
    expect(cfg.get('auth-strict').maxRequests).toBe(3);
    expect(cfg.get('auth-strict').windowSeconds).toBe(60);
    expect(cfg.get('default')).toEqual(DEFAULT_RULES.default);
  });

  it('覆盖后 isDefault 变 false（后台能看出被改过）', async () => {
    const repo = new FakeRateLimitRepo();
    await repo.upsertRule({
      bucket: 'admin', maxRequests: 99, windowSeconds: 60, enabled: true,
    });
    const cfg = new RateLimitConfig(repo);
    await cfg.reload();
    const row = cfg.listAll().find((r) => r.bucket === 'admin')!;
    expect(row.isDefault).toBe(false);
    expect(row.description).toBe(DEFAULT_RULES.admin.description);
  });

  it('description 不被 DB 覆盖（它是代码里的说明，不是配置）', async () => {
    const repo = new FakeRateLimitRepo();
    await repo.upsertRule({
      bucket: 'default', maxRequests: 5, windowSeconds: 5, enabled: false,
    });
    const cfg = new RateLimitConfig(repo);
    await cfg.reload();
    expect(cfg.get('default').description).toBe(DEFAULT_RULES.default.description);
  });

  /**
   * DB 里可能残留已废弃的桶名（代码改了桶划分之后）。
   * 忽略它们，而不是让整个 reload 炸掉。
   */
  it('忽略 DB 里的未知桶名', async () => {
    const repo = new FakeRateLimitRepo();
    await repo.upsertRule({
      bucket: 'legacy-bucket-from-old-version', maxRequests: 1, windowSeconds: 1, enabled: true,
    });
    const cfg = new RateLimitConfig(repo);
    await expect(cfg.reload()).resolves.toBeUndefined();
    expect(cfg.get('default')).toEqual(DEFAULT_RULES.default);
  });

  /**
   * 这条是设计的关键取舍：DB 挂了限流仍要工作。
   *
   * 让限流因为 DB 抖动而失效，比用一套不那么精确的阈值糟糕得多 ——
   * 后者只是不够准，前者是门直接敞开。
   */
  it('DB 读失败时回落到默认值，不抛错', async () => {
    const repo = new FakeRateLimitRepo();
    await repo.upsertRule({
      bucket: 'auth-strict', maxRequests: 3, windowSeconds: 60, enabled: true,
    });
    repo.failReads = true;
    const warns: unknown[] = [];
    const cfg = new RateLimitConfig(repo, { warn: (o) => warns.push(o) });

    await expect(cfg.reload()).resolves.toBeUndefined();
    expect(cfg.get('auth-strict')).toEqual(DEFAULT_RULES['auth-strict']);
    // 必须留下痕迹，否则运维不知道自己在用默认值
    expect(warns.length).toBe(2); // rules + allowlist 各一条
  });

  it('reload 可重复调用，结果幂等', async () => {
    const repo = new FakeRateLimitRepo();
    await repo.upsertRule({
      bucket: 'admin', maxRequests: 42, windowSeconds: 30, enabled: true,
    });
    const cfg = new RateLimitConfig(repo);
    await cfg.reload();
    await cfg.reload();
    expect(cfg.get('admin').maxRequests).toBe(42);
  });

  it('reload 会清掉上一轮的覆盖（DB 删行后恢复默认）', async () => {
    const repo = new FakeRateLimitRepo();
    await repo.upsertRule({
      bucket: 'admin', maxRequests: 42, windowSeconds: 30, enabled: true,
    });
    const cfg = new RateLimitConfig(repo);
    await cfg.reload();
    expect(cfg.get('admin').maxRequests).toBe(42);

    repo.rules.clear();
    await cfg.reload();
    expect(cfg.get('admin')).toEqual(DEFAULT_RULES.admin);
  });
});

describe('RateLimitConfig.update', () => {
  it('写 DB 并立即更新内存（无陈旧窗口）', async () => {
    const repo = new FakeRateLimitRepo();
    const cfg = new RateLimitConfig(repo);
    await cfg.update('auth-strict', { maxRequests: 7 });
    // 内存立刻可见，不需要 reload
    expect(cfg.get('auth-strict').maxRequests).toBe(7);
    // DB 也写了，重启后仍生效
    expect(repo.rules.get('auth-strict')?.maxRequests).toBe(7);
  });

  it('部分更新只改指定字段', async () => {
    const cfg = new RateLimitConfig(new FakeRateLimitRepo());
    const before = cfg.get('default');
    await cfg.update('default', { maxRequests: 11 });
    expect(cfg.get('default').maxRequests).toBe(11);
    expect(cfg.get('default').windowSeconds).toBe(before.windowSeconds);
    expect(cfg.get('default').enabled).toBe(before.enabled);
  });

  it('enabled=false 停用该桶', async () => {
    const cfg = new RateLimitConfig(new FakeRateLimitRepo());
    await cfg.update('sync-write', { enabled: false });
    expect(cfg.get('sync-write').enabled).toBe(false);
  });

  /**
   * DB 写失败时内存不能改：否则重启后配置会「回滚」到旧值，
   * 管理员以为改好了，实际只在这一次进程生命周期里生效。
   */
  it('DB 写失败时内存保持不变', async () => {
    const repo = new FakeRateLimitRepo();
    repo.upsertRule = async () => { throw new Error('db down'); };
    const cfg = new RateLimitConfig(repo);
    const before = cfg.get('admin').maxRequests;
    await expect(cfg.update('admin', { maxRequests: 1 })).rejects.toThrow('db down');
    expect(cfg.get('admin').maxRequests).toBe(before);
  });

  it('无 repo 时只改内存（不崩）', async () => {
    const cfg = new RateLimitConfig(undefined);
    await cfg.update('admin', { maxRequests: 5 });
    expect(cfg.get('admin').maxRequests).toBe(5);
  });
});

describe('RateLimitConfig 白名单', () => {
  it('加入后 isAllowed 为真', async () => {
    const repo = new FakeRateLimitRepo();
    const cfg = new RateLimitConfig(repo);
    expect(cfg.isAllowed('203.0.113.9')).toBe(false);
    await cfg.addAllowlist('203.0.113.9', 'HQ office');
    expect(cfg.isAllowed('203.0.113.9')).toBe(true);
    expect(repo.allowlist.get('203.0.113.9')?.note).toBe('HQ office');
  });

  it('移除后失效', async () => {
    const cfg = new RateLimitConfig(new FakeRateLimitRepo());
    await cfg.addAllowlist('1.1.1.1');
    await cfg.removeAllowlist('1.1.1.1');
    expect(cfg.isAllowed('1.1.1.1')).toBe(false);
  });

  it('reload 从 DB 恢复白名单', async () => {
    const repo = new FakeRateLimitRepo();
    await repo.addAllowlist('10.0.0.1', 'office');
    const cfg = new RateLimitConfig(repo);
    expect(cfg.isAllowed('10.0.0.1')).toBe(false);
    await cfg.reload();
    expect(cfg.isAllowed('10.0.0.1')).toBe(true);
  });

  it('白名单读失败时视为空（限流照常，只是没有豁免）', async () => {
    const repo = new FakeRateLimitRepo();
    await repo.addAllowlist('10.0.0.1');
    repo.failReads = true;
    const cfg = new RateLimitConfig(repo, { warn: () => {} });
    await cfg.reload();
    expect(cfg.isAllowed('10.0.0.1')).toBe(false);
  });

  it('重复加入不产生重复项', async () => {
    const cfg = new RateLimitConfig(new FakeRateLimitRepo());
    await cfg.addAllowlist('1.1.1.1');
    await cfg.addAllowlist('1.1.1.1', 'updated note');
    expect(cfg.listAllowlist()).toEqual(['1.1.1.1']);
  });
});
