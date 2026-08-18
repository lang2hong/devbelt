import { describe, expect, it } from 'vitest';
import { TrafficCollector } from '../../src/observability/trafficCollector.js';

/**
 * 采集器是纯内存结构，没有 I/O，所以可以精确控制时间来测边界。
 *
 * 三类容易出错的地方：环形缓冲的槽复用、跨小时/跨分钟的桶归属、
 * flush 失败后的数据合并（写成覆盖就会静默丢数据）。
 */

const at = (iso: string) => new Date(iso);

describe('TrafficCollector.record', () => {
  it('状态码折算成 statusClass', () => {
    const c = new TrafficCollector();
    c.record('/api/me', 200, at('2026-01-01T10:00:00Z'));
    c.record('/api/me', 204, at('2026-01-01T10:00:00Z'));
    c.record('/api/me', 404, at('2026-01-01T10:00:00Z'));
    c.record('/api/me', 500, at('2026-01-01T10:00:00Z'));
    const rows = c.drain();
    const byClass = Object.fromEntries(rows.map((r) => [r.statusClass, r.count]));
    expect(byClass).toEqual({ 2: 2, 4: 1, 5: 1 });
  });

  it('同一小时同一路由同一状态类合并成一行', () => {
    const c = new TrafficCollector();
    for (let i = 0; i < 5; i++) {
      // 分散在这一小时的不同分钟，小时桶仍应只有一行
      c.record('/api/sync', 200, at(`2026-01-01T10:${String(i * 10).padStart(2, '0')}:00Z`));
    }
    const rows = c.drain();
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(5);
    expect(rows[0].bucketTime.toISOString()).toBe('2026-01-01T10:00:00.000Z');
  });

  it('跨小时边界拆成两行', () => {
    const c = new TrafficCollector();
    c.record('/api/sync', 200, at('2026-01-01T10:59:59Z'));
    c.record('/api/sync', 200, at('2026-01-01T11:00:00Z'));
    const rows = c.drain().sort((a, b) => a.bucketTime.getTime() - b.bucketTime.getTime());
    expect(rows).toHaveLength(2);
    expect(rows[0].bucketTime.toISOString()).toBe('2026-01-01T10:00:00.000Z');
    expect(rows[1].bucketTime.toISOString()).toBe('2026-01-01T11:00:00.000Z');
  });

  it('不同路由不合并', () => {
    const c = new TrafficCollector();
    c.record('/api/me', 200, at('2026-01-01T10:00:00Z'));
    c.record('/api/sync', 200, at('2026-01-01T10:00:00Z'));
    expect(c.drain()).toHaveLength(2);
  });
});

describe('TrafficCollector.recentMinutes', () => {
  it('恒返回 60 个点，升序，缺失分钟补零', () => {
    const c = new TrafficCollector();
    const now = at('2026-01-01T10:30:00Z');
    c.record('/api/me', 200, now);
    const m = c.recentMinutes(now);
    expect(m).toHaveLength(60);
    for (let i = 1; i < m.length; i++) {
      expect(m[i].minuteTs).toBeGreaterThan(m[i - 1].minuteTs);
    }
    // 最后一个点是当前分钟
    expect(m[59].total).toBe(1);
    // 其余补零而不是缺项 —— 前端画曲线时「零请求」不能变成断线
    expect(m.slice(0, 59).every((p) => p.total === 0)).toBe(true);
  });

  it('同一分钟内累加', () => {
    const c = new TrafficCollector();
    const now = at('2026-01-01T10:30:00Z');
    c.record('/a', 200, at('2026-01-01T10:30:10Z'));
    c.record('/a', 200, at('2026-01-01T10:30:40Z'));
    c.record('/a', 500, at('2026-01-01T10:30:59Z'));
    const last = c.recentMinutes(now)[59];
    expect(last.total).toBe(3);
    expect(last.byClass).toEqual({ 2: 2, 5: 1 });
  });

  it('相邻分钟落在不同点上', () => {
    const c = new TrafficCollector();
    const now = at('2026-01-01T10:30:00Z');
    c.record('/a', 200, at('2026-01-01T10:29:30Z'));
    c.record('/a', 200, at('2026-01-01T10:30:30Z'));
    const m = c.recentMinutes(now);
    expect(m[58].total).toBe(1);
    expect(m[59].total).toBe(1);
  });

  /**
   * 环形缓冲的核心不变式：60 分钟前的数据必须自动消失。
   *
   * 实现靠 `minuteTs % 60` 索引 + 写入时比对 minuteTs，槽被复用即重置。
   * 如果漏了那个比对，一小时前的计数会被当成当前数据加进去。
   */
  it('超过 60 分钟的数据被槽复用自动淘汰', () => {
    const c = new TrafficCollector();
    c.record('/a', 200, at('2026-01-01T09:30:00Z'));
    // 恰好 60 分钟后 → 同一个槽索引
    const now = at('2026-01-01T10:30:00Z');
    const m = c.recentMinutes(now);
    expect(m.every((p) => p.total === 0)).toBe(true);
  });

  it('恰好 59 分钟前的数据还在窗口内', () => {
    const c = new TrafficCollector();
    c.record('/a', 200, at('2026-01-01T09:31:00Z'));
    const m = c.recentMinutes(at('2026-01-01T10:30:00Z'));
    expect(m[0].total).toBe(1);
  });

  it('无数据时也返回 60 个零点', () => {
    const m = new TrafficCollector().recentMinutes(at('2026-01-01T10:30:00Z'));
    expect(m).toHaveLength(60);
    expect(m.every((p) => p.total === 0)).toBe(true);
  });

  it('返回的 byClass 是副本，改它不影响内部状态', () => {
    const c = new TrafficCollector();
    const now = at('2026-01-01T10:30:00Z');
    c.record('/a', 200, now);
    const first = c.recentMinutes(now)[59];
    first.byClass[2] = 999;
    expect(c.recentMinutes(now)[59].byClass[2]).toBe(1);
  });
});

