import { describe, expect, it } from 'vitest';
import { TrafficReporter } from '../../src/observability/trafficReporter.js';
import { TrafficCollector } from '../../src/observability/trafficCollector.js';
import { FakeTrafficRepo } from '../helpers/fakeRepos.js';

/**
 * 聚合逻辑。
 *
 * 这段代码在服务端而不是 Vue 组件里，唯一原因就是为了能被这个文件测到 ——
 * admin-ui 没有测试运行器。错误率算错、跨小时补零漏掉这类问题，在前端只
 * 表现为「图画得有点怪」，几乎不可能被发现。
 */

const at = (iso: string) => new Date(iso);

async function seed(repo: FakeTrafficRepo, rows: Array<[string, string, number, number]>) {
  await repo.upsertStats(
    rows.map(([iso, route, statusClass, count]) => ({
      bucketTime: at(iso), route, statusClass, count,
    })),
  );
}

describe('按路由汇总', () => {
  it('合并状态类，算出错误率，按总量降序', async () => {
    const repo = new FakeTrafficRepo();
    await seed(repo, [
      ['2026-01-01T10:00:00Z', '/api/sync', 2, 100],
      ['2026-01-01T10:00:00Z', '/api/sync', 4, 20],
      ['2026-01-01T10:00:00Z', '/api/sync', 5, 5],
      ['2026-01-01T10:00:00Z', '/api/me', 2, 10],
    ]);
    const r = await new TrafficReporter(repo, new TrafficCollector()).report(
      2, at('2026-01-01T11:00:00Z'),
    );

    expect(r.routes[0].route).toBe('/api/sync');
    expect(r.routes[0].total).toBe(125);
    expect(r.routes[0].ok).toBe(100);
    expect(r.routes[0].clientError).toBe(20);
    expect(r.routes[0].serverError).toBe(5);
    expect(r.routes[0].errorRate).toBe(0.2);
    expect(r.routes[1].route).toBe('/api/me');
    expect(r.total).toBe(135);
  });

  it('3xx 计入 ok（重定向不是错误）', async () => {
    const repo = new FakeTrafficRepo();
    await seed(repo, [
      ['2026-01-01T10:00:00Z', '/x', 2, 5],
      ['2026-01-01T10:00:00Z', '/x', 3, 5],
    ]);
    const r = await new TrafficReporter(repo, new TrafficCollector()).report(
      2, at('2026-01-01T11:00:00Z'),
    );
    expect(r.routes[0].ok).toBe(10);
    expect(r.routes[0].errorRate).toBe(0);
  });

  it('全错时错误率为 1', async () => {
    const repo = new FakeTrafficRepo();
    await seed(repo, [['2026-01-01T10:00:00Z', '/x', 5, 7]]);
    const r = await new TrafficReporter(repo, new TrafficCollector()).report(
      2, at('2026-01-01T11:00:00Z'),
    );
    expect(r.routes[0].errorRate).toBe(1);
  });

  it('错误率保留 4 位小数（避免前端拿到 0.3333333333333333）', async () => {
    const repo = new FakeTrafficRepo();
    await seed(repo, [
      ['2026-01-01T10:00:00Z', '/x', 2, 2],
      ['2026-01-01T10:00:00Z', '/x', 4, 1],
    ]);
    const r = await new TrafficReporter(repo, new TrafficCollector()).report(
      2, at('2026-01-01T11:00:00Z'),
    );
    expect(r.routes[0].errorRate).toBe(0.3333);
  });

  it('跨小时的同一路由合并成一行', async () => {
    const repo = new FakeTrafficRepo();
    await seed(repo, [
      ['2026-01-01T09:00:00Z', '/x', 2, 3],
      ['2026-01-01T10:00:00Z', '/x', 2, 4],
    ]);
    const r = await new TrafficReporter(repo, new TrafficCollector()).report(
      5, at('2026-01-01T11:00:00Z'),
    );
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0].total).toBe(7);
  });

  it('无数据时返回空数组而不是报错', async () => {
    const r = await new TrafficReporter(new FakeTrafficRepo(), new TrafficCollector()).report(24);
    expect(r.routes).toEqual([]);
    expect(r.total).toBe(0);
  });
});

