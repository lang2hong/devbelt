import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { TrafficCollector } from '../../src/observability/trafficCollector.js';
import {
  registerTrafficPlugin,
  routeKeyOf,
  STATIC_ROUTE,
  UNMATCHED_ROUTE,
} from '../../src/observability/trafficPlugin.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { FakeTrafficRepo } from '../helpers/fakeRepos.js';

/**
 * 插件层的两个关键行为：
 *
 * 1. **route 必须是路由模板**。用 req.url 的话 `/admin/users/1..1000` 会变成
 *    1000 个不同的 route 值，traffic_stats 的基数无界（列宽还只有 80 字符）。
 * 2. **定时器必须在 onClose 清掉**。不清的话 setInterval 一直持有事件循环引用：
 *    生产上表现为收到 SIGTERM 不退出，测试里表现为 vitest 挂住不结束。
 */

async function buildApp(opts: {
  repo?: FakeTrafficRepo;
  collector?: TrafficCollector;
  flushIntervalMs?: number;
} = {}) {
  const collector = opts.collector ?? new TrafficCollector();
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerTrafficPlugin(app, {
    collector,
    repo: opts.repo,
    flushIntervalMs: opts.flushIntervalMs ?? 3_600_000,
  });
  app.get('/health', async () => ({ ok: true }));
  app.get('/api/users/:id', async () => ({ ok: true }));
  app.get('/api/users/:id/devices/:deviceId/events', async () => ({ ok: true }));
  app.get('/boom', async () => { throw new Error('kaboom'); });
  await app.ready();
  return { app, collector };
}

describe('routeKeyOf', () => {
  it('取路由模板而非实际路径', async () => {
    const { app, collector } = await buildApp();
    await app.inject({ method: 'GET', url: '/api/users/1' });
    await app.inject({ method: 'GET', url: '/api/users/2' });
    await app.inject({ method: 'GET', url: '/api/users/999' });
    const rows = collector.drain();
    // 三个不同的 id 必须合并成一行，否则基数无界
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe('/api/users/:id');
    expect(rows[0].count).toBe(3);
    await app.close();
  });

  it('多参数路由同样归并', async () => {
    const { app, collector } = await buildApp();
    await app.inject({ method: 'GET', url: '/api/users/1/devices/abc/events' });
    await app.inject({ method: 'GET', url: '/api/users/2/devices/xyz/events' });
    const rows = collector.drain();
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe('/api/users/:id/devices/:deviceId/events');
    await app.close();
  });

  it('404 归到 __unmatched__（路由探测不会撑爆表）', async () => {
    const { app, collector } = await buildApp();
    for (const url of ['/nope', '/.env', '/wp-admin', '/phpmyadmin']) {
      await app.inject({ method: 'GET', url });
    }
    const rows = collector.drain();
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe(UNMATCHED_ROUTE);
    expect(rows[0].count).toBe(4);
    expect(rows[0].statusClass).toBe(4);
    await app.close();
  });

  it('静态资源通配路由归到 __static__', () => {
    const fake = { routeOptions: { url: '/admin/*' } } as any;
    expect(routeKeyOf(fake)).toBe(STATIC_ROUTE);
  });

  it('无 routeOptions 时归到 __unmatched__', () => {
    expect(routeKeyOf({} as any)).toBe(UNMATCHED_ROUTE);
    expect(routeKeyOf({ routeOptions: {} } as any)).toBe(UNMATCHED_ROUTE);
  });

  it('超长模板截断到 80 字符（与 DB 列宽对齐）', () => {
    const long = '/api/' + 'x'.repeat(200);
    expect(routeKeyOf({ routeOptions: { url: long } } as any)).toHaveLength(80);
  });
});

describe('采集覆盖各类响应', () => {
  it('2xx / 4xx / 5xx 都被记录', async () => {
    const { app, collector } = await buildApp();
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/nope' });
    await app.inject({ method: 'GET', url: '/boom' });
    const byClass = new Map(collector.drain().map((r) => [r.statusClass, r]));
    expect(byClass.get(2)?.route).toBe('/health');
    expect(byClass.get(4)?.route).toBe(UNMATCHED_ROUTE);
    expect(byClass.get(5)?.route).toBe('/boom');
    await app.close();
  });

  it('抛异常的请求也进统计（onResponse 仍会触发）', async () => {
    const { app, collector } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(collector.drain()[0].statusClass).toBe(5);
    await app.close();
  });
});

