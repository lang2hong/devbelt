import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Server, utils } from 'ssh2';

vi.mock('vscode', () => ({
  window: { createOutputChannel: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), dispose: vi.fn() }), showErrorMessage: vi.fn() },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
}));

import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { RedisClient } from '@devbelt/db-core';
import { ConnectionManager } from '../../src/connection/connectionManager';
import { SshTunnel } from '../../src/connection/sshTunnel';
import { UNMAPPED_DEAD_PORT } from '../../src/connection/redisTopology';

/**
 * Cluster / Sentinel over SSH 真实集成（P7 S4 项 1）。env-gated。
 * - Cluster：`DEVBELT_DB_TEST_REDIS_CLUSTER=host:port`（种子）
 * - Sentinel：`DEVBELT_DB_TEST_REDIS_SENTINEL=host:port`（sentinel）
 * SSH 服务端为进程内 ssh2 `Server`（password + direct-tcpip）；目标节点由 CI 起。
 * 只有「SSH + 多节点」组合才会真正走 setupClusterOverSsh 的 natMap 路径。
 */
const CLUSTER_SEED = process.env.DEVBELT_DB_TEST_REDIS_CLUSTER;
const SENTINEL_ADDR = process.env.DEVBELT_DB_TEST_REDIS_SENTINEL;
const SSH_USER = 'tunnel';
const SSH_PASS = 'tunnel-pass';

/**
 * 仅在本 Cluster-over-SSH 集成运行时安装：D20 用例故意把某 master 映射到死端口，ioredis
 * 在该节点重试耗尽关闭时会 flush 内部命令队列并 reject "Connection is closed."——这是
 * **ioredis 内部 promise**（非本产品持有），无法在调用侧 catch，Vitest 会计为 unhandled
 * 使硬门禁转红。这里只在 env-gated 的集群集成里吞掉这一已知消息；其它任何未处理拒绝仍
 * 原样抛出、令测试失败（门禁对本产品代码依旧成立）。单元运行无此 env，不受影响。
 */
let restoreUnhandled: (() => void) | undefined;
if (CLUSTER_SEED) {
  const KNOWN_IOREDIS_NOISE = /Connection is closed\.|MaxRetriesPerRequestError/;
  const prior = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  const guard = (reason: unknown): void => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (KNOWN_IOREDIS_NOISE.test(msg)) return;
    throw reason instanceof Error ? reason : new Error(String(reason));
  };
  process.on('unhandledRejection', guard);
  restoreUnhandled = () => {
    process.removeListener('unhandledRejection', guard);
    for (const l of prior) process.on('unhandledRejection', l as (...a: unknown[]) => void);
  };
}

function hostPort(addr: string): { host: string; port: number } {
  const [host, port] = addr.split(':');
  return { host, port: Number(port) };
}

