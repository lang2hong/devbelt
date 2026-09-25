import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Server, utils } from 'ssh2';

vi.mock('vscode', () => ({
  window: { createOutputChannel: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), dispose: vi.fn() }) },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
}));

import { RedisClient } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { SshTunnel } from '../../src/connection/sshTunnel';

/**
 * SSH 隧道真实集成（P7 gate）。env-gated：`DEVBELT_DB_TEST_REDIS_URL` 为转发目标 Redis。
 *
 * SSH 服务端用 **进程内 ssh2 `Server`**（支持 password 认证 + direct-tcpip 转发），
 * 而非外部 sshd 容器——CI 的 linuxserver 镜像默认禁 TCP 转发且 services 不能挂配置。
 * 端到端验证我们的 `SshTunnel`（host-key gate → forwardOut → 回收）。
 * host-key 用 TOFU gate（prompt 恒 true）；服务端密钥为进程内临时生成。
 */
const REDIS_URL = process.env.DEVBELT_DB_TEST_REDIS_URL;
const SSH_USER = 'tunnel';
const SSH_PASS = 'tunnel-pass';

describe.skipIf(!REDIS_URL)('Redis over SSH 隧道（进程内 ssh2 server）', () => {
  const storeFile = path.join(os.tmpdir(), `devbelt-ssh-${Date.now()}-known_hosts`);
  let server: Server;
  let sshPort = 0;
  let targetHost = '127.0.0.1';
  let targetPort = 6379;

  beforeAll(async () => {
    const url = new URL(REDIS_URL!);
    targetHost = url.hostname;
    targetPort = Number(url.port || 6379);

    const hostKey = utils.generateKeyPairSync('ed25519');
    server = new Server({ hostKeys: [hostKey.private] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === SSH_USER && ctx.password === SSH_PASS) ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () => {
        client.on('tcpip', (accept, _reject, info) => {
          const stream = accept();
          const socket = net.connect(info.destPort, info.destIP, () => {
            socket.pipe(stream);
            stream.pipe(socket);
          });
          socket.on('error', () => stream.close());
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    sshPort = (server.address() as net.AddressInfo).port;
    SshTunnel.configureHostKeyGate({ policy: () => 'tofu', storeFile, prompt: async () => true });
  });

  afterAll(() => {
    SshTunnel.configureHostKeyGate(undefined);
    server?.close();
  });

  it('建立隧道 → 经隧道路由 PING → 关闭回收', async () => {
    const conn = {
      id: 'ci-ssh-redis',
      name: 'ci-ssh',
      dbType: 'REDIS',
      host: targetHost,
      port: targetPort,
      sshHost: '127.0.0.1',
      sshPort,
      sshUser: SSH_USER,
      sshPassword: SSH_PASS,
    } as unknown as SavedConnection;

    const localPort = await SshTunnel.create(conn);
    expect(typeof localPort).toBe('number');
    expect(localPort!).toBeGreaterThan(0);

    const client = new RedisClient({ host: '127.0.0.1', port: localPort!, connectTimeout: 10_000 });
    try {
      await client.connect();
      expect(await client.ping()).toBe('PONG');
    } finally {
      await client.close();
      SshTunnel.close(conn.id);
    }
  }, 60_000);
});