describe('flush', () => {
  it('手动 flush 把数据写进 repo', async () => {
    const repo = new FakeTrafficRepo();
    const { app, collector } = await buildApp({ repo });
    await app.inject({ method: 'GET', url: '/health' });
    await app.flushTraffic();
    expect(repo.stats.size).toBe(1);
    expect(collector.pendingSize()).toBe(0);
    await app.close();
  });

  it('同一小时桶多次 flush 累加而非覆盖', async () => {
    const repo = new FakeTrafficRepo();
    const { app } = await buildApp({ repo });
    await app.inject({ method: 'GET', url: '/health' });
    await app.flushTraffic();
    await app.inject({ method: 'GET', url: '/health' });
    await app.flushTraffic();
    expect([...repo.stats.values()][0].count).toBe(2);
    await app.close();
  });

  /**
   * 写库失败不能丢数据：MySQL 抖一下不该让这一分钟的统计消失。
   */
  it('写库失败时数据回到 collector，下次 flush 补上', async () => {
    const repo = new FakeTrafficRepo();
    const { app, collector } = await buildApp({ repo });
    repo.failWrites = true;
    await app.inject({ method: 'GET', url: '/health' });
    await app.flushTraffic();
    expect(repo.stats.size).toBe(0);
    expect(collector.pendingSize()).toBe(1);

    repo.failWrites = false;
    await app.flushTraffic();
    expect([...repo.stats.values()][0].count).toBe(1);
    await app.close();
  });

  it('无 repo 时 flush 是安全的 no-op', async () => {
    const { app } = await buildApp();
    await app.inject({ method: 'GET', url: '/health' });
    await expect(app.flushTraffic()).resolves.toBeUndefined();
    await app.close();
  });

  it('空 pending 时 flush 不打扰 repo', async () => {
    const repo = new FakeTrafficRepo();
    const spy = vi.spyOn(repo, 'upsertStats');
    const { app } = await buildApp({ repo });
    await app.flushTraffic();
    expect(spy).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('生命周期', () => {
  /**
   * 定时器泄漏检测。
   *
   * 关键点：close 之后必须**再往 collector 里塞数据**才能验出来。
   * 光看 repo 调用次数不增长是恒绿的 —— flush 在 pending 为空时会提前返回，
   * 定时器就算还在跑也不会碰 repo。塞了数据之后，活着的定时器一定会把它写出去。
   */
  it('close 之后定时器不再触发', async () => {
    const repo = new FakeTrafficRepo();
    const { app, collector } = await buildApp({ repo, flushIntervalMs: 20 });
    await app.inject({ method: 'GET', url: '/health' });
    await new Promise((r) => setTimeout(r, 60));
    expect(repo.stats.size).toBeGreaterThan(0);

    await app.close();

    // 定时器若未清理，这条记录会在 20ms 后被写进 repo
    collector.record('/leaked-after-close', 200);
    const sizeAfterClose = repo.stats.size;
    await new Promise((r) => setTimeout(r, 100));

    expect(repo.stats.size).toBe(sizeAfterClose);
    expect([...repo.stats.values()].some((r) => r.route === '/leaked-after-close')).toBe(false);
    // 数据还留在 collector 里 —— 没被偷偷 flush 走
    expect(collector.pendingSize()).toBe(1);
  });

  it('close 时做最后一次 flush（不丢最后一个周期的数据）', async () => {
    const repo = new FakeTrafficRepo();
    const { app } = await buildApp({ repo });
    await app.inject({ method: 'GET', url: '/health' });
    expect(repo.stats.size).toBe(0);
    await app.close();
    expect(repo.stats.size).toBe(1);
  });

  /**
   * unref 是第二道保险：即使 onClose 没跑到（比如进程被别的路径终止），
   * 这个定时器也不该算「进程还有事要做」。直接检查 handle 的 hasRef()。
   */
  it('定时器已 unref，不会吊住事件循环', async () => {
    const timers: NodeJS.Timeout[] = [];
    const realSetInterval = globalThis.setInterval;
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((fn: any, ms: any) => {
        const t = realSetInterval(fn, ms);
        timers.push(t);
        return t;
      }) as any);

    const { app } = await buildApp({ flushIntervalMs: 3_600_000 });
    spy.mockRestore();

    expect(timers).toHaveLength(1);
    expect(timers[0].hasRef()).toBe(false);
    await app.close();
  });
});

describe('与 @fastify/static 共存', () => {
  it('静态资源请求归并到 __static__，不逐个 chunk 记', async () => {
    const collector = new TrafficCollector();
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await registerTrafficPlugin(app, { collector, flushIntervalMs: 3_600_000 });
    await app.register(fastifyStatic, {
      root: resolve(import.meta.dirname, '../helpers'),
      prefix: '/admin/',
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/admin/testApp.ts' });
    await app.inject({ method: 'GET', url: '/admin/fakeRepos.ts' });
    const rows = collector.drain();
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe(STATIC_ROUTE);
    expect(rows[0].count).toBe(2);
    await app.close();
  });
});
