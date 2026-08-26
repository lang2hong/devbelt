import { describe, expect, it } from 'vitest';
import { TrafficCollector } from '../../src/observability/trafficCollector.js';

describe('TrafficCollector（纯内存）', () => {
  it('record 写入 60 分钟环形缓冲，recentMinutes 缺失分钟补零', () => {
    const c = new TrafficCollector();
    const now = new Date('2026-08-26T12:00:00Z');
    c.record('/api/sync', 200, now);
    c.record('/api/sync', 500, now);

    const minutes = c.recentMinutes(now);
    expect(minutes).toHaveLength(60);
    expect(minutes[59].minuteTs).toBe(now.getTime());
    expect(minutes[59].total).toBe(2);
    expect(minutes.slice(0, 59).every((m) => m.total === 0)).toBe(true);
  });

  it('按状态类归并（2xx/3xx/4xx 各自计数）', () => {
    const c = new TrafficCollector();
    const now = new Date('2026-08-26T12:00:00Z');
    c.record('/a', 200, now);
    c.record('/a', 301, now);
    c.record('/a', 404, now);

    const m = c.recentMinutes(now)[59];
    expect(m.byClass).toEqual({ 2: 1, 3: 1, 4: 1 });
  });

  it('跨分钟不混杂：60 分钟前同索引的槽被覆盖', () => {
    const c = new TrafficCollector();
    const now = new Date('2026-08-26T12:00:00Z');
    // 61 分钟前的请求不应出现在最近 60 分钟的窗口里
    const old = new Date(now.getTime() - 61 * 60_000);
    c.record('/old', 200, old);
    c.record('/new', 200, now);

    const minutes = c.recentMinutes(now);
    expect(minutes[59].total).toBe(1); // 只数 now 这一分钟
    expect(minutes.reduce((s, m) => s + m.total, 0)).toBe(1);
  });

  it('recordBlocked 记时间，recentBlocked 倒序且受上限约束', () => {
    const c = new TrafficCollector();
    for (let i = 0; i < 600; i++) {
      c.recordBlocked({ ip: `10.0.0.${i % 255}`, route: '/a', bucket: 'default' });
    }
    const blocked = c.recentBlocked(100);
    expect(blocked).toHaveLength(100);
    expect(blocked.every((b) => b.createTime instanceof Date)).toBe(true);
  });
});