/** 有界等待 cluster_state:ok（集群刚 create 完仍可能有短暂抖动）。 */
async function waitClusterOk(client: { nodes(): { call(c: string, ...a: (string | number)[]): Promise<unknown> }[] }, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = String(await client.nodes()[0]?.call('CLUSTER', 'INFO') ?? '');
    if (/cluster_state:ok/.test(info)) return;
    if (Date.now() > deadline) throw new Error(`cluster_state 未就绪（${timeoutMs}ms）:\n${info}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 有界重试瞬时重定向（SET/DEL 幂等）；非重定向错误立即抛出。 */
async function withRedirectRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      if (!/MOVED|ASK|CLUSTERDOWN|Too many Cluster redirections/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  throw lastErr;
}

let server: Server;
let sshPort = 0;
const managers: ConnectionManager[] = [];

beforeAll(async () => {
  const hostKey = utils.generateKeyPairSync('ed25519');
  server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === SSH_USER && ctx.password === SSH_PASS) ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, _reject, info) => {
        const stream = accept();
        const socket = net.connect(info.destPort, info.destIP, () => { socket.pipe(stream); stream.pipe(socket); });
        socket.on('error', () => stream.close());
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  sshPort = (server.address() as net.AddressInfo).port;
  SshTunnel.configureHostKeyGate({
    policy: () => 'tofu',
    storeFile: path.join(os.tmpdir(), `devbelt-topo-${Date.now()}-known_hosts`),
    prompt: async () => true,
  });
});

afterAll(() => {
  SshTunnel.configureHostKeyGate(undefined);
  for (const m of managers) m.disposeAll();
  server?.close();
});

function baseConn(over: Record<string, unknown>): SavedConnection {
  return {
    id: `topo-${Math.random().toString(36).slice(2)}`,
    name: 'topo',
    dbType: 'REDIS',
    host: '127.0.0.1',
    port: 6379,
    sshHost: '127.0.0.1',
    sshPort,
    sshUser: SSH_USER,
    sshPassword: SSH_PASS,
    ...over,
  } as unknown as SavedConnection;
}

describe.skipIf(!CLUSTER_SEED)('Cluster over SSH（真实多节点 + natMap）', () => {
  it('发现 master → natMap → 跨 slot SET/GET', async () => {
    const seed = hostPort(CLUSTER_SEED!);
    const manager = new ConnectionManager();
    managers.push(manager);
    const session = await manager.connect(baseConn({ redisMode: 'cluster', host: seed.host, port: seed.port }));
    if (session.kind !== 'redis') throw new Error('not a redis session');
    expect(session.mode).toBe('cluster');
    try {
      const c = session.client;
      await waitClusterOk(c);
      // 逐 master 探活：任一 natMap 隧道不可用则在此明确失败（而非运行期 MOVED 风暴）。
      for (const n of c.nodes()) {
        expect(await n.call('PING')).toBe('PONG');
      }
      // 三个 key 大概率落到不同 slot，验证 natMap 路由可用。
      for (const k of ['topo:{1}', 'topo:{2}', 'topo:{3}']) {
        await withRedirectRetry(async () => {
          await c.sendCommand('SET', [k, 'v']);
          expect(String(await c.sendCommand('GET', [k]))).toBe('v');
          await c.sendCommand('DEL', [k]);
        });
      }
    } finally {
      manager.disposeAll();
    }
  }, 60_000);
});

describe.skipIf(!CLUSTER_SEED)('D20：未映射节点 → 命令在有限时间内失败（不挂起/不 Storm）', () => {
  it('未映射节点的 slot 有界报错，且其余节点仍可用', async () => {
    const seed = hostPort(CLUSTER_SEED!);
    // 用与生产一致的重试配置（不传 maxRetryTimes → 走 DEFAULT_RETRY_TIMES=3）。
    const plain = new RedisClient({ host: seed.host, port: seed.port, cluster: { nodes: [seed], slotsRefreshTimeout: 3000 } });
    try {
      const seedAddr = `${seed.host}:${seed.port}`;
      const slots = (await plain.sendCommand('CLUSTER', ['SLOTS'])) as unknown[][];
      const ranges = slots.filter((r) => Array.isArray(r) && r[2]) as any[][];
      // 未映射目标：一个「非种子」master（确保测的是 slot 路由，而非种子不可达）。
      const dropRange = ranges.find((r) => `${r[2][0]}:${r[2][1]}` !== seedAddr);
      if (!dropRange) throw new Error('no non-seed master range in CLUSTER SLOTS');
      const dropAddr = `${dropRange[2][0]}:${dropRange[2][1]}`;
      // 正向对照：任选另一个「不在 dropAddr」的区间，其 key 必须仍能读写。
      const okRange = ranges.find((r) => `${r[2][0]}:${r[2][1]}` !== dropAddr);
      if (!okRange) throw new Error('no usable master range in CLUSTER SLOTS');

      const keyIn = async (start: number, end: number): Promise<string> => {
        for (let i = 0; i < 20000; i++) {
          const cand = `d20:{${i}}`;
          const slot = Number(await plain.sendCommand('CLUSTER', ['KEYSLOT', cand]));
          if (slot >= start && slot <= end) return cand;
        }
        throw new Error(`no key in slot range ${start}-${end}`);
      };
      const badKey = await keyIn(Number(dropRange[0]), Number(dropRange[1]));
      const okKey = await keyIn(Number(okRange[0]), Number(okRange[1]));

      // 该 master 映射到死端口（模拟「拓扑变化后未映射」），其余地址按原样（生产 buildNatMap 行为）。
      const natMap = (address: string) => (address === dropAddr ? { host: '127.0.0.1', port: UNMAPPED_DEAD_PORT } : null);
      const client = new RedisClient({ host: seed.host, port: seed.port, cluster: { nodes: [seed], natMap, slotsRefreshTimeout: 3000 } });
      try {
        // 正向对照先行：其余节点可用，证明失败只出在未映射节点。
        expect(String(await client.sendCommand('SET', [okKey, 'v']))).toBe('OK');
        expect(String(await client.sendCommand('GET', [okKey]))).toBe('v');
        await client.sendCommand('DEL', [okKey]);

        const started = Date.now();
        const outcome = await Promise.race([
          client.sendCommand('SET', [badKey, 'v']).then(() => 'ok' as const, () => 'error' as const),
          new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20000)),
        ]);
        const elapsedMs = Date.now() - started;
        // 供 CI 日志抓取，写入 P7 §十一（决定 clusterRetryStrategy 优先级）。
        console.log(`D20 unmapped-node failure latency: ${elapsedMs}ms`);
        // 'timeout' = 挂起（阻塞发布）；'ok' = 没走到未映射节点。
        expect(outcome).toBe('error');
      } finally {
        // 让未映射节点的重试先退避一拍再 close，避免与在途重连竞争；cluster 重试不再
        // 返回 null（见 RedisClient.clusterRetryStrategy），故这里不会收到 `end`。
        await new Promise((r) => setTimeout(r, 1500));
        await client.close();
      }
    } finally {
      await plain.close();
    }
  }, 90_000);
});

afterAll(() => { restoreUnhandled?.(); });

describe.skipIf(!SENTINEL_ADDR)('Sentinel over SSH（发现 master 后 standalone 连）', () => {
  it('发现 master → 隧道 → PING/SET/GET', async () => {
    const sen = hostPort(SENTINEL_ADDR!);
    const manager = new ConnectionManager();
    managers.push(manager);
    const session = await manager.connect(baseConn({
      redisMode: 'sentinel',
      host: sen.host,
      port: sen.port,
      sentinelName: 'mymaster',
      sentinelNodes: SENTINEL_ADDR!,
    }));
    if (session.kind !== 'redis') throw new Error('not a redis session');
    expect(session.mode).toBe('sentinel');
    try {
      const c = session.client;
      expect(await c.sendCommand('PING', [])).toBe('PONG');
      await c.sendCommand('SET', ['topo:sentinel', 'v']);
      expect(String(await c.sendCommand('GET', ['topo:sentinel']))).toBe('v');
      await c.sendCommand('DEL', ['topo:sentinel']);
    } finally {
      manager.disposeAll();
    }
  }, 60_000);
});
