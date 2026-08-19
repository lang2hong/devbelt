import { describe, expect, it, vi } from 'vitest';
import { MysqlMaintenanceRepo } from '../../src/repository/mysql/maintenanceRepo.js';
import { startMaintenance, PRUNE_BATCH } from '../../src/maintenance.js';

/**
 * SQL 桩：记录发出的 DELETE 语句与参数，并按预设的剩余行数模拟分批删除。
 * 按语句特征子串分派，语句形态改了就对不上 —— 守住「必须带 LIMIT 分批」
 * 和「必须按 create_time 过滤」这两条。
 */
class StubDb {
  readonly database = 'stub';
  calls: Array<{ sql: string; params: any[] }> = [];
  /** 表名 → 待删行数（每次 DELETE 扣掉一批） */
  pending = new Map<string, number>();
  failOn?: string;

  async query(sql: string, params: any[] = []): Promise<any> {
    this.calls.push({ sql, params });
    if (this.failOn && sql.includes(this.failOn)) throw new Error(`injected: ${this.failOn}`);
    const table = /DELETE FROM (\w+)/.exec(sql)?.[1];
    if (!table) throw new Error(`StubDb: 未预期的语句 ${sql.slice(0, 50)}`);
    const limit = params[params.length - 1];
    const left = this.pending.get(table) ?? 0;
    const deleted = Math.min(left, typeof limit === 'number' ? limit : left);
    this.pending.set(table, left - deleted);
    return [{ affectedRows: deleted }, []];
  }

  async getConnection(): Promise<any> {
    throw new Error('清理不该开事务：长事务会把 undo log 顶起来，还会长时间持锁');
  }

  sqlFor(table: string) {
    return this.calls.filter((c) => c.sql.includes(`DELETE FROM ${table}`));
  }
}

const repoOf = (db: StubDb) => new MysqlMaintenanceRepo(() => db as any);

describe('MysqlMaintenanceRepo.pruneEvents', () => {
  it('四张事件表 + 过期会话行各按 create_time 分批删除', async () => {
    const db = new StubDb();
    const now = new Date('2026-08-19T00:00:00Z');
    const res = await repoOf(db).pruneEvents(90, now);

    for (const t of ['sync_events', 'usage_events', 'device_events', 'traffic_blocked']) {
      const calls = db.sqlFor(t);
      expect(calls, `${t} 未被清理`).not.toHaveLength(0);
      // 必须带 LIMIT：一次删掉几十万行会长时间持锁并把 binlog 顶起来
      expect(calls[0].sql).toMatch(/LIMIT \?/);
      expect(calls[0].sql).toMatch(/create_time < \?/);
      // 截止时间 = now - 90 天
      const cutoff = calls[0].params[0] as Date;
      expect(cutoff.toISOString()).toBe('2026-05-21T00:00:00.000Z');
      expect(calls[0].params[1]).toBe(PRUNE_BATCH);
    }
    expect(db.sqlFor('refresh_tokens')).not.toHaveLength(0);
    expect(res.total).toBe(0);
  });

  it('行数超过一批时继续删，直到某批不满为止', async () => {
    const db = new StubDb();
    db.pending.set('sync_events', PRUNE_BATCH * 2 + 7);
    const res = await repoOf(db).pruneEvents(30, new Date());
    // 满批 + 满批 + 7 → 三条语句
    expect(db.sqlFor('sync_events')).toHaveLength(3);
    expect(res.deleted.sync_events).toBe(PRUNE_BATCH * 2 + 7);
  });

  it('单表反复满批时有上限，不会无限循环占着连接', async () => {
    const db = new StubDb();
    db.pending.set('sync_events', Number.MAX_SAFE_INTEGER);
    const res = await repoOf(db).pruneEvents(30, new Date());
    const n = db.sqlFor('sync_events').length;
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(100);
    // 没删完也要让别的表有机会被清理
    expect(db.sqlFor('usage_events')).not.toHaveLength(0);
    expect(res.deleted.sync_events).toBe(n * PRUNE_BATCH);
  });

  it('retentionDays <= 0 视为关闭：一条语句都不发', async () => {
    const db = new StubDb();
    const res = await repoOf(db).pruneEvents(0, new Date());
    expect(db.calls).toHaveLength(0);
    expect(res.total).toBe(0);
  });

  it('某张表报错不影响其余表，错误在结果里带回', async () => {
    const db = new StubDb();
    db.pending.set('usage_events', 5);
    db.failOn = 'DELETE FROM sync_events';
    const res = await repoOf(db).pruneEvents(30, new Date());
    expect(res.errors.map((e) => e.table)).toEqual(['sync_events']);
    expect(res.deleted.usage_events).toBe(5);
    expect(db.sqlFor('device_events')).not.toHaveLength(0);
  });

  /**
   * refresh_tokens 的清理条件比事件表严：只能删「已失效**且**过了保留期」的行。
   * 删掉仍然有效的会话等于把用户踢下线；删掉刚撤销的行会让 token 重用检测
   * 失去依据（重用检测靠的正是那条 revoked 行还在）。
   */
  it('refresh_tokens 只删已过期或已撤销的行，且要过了保留期', async () => {
    const db = new StubDb();
    const call = (await (async () => { await repoOf(db).pruneEvents(90, new Date()); return db.sqlFor('refresh_tokens')[0]; })());
    expect(call.sql).toMatch(/expires_time < \?|revoked_time < \?/);
    expect(call.sql).toMatch(/LIMIT \?/);
    // 绝不能出现无条件删除
    expect(call.sql).not.toMatch(/DELETE FROM refresh_tokens\s+LIMIT/);
  });
});

