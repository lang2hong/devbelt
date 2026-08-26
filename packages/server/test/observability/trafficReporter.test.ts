import { describe, expect, it } from 'vitest';
import { TrafficCollector } from '../../src/observability/trafficCollector.js';
import { TrafficReporter } from '../../src/observability/trafficReporter.js';

describe('TrafficReporter（纯内存聚合）', () => {
  it('total / routes 单行 errorRate / blocked 汇总正确', () => {
    const c = new TrafficCollector();
    const now = new Date('2026-08-26T12:00:00Z');
    // 8 次成功 + 2 次失败 = 10 次，错误率 0.2
    for (let i = 0; i < 8; i++) c.record('/api/sync', 200, now);
    c.record('/api/sync', 500, now);
    c.record('/api/sync', 400, now);
    c.recordBlocked({ ip: '9.9.9.9', route: '/api/auth/login', bucket: 'auth-strict' });

    const r = new TrafficReporter(c).report(24, now);

    expect(r.hours).toBe(24);
    expect(r.total).toBe(10);
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0]).toMatchObject({ route: 'all', total: 10, ok: 8, clientError: 1, serverError: 1 });
    expect(r.routes[0].errorRate).toBe(0.2);
    expect(r.minutes).toHaveLength(60);
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0]).toMatchObject({ ip: '9.9.9.9', bucket: 'auth-strict' });
    expect(r.blockedTotal).toBe(1);
  });

  it('无流量时 total=0 且 errorRate=0（除零保护）', () => {
    const c = new TrafficCollector();
    const r = new TrafficReporter(c).report(1, new Date('2026-08-26T12:00:00Z'));
    expect(r.total).toBe(0);
    expect(r.routes[0].errorRate).toBe(0);
  });
});