import { describe, expect, it } from 'vitest';
import { RateLimitConfig } from '../../src/ratelimit/rateLimitConfig.js';
import { DEFAULT_RULES, RATE_LIMIT_BUCKETS } from '../../src/ratelimit/rules.js';

describe('RateLimitConfig（v2 纯内存，无 DB 覆盖/白名单）', () => {
  it('get 返回代码默认阈值', () => {
    const cfg = new RateLimitConfig();
    expect(cfg.get('auth-strict')).toEqual(DEFAULT_RULES['auth-strict']);
    expect(cfg.get('sync-write').maxRequests).toBe(DEFAULT_RULES['sync-write'].maxRequests);
  });

  it('listAll 覆盖所有桶且全部标记为 isDefault（v2 无覆盖）', () => {
    const cfg = new RateLimitConfig();
    const all = cfg.listAll();
    expect(all.map((r) => r.bucket).sort()).toEqual([...RATE_LIMIT_BUCKETS].sort());
    expect(all.every((r) => r.isDefault)).toBe(true);
    expect(all.every((r) => r.description.length > 0)).toBe(true);
  });

  it('isAllowed 恒 false（v2 无 DB 白名单，IP 豁免改由路由豁免表表达）', () => {
    const cfg = new RateLimitConfig();
    expect(cfg.isAllowed('1.2.3.4')).toBe(false);
    expect(cfg.isAllowed('203.0.113.9')).toBe(false);
  });
});