describe('startMaintenance 定时任务', () => {
  function fakeRepo() {
    const calls: Array<{ days: number }> = [];
    return {
      calls,
      repo: {
        pruneEvents: async (days: number) => {
          calls.push({ days });
          return { deleted: {}, errors: [], total: 0 };
        },
      },
    };
  }
  const log = { info: () => {}, warn: () => {}, error: () => {} } as any;

  it('立即跑一次，之后按间隔重复；stop 后不再触发', async () => {
    vi.useFakeTimers();
    try {
      const { calls, repo } = fakeRepo();
      const stop = startMaintenance({ repo: repo as any, log, retentionDays: 90, intervalMs: 3600_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3600_000 * 2);
      expect(calls).toHaveLength(3);
      stop();
      await vi.advanceTimersByTimeAsync(3600_000 * 5);
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retentionDays <= 0 时完全不启动，stop 是安全的空操作', async () => {
    vi.useFakeTimers();
    try {
      const { calls, repo } = fakeRepo();
      const stop = startMaintenance({ repo: repo as any, log, retentionDays: 0, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toHaveLength(0);
      expect(() => { stop(); stop(); }).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 清理抛错必须在回调内部被吞掉。定时器回调里的未捕获 rejection 按 Node 默认的
   * `--unhandled-rejections=throw` 会直接终止进程 —— 一次 DB 抖动就能把整个
   * 服务干掉。所以这里不只断言「后续轮次还在跑」，还直接监听
   * unhandledRejection：少了 catch 时它会被触发，而调用次数断言照样是绿的。
   */
  it('清理抛错不冒泡、不产生 unhandledRejection、不中断后续轮次', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    vi.useFakeTimers();
    try {
      let n = 0;
      const repo = { pruneEvents: async () => { n += 1; throw new Error('db down'); } };
      const stop = startMaintenance({ repo: repo as any, log, retentionDays: 90, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);
      expect(n).toBe(4);
      stop();
    } finally {
      vi.useRealTimers();
      // rejection 的上报是微任务级的，让事件循环转一圈再断言
      await new Promise((r) => setImmediate(r));
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled, '清理失败泄漏成 unhandledRejection，生产环境会终止进程').toEqual([]);
  });

  /**
   * timer 必须 unref：否则一个 24 小时间隔的 interval 会让 Node 事件循环
   * 永远有活儿，`process.exit` 之外的正常退出（含 vitest 结束）会挂住。
   */
  it('定时器 unref，不阻止进程退出', () => {
    vi.useFakeTimers();
    try {
      const { repo } = fakeRepo();
      const spy = vi.spyOn(global, 'setInterval');
      const stop = startMaintenance({ repo: repo as any, log, retentionDays: 90, intervalMs: 1000 });
      const timer = spy.mock.results[0].value as any;
      expect(typeof timer.unref).toBe('function');
      expect(timer.hasRef?.()).toBe(false);
      stop();
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
