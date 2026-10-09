import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ clusterOptions: [] as Record<string, unknown>[] }));

vi.mock('ioredis', () => {
  class FakeCluster {
    status = 'ready';
    constructor(_nodes: unknown, public options: Record<string, unknown>) {
      h.clusterOptions.push(options);
    }
    on(): this { return this; }
    nodes(): unknown[] { return []; }
    sendCommand = async (): Promise<unknown> => 'OK';
    disconnect(): void { /* noop */ }
  }
  class FakeRedis {
    status = 'ready';
    on(): this { return this; }
    disconnect(): void { /* noop */ }
  }
  class Command {
    constructor(public name: string, public args: unknown, public opts: unknown) { /* noop */ }
  }
  return { default: FakeRedis, Cluster: FakeCluster, Command };
});

import { RedisClient } from '../../src/redis/redisClient';

describe('RedisClient cluster 连接选项（保持 CI 已验证的 f4def0f 形态）', () => {
  it('节点级旋钮经 redisOptions 传入；cluster 级重试用 clusterRetryStrategy；不设顶层 offline queue', () => {
    new RedisClient({
      host: 'h',
      port: 1,
      cluster: { nodes: [{ host: '127.0.0.1', port: 6379 }] },
    });
    const opts = h.clusterOptions.at(-1)!;
    // Cluster 级重试在顶层；节点级 retryStrategy 走 redisOptions（被 ConnectionPool 的内部默认
    // 覆盖，依赖「重试耗尽即关节点」的默认来实现 D20 有界失败）。
    expect(typeof opts.clusterRetryStrategy).toBe('function');
    // 不设顶层 clusterNodeRetryStrategy / enableOfflineQueue：设了会让未映射节点命令挂到
    // 命令超时、并让「构造后立刻发命令」直接 reject（CI cluster-over-SSH D20 已钉住）。
    expect(opts.clusterNodeRetryStrategy).toBeUndefined();
    expect(opts.enableOfflineQueue).toBeUndefined();
    const redisOptions = opts.redisOptions as Record<string, unknown> | undefined;
    expect(typeof redisOptions?.retryStrategy).toBe('function');
  });
});
