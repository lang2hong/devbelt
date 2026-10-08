import { describe, expect, it, vi } from 'vitest';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, append: () => {}, dispose: () => {} }),
    showErrorMessage: () => {},
    showWarningMessage: async () => undefined,
  },
}));

vi.mock('ssh2', () => ({
  Client: class { connect(): void { /* never reached in this test */ } },
}));

vi.mock('../../src/connection/sshHostKey', () => ({
  loadKnownHosts: () => ({ hosts: [], entries: [] }),
  isHostKeyTrusted: () => true,
  knownHostsHint: () => '',
  verifyHostKey: () => true,
}));

import { SshTunnel } from '../../src/connection/sshTunnel';

describe('SshTunnel.create 失败路径（H4/H1 回归）', () => {
  it('建隧道失败不产生未处理拒绝', async () => {
    const rejections: unknown[] = [];
    const handler = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', handler);
    try {
      const conn = {
        id: `ssh-fail-${Date.now()}`,
        name: 'n',
        dbType: 'PG',
        host: 'db.internal',
        port: 5432,
        user: 'u',
        database: 'app',
        sshHost: 'jump',
        sshPort: 22,
        sshUser: 'jumpuser',
        sshPassword: 'pw',
        // 指向不存在的私钥 → 读取即失败，且此时无并发等待者。
        sshPrivateKeyPath: '/nonexistent/devbelt-missing-key',
      } as unknown as SavedConnection;

      await expect(SshTunnel.create(conn)).rejects.toThrow(/not readable/);
      // 让微任务队列清空，任何晚到的未处理拒绝都会被上面 handler 捕获。
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });
});