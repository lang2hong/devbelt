import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn(async () => undefined), showInformationMessage: vi.fn(async () => undefined) },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  env: { language: 'en' },
}));

import type { RedisConnectionSession } from '../../src/connection/connectionSession';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { executeRedisCommands } from '../../src/ai/redisExec';
import { AuditLogger } from '../../src/utils/auditLogger';

const conn = { id: 'r1', name: 'redis-a', host: 'localhost', dbType: 'REDIS', redisDb: 0 } as unknown as SavedConnection;

function fakeSession(opts: { isCluster?: boolean; db?: number; failWrites?: boolean } = {}): {
  session: RedisConnectionSession;
  calls: Array<[string, unknown[]]>;
} {
  const calls: Array<[string, unknown[]]> = [];
  const client = {
    isCluster: opts.isCluster ?? false,
    runExclusive: <T>(fn: () => Promise<T>) => fn(),
    sendCommand: vi.fn(async (name: string, args: unknown[]) => {
      calls.push([name, args]);
      if (opts.failWrites && ['SET', 'DEL'].includes(String(name).toUpperCase())) {
        throw new Error('READONLY You cannot write against a read only replica.');
      }
      return 'OK';
    }),
    sendCommandBuffer: vi.fn(async (name: string, args: unknown[]) => {
      calls.push([name, args]);
      return 'OK';
    }),
  };
  const session = {
    kind: 'redis',
    client,
    db: opts.db ?? 0,
    mode: 'standalone',
    readOnly: false,
    isAlive: () => true,
    close: () => {},
  } as unknown as RedisConnectionSession;
  return { session, calls };
}

describe('executeRedisCommands（AI 命令执行桥）', () => {
  it('只读命令：不弹确认、先 SELECT 目标库、结果原样回帖', async () => {
    const { session, calls } = fakeSession({ db: 0 });
    const confirm = vi.fn(async () => true);
    const result = await executeRedisCommands(conn, session, ['PING', 'GET user:1'], 3, { confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(String(calls[0][0]).toUpperCase()).toBe('SELECT');
    expect(calls[0][1]).toEqual([3]);
    expect(calls[1][0]).toBe('PING');
    expect(calls[2]).toEqual(['GET', ['user:1']]);
    expect(session.db).toBe(3);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('$ PING');
  });

  it('写命令：确认拒绝 → 一条都不执行；确认通过 → 执行并写审计', async () => {
    const tryLog = vi.spyOn(AuditLogger, 'tryLog');
    const { session, calls } = fakeSession();
    const declined = await executeRedisCommands(conn, session, ['SET user:1 a'], 0, { confirm: async () => false });
    expect(declined.isError).toBe(false);
    expect(calls.filter(([name]) => name === 'SET')).toHaveLength(0);
    expect(tryLog).not.toHaveBeenCalled();

    const accepted = await executeRedisCommands(conn, session, ['SET user:1 a', 'GET user:1'], 0, { confirm: async () => true });
    expect(calls.filter(([name]) => name === 'SET')).toHaveLength(1);
    expect(accepted.isError).toBe(false);
    expect(tryLog).toHaveBeenCalledTimes(1);
    expect(tryLog.mock.calls[0][0]).toMatchObject({ action: 'redis_command', database: '0' });
    tryLog.mockRestore();
  });

  it('SELECT/连接状态命令阻断（不执行、isError），其余命令照常', async () => {
    const { session, calls } = fakeSession();
    const result = await executeRedisCommands(conn, session, ['SELECT 2', 'CLIENT REPLY OFF', 'PING'], 0, { confirm: async () => true });
    expect(result.isError).toBe(true);
    expect(calls.filter(([name]) => name === 'PING')).toHaveLength(1);
    expect(calls.filter(([name]) => ['SELECT', 'CLIENT'].includes(name))).toHaveLength(0);
    expect(result.content).toContain('Blocked');
  });

  it('只读连接（客户端切面抛错）→ 该条报错、整体 isError，不中断后续只读命令', async () => {
    const { session, calls } = fakeSession({ failWrites: true });
    const result = await executeRedisCommands(conn, session, ['SET a 1', 'GET a'], 0, { confirm: async () => true });
    expect(result.isError).toBe(true);
    expect(calls.filter(([name]) => name === 'GET')).toHaveLength(1);
    expect(result.content).toContain('READONLY');
  });

  it('引号未闭合 → 解析失败直接返回；cluster 不 SELECT', async () => {
    const broken = await executeRedisCommands(conn, fakeSession().session, ['SET "unclosed'], 0, { confirm: async () => true });
    expect(broken.isError).toBe(true);
    expect(broken.content).toContain('Failed to parse');

    const { session, calls } = fakeSession({ isCluster: true });
    await executeRedisCommands(conn, session, ['PING'], 5, { confirm: async () => true });
    expect(calls.some(([name]) => name === 'SELECT')).toBe(false);
  });

  it('空输入 / 全注释 → 空结果报错', async () => {
    const result = await executeRedisCommands(conn, fakeSession().session, ['# c', '  '], 0, { confirm: async () => true });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No executable commands');
  });
});
