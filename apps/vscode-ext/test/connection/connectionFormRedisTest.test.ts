import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn() },
  ViewColumn: { Active: 1 },
}));

import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { redisTestClientOptions } from '../../src/connection/connectionForm';

function conn(overrides: Partial<SavedConnection>): SavedConnection {
  return { id: 'c1', name: 'R', dbType: 'REDIS' as SavedConnection['dbType'], host: 'redis.example', port: 6379, user: 'u', database: '', ...overrides };
}

/**
 * D11：测试连接必须按 redisMode 分派——cluster/sentinel 连接不能按 standalone 单节点误测。
 * SSH 分支（合成隧道 + NAT map）由调用方叠加，此处钉住非 SSH 的选项构造。
 */
describe('redisTestClientOptions（测试连接模式分派）', () => {
  it('standalone：host/port/db 透传，readOnly 恒 true', () => {
    const opts = redisTestClientOptions(conn({ redisMode: 'standalone', redisDb: 2 }), 'redis.example', 6379);
    expect(opts.host).toBe('redis.example');
    expect(opts.port).toBe(6379);
    expect(opts.db).toBe(2);
    expect(opts.readOnly).toBe(true);
    expect(opts.cluster).toBeUndefined();
    expect(opts.sentinels).toBeUndefined();
  });

  it('cluster：解析 clusterNodes；缺省回退到 host:port', () => {
    const opts = redisTestClientOptions(
      conn({ redisMode: 'cluster', clusterNodes: 'a:7000, b:7001' }),
      'fallback',
      7000,
    );
    expect(opts.cluster?.nodes).toEqual([{ host: 'a', port: 7000 }, { host: 'b', port: 7001 }]);

    const fallback = redisTestClientOptions(conn({ redisMode: 'cluster', clusterNodes: undefined }), 'fallback', 7000);
    expect(fallback.cluster?.nodes).toEqual([{ host: 'fallback', port: 7000 }]);
  });

  it('sentinel：解析 sentinelNodes 并带上 master 名/密码/库', () => {
    const opts = redisTestClientOptions(
      conn({ redisMode: 'sentinel', sentinelNodes: 's1:26379,s2:26379', sentinelName: 'mymaster', sentinelPassword: 'sp', redisDb: 3 }),
      's1',
      26379,
    );
    expect(opts.sentinels).toEqual([{ host: 's1', port: 26379 }, { host: 's2', port: 26379 }]);
    expect(opts.sentinelName).toBe('mymaster');
    expect(opts.sentinelPassword).toBe('sp');
    expect(opts.db).toBe(3);
    expect(opts.host).toBeUndefined();
  });

  it('sentinel：缺 master 名时报错（与运行时会话装配一致）', () => {
    expect(() =>
      redisTestClientOptions(conn({ redisMode: 'sentinel', sentinelNodes: 's1:26379' }), 's1', 26379),
    ).toThrow(/Sentinel master/);
  });
});