import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  args: [] as any[],
  created: [] as string[],
  closed: [] as string[],
  clusterNodes: null as string | null,
  clusterResolvers: [] as (() => void)[],
  portSeq: 40000,
  pendingCluster: false,
}));

vi.mock('../../src/connection/sshTunnel', () => ({
  SshTunnel: {
    create: async (c: any) => { h.created.push(c.id); return ++h.portSeq; },
    close: (id: string) => { h.closed.push(id); },
    closeAll: () => {},
  },
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
    connect(): Promise<void> {
      // 主 cluster client 挂起，制造「建连期间 dispose」窗口；probe（无 cluster）立即就绪。
      if (this.isCluster && h.pendingCluster) return new Promise<void>((resolve) => h.clusterResolvers.push(resolve));
      return Promise.resolve();
    }
    async ping(): Promise<string> { return 'PONG'; }
    async close(): Promise<void> { this.alive = false; }
    isAlive(): boolean { return this.alive; }
    async sendCommand(name: string): Promise<unknown> {
      if (name === 'CLUSTER' && h.clusterNodes) return h.clusterNodes;
      return 'OK';
    }
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
  beforeEach(() => {
    h.args = []; h.created = []; h.closed = []; h.clusterNodes = null; h.clusterResolvers = []; h.portSeq = 40000; h.pendingCluster = false;
  });
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

  it('cluster+SSH：建连期间 dispose → 自毁并回收全部合成隧道', async () => {
    h.pendingCluster = true;
    h.clusterNodes = [
      'a 10.0.0.1:7000@17000 master - 0 0 1 connected 0-5460',
      'b 10.0.0.2:7001@17001 master - 0 0 2 connected 5461-10922',
      'c 10.0.0.3:7002@17002 master - 0 0 3 connected 10923-16383',
      '',
    ].join('\n');
    const m = new ConnectionManager();
    const pending = m.connect(conn({ redisMode: 'cluster', sshHost: 'jump', host: 'seed', port: 7000 }));
    await vi.waitFor(() => {
      if (h.clusterResolvers.length < 1) throw new Error('cluster client connect not reached');
    });
    expect(h.created.filter((id) => id.includes('#nat')).length).toBe(3);

    m.disposeConn('c');
    h.clusterResolvers.forEach((r) => r());

    await expect(pending).rejects.toThrow(/closed/i);
    expect(h.closed.filter((id) => id.includes('#nat')).sort()).toEqual(['c#nat0', 'c#nat1', 'c#nat2']);
    m.disposeAll();
  });

  it('SSH + Cluster：经种子隧道发现 master（mock 无节点 → 报发现错误，不再直接拒绝）', async () => {
    const m = new ConnectionManager();
    // sshTunnel 被 mock 为 create→undefined；FakeRedisClient.sendCommand 返回 'OK'，
    // 故 CLUSTER NODES 解析为空 → 报「未返回任何 master 节点」。
    await expect(m.connect(conn({ redisMode: 'cluster', sshHost: 'jump' }))).rejects.toThrow(/未返回任何 master 节点/);
    m.disposeAll();
  });

  it('sentinel 缺 master 名：拒绝', async () => {
    const m = new ConnectionManager();
    await expect(m.connect(conn({ redisMode: 'sentinel', sentinelNodes: 's1:26379' }))).rejects.toThrow(/master 名称未配置/);
    m.disposeAll();
  });
});
