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

describe('RedisClient cluster 连接选项（H1：节点级旋钮必须放顶层）', () => {
  it('节点级重试用顶层 clusterNodeRetryStrategy；redisOptions 不含被忽略的 retryStrategy', () => {
    new RedisClient({
      host: 'h',
      port: 1,
      cluster: { nodes: [{ host: '127.0.0.1', port: 6379 }] },
    });
    const opts = h.clusterOptions.at(-1)!;
    expect(typeof opts.clusterNodeRetryStrategy).toBe('function');
    expect(typeof opts.clusterRetryStrategy).toBe('function');
    // 不关闭离线队列：设 false 会让「构造后立刻发命令」直接 reject（CI D20 回归）。
    expect(opts.enableOfflineQueue).toBeUndefined();
    const redisOptions = opts.redisOptions as Record<string, unknown> | undefined;
    // ConnectionPool 会写死 retryStrategy 并用 defaults 合并，redisOptions 里的值无效。
    expect(redisOptions?.retryStrategy).toBeUndefined();
  });
});
