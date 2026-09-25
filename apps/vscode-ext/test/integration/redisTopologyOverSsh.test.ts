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
import { ConnectionManager } from '../../src/connection/connectionManager';
import { SshTunnel } from '../../src/connection/sshTunnel';

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

function hostPort(addr: string): { host: string; port: number } {
  const [host, port] = addr.split(':');
  return { host, port: Number(port) };
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
      // 三个 key 大概率落到不同 slot，验证 natMap 路由可用。
      for (const k of ['topo:{1}', 'topo:{2}', 'topo:{3}']) {
        await c.sendCommand('SET', [k, 'v']);
        expect(String(await c.sendCommand('GET', [k]))).toBe('v');
        await c.sendCommand('DEL', [k]);
      }
    } finally {
      manager.disposeAll();
    }
  }, 60_000);
});

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