describe('小时序列', () => {
  /**
   * 补零是刚需：夜里没人用的时段如果不补零，曲线会断成好几截，
   * 看起来像服务反复挂掉。
   */
  it('缺失的小时补零，不留空洞', async () => {
    const repo = new FakeTrafficRepo();
    await seed(repo, [
      ['2026-01-01T08:00:00Z', '/x', 2, 1],
      ['2026-01-01T11:00:00Z', '/x', 2, 2],
    ]);
    const r = await new TrafficReporter(repo, new TrafficCollector()).report(
      4, at('2026-01-01T11:30:00Z'),
    );
    // 07:00..11:00 共 5 个点（起点向下取整到整点）
    expect(r.hourly).toHaveLength(5);
    const totals = r.hourly.map((p) => p.total);
    expect(totals).toEqual([0, 1, 0, 0, 2]);
  });

  it('点按时间升序', async () => {
    const repo = new FakeTrafficRepo();
    await seed(repo, [
      ['2026-01-01T10:00:00Z', '/x', 2, 1],
      ['2026-01-01T08:00:00Z', '/x', 2, 1],
    ]);
    const r = await new TrafficReporter(repo, new TrafficCollector()).report(
      4, at('2026-01-01T10:30:00Z'),
    );
    const times = r.hourly.map((p) => new Date(p.bucketTime).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  it('每个点按状态类拆分', async () => {
    const repo = new FakeTrafficRepo();
    await seed(repo, [
      ['2026-01-01T10:00:00Z', '/a', 2, 3],
      ['2026-01-01T10:00:00Z', '/b', 5, 2],
    ]);
    const r = await new TrafficReporter(repo, new TrafficCollector()).report(
      1, at('2026-01-01T10:30:00Z'),
    );
    const last = r.hourly[r.hourly.length - 1];
    expect(last.byClass).toEqual({ 2: 3, 5: 2 });
    expect(last.total).toBe(5);
  });

  it('hours=1 也至少给两个点（上一个整点 + 当前整点）', async () => {
    const r = await new TrafficReporter(new FakeTrafficRepo(), new TrafficCollector()).report(
      1, at('2026-01-01T10:30:00Z'),
    );
    expect(r.hourly.length).toBeGreaterThanOrEqual(2);
  });
});

describe('分钟序列（来自内存）', () => {
  it('恒 60 个点，与 collector 一致', async () => {
    const collector = new TrafficCollector();
    const now = at('2026-01-01T10:30:00Z');
    collector.record('/x', 200, now);
    const r = await new TrafficReporter(new FakeTrafficRepo(), collector).report(1, now);
    expect(r.minutes).toHaveLength(60);
    expect(r.minutes[59].total).toBe(1);
  });

  it('不依赖 repo（进程内数据，DB 挂了也有实时曲线）', async () => {
    const collector = new TrafficCollector();
    const now = at('2026-01-01T10:30:00Z');
    collector.record('/x', 200, now);
    const r = await new TrafficReporter(undefined, collector).report(1, now);
    expect(r.minutes[59].total).toBe(1);
    expect(r.routes).toEqual([]);
  });
});

describe('429 明细', () => {
  it('带出 IP / 路由 / 桶，时间序列化成 ISO', async () => {
    const repo = new FakeTrafficRepo();
    await repo.insertBlocked([
      { ip: '1.1.1.1', route: '/api/auth/login', bucket: 'auth-strict' },
    ]);
    const r = await new TrafficReporter(repo, new TrafficCollector()).report(1);
    expect(r.blockedTotal).toBe(1);
    expect(r.blocked[0].ip).toBe('1.1.1.1');
    expect(r.blocked[0].bucket).toBe('auth-strict');
    expect(r.blocked[0].createTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('无 429 时为空', async () => {
    const r = await new TrafficReporter(new FakeTrafficRepo(), new TrafficCollector()).report(1);
    expect(r.blocked).toEqual([]);
    expect(r.blockedTotal).toBe(0);
  });
});

describe('查询窗口', () => {
  it('窗口外的数据不计入', async () => {
    const repo = new FakeTrafficRepo();
    await seed(repo, [
      ['2026-01-01T00:00:00Z', '/old', 2, 999],
      ['2026-01-01T10:00:00Z', '/new', 2, 1],
    ]);
    const r = await new TrafficReporter(repo, new TrafficCollector()).report(
      2, at('2026-01-01T10:30:00Z'),
    );
    expect(r.routes.map((x) => x.route)).toEqual(['/new']);
    expect(r.total).toBe(1);
  });

  /**
   * 起点必须向下取整到整点，否则会漏掉当前小时的前半段数据 ——
   * 小时桶的 bucket_time 是整点，10:30 往前推 1 小时得到 09:30，
   * 而 10:00 的桶 >= 09:30 成立，但如果不取整，24 小时前的边界桶会被切掉。
   */
  it('起点向下取整到整点，不切掉边界桶', async () => {
    const repo = new FakeTrafficRepo();
    await seed(repo, [['2026-01-01T09:00:00Z', '/x', 2, 5]]);
    const r = await new TrafficReporter(repo, new TrafficCollector()).report(
      1, at('2026-01-01T10:20:00Z'),
    );
    // 09:20 往前取整到 09:00 → 09:00 的桶被包含
    expect(r.total).toBe(5);
  });

  it('hours 回显在响应里（前端要用来标注坐标轴）', async () => {
    const r = await new TrafficReporter(new FakeTrafficRepo(), new TrafficCollector()).report(72);
    expect(r.hours).toBe(72);
  });
});
