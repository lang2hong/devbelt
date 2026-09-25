import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({
  window: { createOutputChannel: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), dispose: vi.fn() }) },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
}));

import { RedisClient } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { SshTunnel } from '../../src/connection/sshTunnel';

/**
 * SSH 隧道真实集成（P7 gate）。env-gated：`DEVBELT_DB_TEST_REDIS_SSH` 为 sshd 连接 JSON，
 * `DEVBELT_DB_TEST_REDIS_URL` 为隧道目标 Redis。未设置时整体 skip。
 * host-key 用 TOFU gate（prompt 恒 true）——CI 的 sshd 是我们自己起的，可信。
 */
const SSH_RAW = process.env.DEVBELT_DB_TEST_REDIS_SSH;
const REDIS_URL = process.env.DEVBELT_DB_TEST_REDIS_URL;

function parse(u: string): { host: string; port: number } {
  const url = new URL(u);
  return { host: url.hostname, port: Number(url.port || 6379) };
}

describe.skipIf(!SSH_RAW || !REDIS_URL)('Redis over SSH 隧道（真实）', () => {
  const storeFile = path.join(os.tmpdir(), `devbelt-ssh-${Date.now()}-known_hosts`);

  beforeAll(() => {
    SshTunnel.configureHostKeyGate({ policy: () => 'tofu', storeFile, prompt: async () => true });
  });
  afterAll(() => {
    SshTunnel.configureHostKeyGate(undefined);
  });

  it('建立隧道 → 经隧道路由 PING → 关闭回收', async () => {
    const ssh = JSON.parse(SSH_RAW!) as { host: string; port: number; user: string; password: string };
    const target = parse(REDIS_URL!);
    const conn = {
      id: 'ci-ssh-redis',
      name: 'ci-ssh',
      dbType: 'REDIS',
      host: target.host,
      port: target.port,
      sshHost: ssh.host,
      sshPort: ssh.port,
      sshUser: ssh.user,
      sshPassword: ssh.password,
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