describe('TrafficCollector.drain', () => {
  it('取出后清空', () => {
    const c = new TrafficCollector();
    c.record('/a', 200);
    expect(c.drain()).toHaveLength(1);
    expect(c.drain()).toHaveLength(0);
    expect(c.pendingSize()).toBe(0);
  });

  it('空集合返回空数组（不是 undefined）', () => {
    expect(new TrafficCollector().drain()).toEqual([]);
  });

  it('drain 不影响分钟环（两层数据独立）', () => {
    const c = new TrafficCollector();
    const now = at('2026-01-01T10:30:00Z');
    c.record('/a', 200, now);
    c.drain();
    expect(c.recentMinutes(now)[59].total).toBe(1);
  });
});

describe('TrafficCollector.restore（flush 失败回滚）', () => {
  /**
   * 这条是本文件最重要的用例。
   *
   * flush 的时序是：drain() 清空 → 写库 → 失败 → restore()。在「写库」这段
   * 时间里新请求仍在往 pending 写。如果 restore 写成赋值而不是合并，
   * 这段时间的数据就没了 —— 而且没有任何报错，只是统计数字偏小。
   */
  it('回滚的数据与期间新增的数据相加，不互相覆盖', async () => {
    const c = new TrafficCollector();
    const t = at('2026-01-01T10:00:00Z');
    c.record('/a', 200, t);
    c.record('/a', 200, t);
    const drained = c.drain();
    expect(drained[0].count).toBe(2);

    // 模拟写库期间又来了请求
    c.record('/a', 200, t);
    c.restore(drained);

    const after = c.drain();
    expect(after).toHaveLength(1);
    expect(after[0].count).toBe(3);
  });

  it('回滚到空集合时原样恢复', () => {
    const c = new TrafficCollector();
    c.record('/a', 200, at('2026-01-01T10:00:00Z'));
    const drained = c.drain();
    c.restore(drained);
    expect(c.drain()).toEqual(drained);
  });

  it('不同键的回滚各自独立', () => {
    const c = new TrafficCollector();
    const t = at('2026-01-01T10:00:00Z');
    c.record('/a', 200, t);
    c.record('/b', 500, t);
    const drained = c.drain();
    c.restore(drained);
    expect(c.drain()).toHaveLength(2);
  });
});

describe('TrafficCollector 429 记录', () => {
  it('逐条累积，drain 后清空', () => {
    const c = new TrafficCollector();
    c.recordBlocked({ ip: '1.1.1.1', route: '/api/auth/login', bucket: 'auth-strict' });
    c.recordBlocked({ ip: '2.2.2.2', route: '/api/sync/:section', bucket: 'sync-write' });
    expect(c.pendingBlockedSize()).toBe(2);
    const rows = c.drainBlocked();
    expect(rows).toHaveLength(2);
    expect(rows[0].ip).toBe('1.1.1.1');
    expect(c.drainBlocked()).toEqual([]);
  });

  it('同 IP 同路由不去重（次数本身是信号）', () => {
    const c = new TrafficCollector();
    for (let i = 0; i < 3; i++) {
      c.recordBlocked({ ip: '1.1.1.1', route: '/api/auth/login', bucket: 'auth-strict' });
    }
    expect(c.drainBlocked()).toHaveLength(3);
  });

  it('回滚放回队首，保持时间顺序', () => {
    const c = new TrafficCollector();
    c.recordBlocked({ ip: 'a', route: '/x', bucket: 'default' });
    const drained = c.drainBlocked();
    c.recordBlocked({ ip: 'b', route: '/x', bucket: 'default' });
    c.restoreBlocked(drained);
    expect(c.drainBlocked().map((r) => r.ip)).toEqual(['a', 'b']);
  });
});
