import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ args: [] as any[] }));

vi.mock('../../src/connection/sshTunnel', () => ({
  SshTunnel: { create: async () => undefined, close: () => {}, closeAll: () => {} },
}));

vi.mock('@devbelt/db-core', async (importOriginal) => {
  const actual = await importOriginal<any>();
  class FakeRedisClient {
    isCluster: boolean;
    mode: string;
    private alive = true;
    constructor(opts: any) {
      h.args.push(opts);
      this.isCluster = !!opts.cluster;
      this.mode = opts.cluster ? 'cluster' : (opts.sentinels ? 'sentinel' : 'standalone');
    }
    async connect(): Promise<void> { /* noop */ }
    async ping(): Promise<string> { return 'PONG'; }
    async close(): Promise<void> { this.alive = false; }
    isAlive(): boolean { return this.alive; }
    async sendCommand(): Promise<unknown> { return 'OK'; }
    async info(): Promise<string> { return ''; }
  }
  return { ...actual, RedisClient: FakeRedisClient, buildRedisTlsOptions: (i: unknown) => i };
});

import { DatabaseType } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { ConnectionManager } from '../../src/connection/connectionManager';

function conn(over: Record<string, unknown>): SavedConnection {
  return { id: 'c', name: 'n', dbType: DatabaseType.REDIS, host: 'h', port: 6379, user: '', ...over } as unknown as SavedConnection;
}

describe('buildRedisSession 按 redisMode 分派（S4）', () => {
  it('cluster：mode=cluster 且传入节点列表', async () => {
    const m = new ConnectionManager();
    const s = await m.connect(conn({ redisMode: 'cluster', clusterNodes: 'h1:7000, h2:7001' }));
    expect(s.kind).toBe('redis');
    expect((s as any).mode).toBe('cluster');
    const last = h.args[h.args.length - 1];
    expect(last.cluster.nodes).toEqual([{ host: 'h1', port: 7000 }, { host: 'h2', port: 7001 }]);
    m.disposeAll();
  });

  it('cluster：未配节点则回退 host:port', async () => {
    const m = new ConnectionManager();
    await m.connect(conn({ redisMode: 'cluster', host: 'the-host', port: 7002 }));
    const last = h.args[h.args.length - 1];
    expect(last.cluster.nodes).toEqual([{ host: 'the-host', port: 7002 }]);
    m.disposeAll();
  });

  it('sentinel：mode=sentinel 且传 sentinels + master 名', async () => {
    const m = new ConnectionManager();
    const s = await m.connect(conn({ redisMode: 'sentinel', sentinelNodes: 's1:26379', sentinelName: 'mymaster', sentinelPassword: 'sp' }));
    expect((s as any).mode).toBe('sentinel');
    const last = h.args[h.args.length - 1];
    expect(last.sentinels).toEqual([{ host: 's1', port: 26379 }]);
    expect(last.sentinelName).toBe('mymaster');
    expect(last.sentinelPassword).toBe('sp');
    m.disposeAll();
  });

  it('SSH + Cluster：明确拒绝（多跳 NAT map 待接入）', async () => {
    const m = new ConnectionManager();
    await expect(m.connect(conn({ redisMode: 'cluster', sshHost: 'jump' }))).rejects.toThrow(/SSH \+ Redis Cluster/);
    m.disposeAll();
  });

  it('sentinel 缺 master 名：拒绝', async () => {
    const m = new ConnectionManager();
    await expect(m.connect(conn({ redisMode: 'sentinel', sentinelNodes: 's1:26379' }))).rejects.toThrow(/master 名称未配置/);
    m.disposeAll();
  });
});
