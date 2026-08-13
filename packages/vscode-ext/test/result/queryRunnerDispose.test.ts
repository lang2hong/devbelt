import { describe, expect, it, vi } from 'vitest';
import { QueryRunner } from '../../src/result/queryRunner';

vi.mock('vscode', () => ({ window: { showErrorMessage: () => {}, showWarningMessage: async () => 'Run SQL' } }));

const conn: any = { id: 'c1', database: 'test', dbType: 'MYSQL', host: 'h', name: 'n', readOnly: false, environment: 'development' };

/**
 * dispose 路径的连接泄漏回归测试。
 *
 * 曾用 `manager.connect()` 只为发一条 ROLLBACK。视图 onDispose 的顺序是
 * `runner.dispose()` → `manager.disposeConn()`，同步部分先释放会话，随后
 * microtask 里那个 connect 又建了一条无人持有的新连接（带 SSH 隧道一起漏），
 * 每关一个表预览面板泄漏一条。修复后只对已存在会话发 ROLLBACK。
 */
describe('QueryRunner.dispose 连接生命周期', () => {
  it('不调用 connect（避免在会话释放后重建连接）', async () => {
    const connect = vi.fn(async () => ({}));
    const manager: any = { connect, peek: () => undefined, disposeConn: () => {} };
    const runner = new QueryRunner(conn, manager, 'users', 'test', () => {});

    runner.dispose();
    await Promise.resolve();
    await Promise.resolve();

    expect(connect).not.toHaveBeenCalled();
  });

  it('已有会话时对其发送 ROLLBACK', () => {
    const query = vi.fn(async () => ({ rows: [], fields: [] }));
    const manager: any = {
      connect: vi.fn(async () => ({})),
      peek: () => ({ query: { query } }),
      disposeConn: () => {},
    };
    const runner = new QueryRunner(conn, manager, 'users', 'test', () => {});

    runner.dispose();

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it('无会话时静默跳过 ROLLBACK', () => {
    const manager: any = { connect: vi.fn(), peek: () => undefined, disposeConn: () => {} };
    const runner = new QueryRunner(conn, manager, 'users', 'test', () => {});
    expect(() => runner.dispose()).not.toThrow();
  });

  it('ROLLBACK 失败不抛出（best-effort）', async () => {
    const manager: any = {
      connect: vi.fn(),
      peek: () => ({ query: { query: async () => { throw new Error('gone'); } } }),
      disposeConn: () => {},
    };
    const runner = new QueryRunner(conn, manager, 'users', 'test', () => {});
    expect(() => runner.dispose()).not.toThrow();
    await Promise.resolve();
  });

  it('查询模式（无表）不发 ROLLBACK 也不 peek', () => {
    const peek = vi.fn();
    const manager: any = { connect: vi.fn(), peek, disposeConn: () => {} };
    const runner = new QueryRunner(conn, manager, undefined, 'test', () => {});
    runner.dispose();
    expect(peek).not.toHaveBeenCalled();
  });

  it('dispose 后 execute 不再触达数据库', async () => {
    const connect = vi.fn(async () => ({}));
    const manager: any = { connect, peek: () => undefined, disposeConn: () => {} };
    const posted: any[] = [];
    const runner = new QueryRunner(conn, manager, 'users', 'test', (m) => posted.push(m));

    runner.dispose();
    await runner.execute('SELECT 1');

    expect(connect).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });
});
